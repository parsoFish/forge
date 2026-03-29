/**
 * Implement session orchestrator — the unified /implement pipeline.
 *
 * WHY unified:
 * Previously: /plan → /worker on → /implement → manual tracking → confusion.
 * Now: /implement does everything — plan if needed, queue work items by
 * dependency layer, auto-enable the worker, track progress, and recover
 * from crashes.
 *
 * This module orchestrates the session flow but doesn't execute agents
 * directly — it posts jobs to the queue and monitors their completion.
 */

import chalk from 'chalk';
import type { StateStore } from '../../state/store.js';
import {
  ImplementSessionStore,
  type ImplementSession,
} from '../../state/implement-session.js';
import { GitWorkflow } from '../../git/workflow.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { EventLog } from '../../events/event-log.js';

export interface ImplementSessionIO {
  /** Ask a yes/no question. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Print text to the user. */
  readonly print: (text: string) => void;
}

export interface ImplementSessionDeps {
  readonly store: StateStore;
  readonly sessionStore: ImplementSessionStore;
  readonly queue: JobQueue;
  readonly eventLog: EventLog;
  readonly enableWorker: () => void;
}

/**
 * Run the unified implement pipeline for a project.
 *
 * Flow:
 * 1. Check for incomplete sessions → offer to resume
 * 2. Verify roadmap exists → require if missing
 * 3. Plan phase (if not done) → post plan job, wait
 * 4. Implement phase → post work-item jobs by dependency layer
 * 5. Auto-enable worker
 *
 * Returns the session (still in-progress — worker handles execution).
 */
export async function startImplementSession(
  project: string,
  deps: ImplementSessionDeps,
  io: ImplementSessionIO,
): Promise<ImplementSession | null> {
  const { store, sessionStore, eventLog, enableWorker } = deps;

  // ── Check for incomplete session ────────────────────────────────
  const existing = sessionStore.findIncomplete(project);
  if (existing) {
    const age = timeSince(existing.updatedAt);
    const progress = existing.workItemsCompleted.length;
    const total = existing.workItemsCreated.length;
    const phaseLabel = existing.phase;

    io.print(chalk.yellow(`\n  Found incomplete session from ${age} ago`));
    io.print(chalk.dim(`  Phase: ${phaseLabel} | Progress: ${progress}/${total} items done`));

    if (existing.crashLog) {
      io.print(chalk.dim(`  Crash log: ${existing.crashLog.slice(0, 200)}`));
    }

    const answer = await io.ask(chalk.blue('  Resume this session? [Y/n]: '));
    if (answer.trim().toLowerCase() === 'n') {
      // User wants a fresh start — mark old session complete
      sessionStore.complete(existing);
      io.print(chalk.dim('  Previous session archived.'));
    } else {
      // Resume from where we left off
      io.print(chalk.green('  Resuming session...'));
      return resumeSession(existing, deps, io);
    }
  }

  // ── Verify roadmap exists ───────────────────────────────────────
  const roadmap = store.getRoadmap(project);
  const brief = store.getDesignBrief(project);
  if (!roadmap && !brief) {
    io.print(chalk.red(`\n  No roadmap found for ${project}.`));
    io.print(chalk.dim('  Run /roadmap first to set direction.\n'));
    return null;
  }

  // ── Create new session ──────────────────────────────────────────
  const session = sessionStore.create(project);

  io.print(chalk.bold.blue(`\n  Implement Session: ${project}`));
  io.print(chalk.dim(`  Session ID: ${session.id}\n`));

  eventLog.emit({
    type: 'session.start',
    summary: `Implement session started for ${project} (${session.id})`,
  });

  // ── Planning phase ──────────────────────────────────────────────
  await runPlanningPhase(session, deps, io);

  // ── Implementation phase ────────────────────────────────────────
  await startImplementationPhase(session, deps, io);

  // ── Auto-enable worker ──────────────────────────────────────────
  enableWorker();
  io.print(chalk.green('  Worker enabled — processing jobs.\n'));

  return session;
}

/**
 * Resume an incomplete session from its last known phase.
 */
async function resumeSession(
  session: ImplementSession,
  deps: ImplementSessionDeps,
  io: ImplementSessionIO,
): Promise<ImplementSession> {
  const { eventLog, enableWorker } = deps;

  eventLog.emit({
    type: 'session.resume',
    summary: `Resumed implement session ${session.id} from phase: ${session.phase}`,
  });

  switch (session.phase) {
    case 'planning':
      await runPlanningPhase(session, deps, io);
      await startImplementationPhase(session, deps, io);
      break;

    case 'implementing':
      // Plan already done — just re-queue incomplete work items
      io.print(chalk.dim('  Plan phase already complete — resuming implementation.'));
      await startImplementationPhase(session, deps, io);
      break;

    case 'completed':
      io.print(chalk.dim('  Session already completed. Run /review to triage PRs.'));
      break;
  }

  enableWorker();
  io.print(chalk.green('  Worker enabled — processing jobs.\n'));

  return session;
}

/**
 * Post a plan job and wait for it to complete.
 *
 * The plan job creates work items — once done, we can queue implementation.
 */
async function runPlanningPhase(
  session: ImplementSession,
  deps: ImplementSessionDeps,
  io: ImplementSessionIO,
): Promise<void> {
  const { store, sessionStore, queue } = deps;

  if (session.planCompleted) {
    io.print(chalk.dim('  Plan phase already complete — skipping.'));
    return;
  }

  io.print(chalk.bold('  Phase 1: Planning\n'));

  // Check if work items already exist (from a previous partial plan)
  const existingItems = store.getWorkItemsByProject(session.project);
  const actionable = existingItems.filter(
    i => i.status === 'pending' || i.status === 'in-progress' || i.status === 'failed',
  );

  if (actionable.length > 0) {
    io.print(chalk.dim(`  Found ${actionable.length} existing work items — skipping plan.`));
    const updated: ImplementSession = {
      ...session,
      planCompleted: true,
      phase: 'implementing',
      workItemsCreated: actionable.map(i => i.id),
    };
    Object.assign(session, updated);
    sessionStore.save(session);
    return;
  }

  // Post plan job
  const planJob = queue.post('plan', 'implementation', session.project, {
    sessionId: session.id,
  }, 30);

  io.print(chalk.dim(`  Queued plan job: ${planJob.id}`));
  io.print(chalk.dim('  Worker will execute planning — work items will be created.\n'));

  // Note: we don't block here waiting for plan completion.
  // The worker will process the plan job, which creates work items.
  // The implement job (posted next) checks for work items and creates
  // sub-jobs from them. If plan hasn't run yet, implement will defer.
  //
  // This is intentionally non-blocking so the user gets control back quickly.
}

/**
 * Queue implementation work by dependency layer.
 *
 * Uses topological sort to group work items into layers. Layer 0 items
 * are queued immediately; higher layers are queued by the worker as
 * dependencies complete.
 */
async function startImplementationPhase(
  session: ImplementSession,
  deps: ImplementSessionDeps,
  io: ImplementSessionIO,
): Promise<void> {
  const { store, sessionStore, queue } = deps;

  const updated: ImplementSession = {
    ...session,
    phase: 'implementing',
  };
  Object.assign(session, updated);
  sessionStore.save(session);

  // Post the implement job — the worker's executeImplementJob will:
  // 1. Load work items for the project
  // 2. Use GitWorkflow.dependencyLayers() for ordering
  // 3. Post work-item sub-jobs respecting dependencies
  const implJob = queue.post('implement', 'implementation', session.project, {
    sessionId: session.id,
  }, 40);

  io.print(chalk.bold('  Phase 2: Implementation\n'));
  io.print(chalk.dim(`  Queued implement job: ${implJob.id}`));

  // Summarize dependency layers if work items exist
  const items = store.getWorkItemsByProject(session.project)
    .filter(i => i.status === 'pending' || i.status === 'in-progress' || i.status === 'failed');

  if (items.length > 0) {
    const layers = GitWorkflow.dependencyLayers(items);
    io.print(chalk.dim(`  ${items.length} work items in ${layers.length} dependency layer(s):`));
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      io.print(chalk.dim(`    Layer ${i}: ${layer.map(w => w.title).join(', ')}`));
    }
    io.print('');

    // Update session with work item IDs
    const allIds = items.map(i => i.id);
    const completedIds = store.getWorkItemsByProject(session.project)
      .filter(i => i.status === 'completed')
      .map(i => i.id);

    const sessionUpdate: ImplementSession = {
      ...session,
      workItemsCreated: allIds,
      workItemsCompleted: completedIds,
    };
    Object.assign(session, sessionUpdate);
    sessionStore.save(session);
  } else {
    io.print(chalk.dim('  No work items yet — plan job will create them.'));
    io.print(chalk.dim('  Implement job will re-check after plan completes.\n'));
  }
}

/** Format a time duration as a human-readable string. */
function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
