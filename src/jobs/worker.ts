/**
 * Worker — the long-running process that executes jobs from the queue.
 *
 * WHY separated from the orchestrator:
 * The orchestrator is a thin job poster — `forge roadmap` writes job files
 * and exits instantly. The worker is the heavy process that actually spawns
 * agents, manages concurrency, enforces budgets, and monitors resources.
 *
 * Run with: `forge worker`
 * Stop with: Ctrl+C (graceful) or Ctrl+C twice (force)
 *
 * The worker:
 * 1. Recovers any stuck 'running' jobs from a previous crash
 * 2. Polls the job queue every few seconds
 * 3. Claims the next eligible job
 * 4. Executes it (spawning the appropriate agent)
 * 5. Marks it complete or failed
 * 6. Checks budget/resource constraints between jobs
 * 7. Repeats until no jobs remain or budget is exhausted
 */

import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import chalk from 'chalk';
import { loadAgents, type AgentRole, type AgentDefinition } from '../agents/index.js';
import { setGlobalEventLog, runAgent } from '../agents/runner.js';
import { loadSettings, type ForgeSettings } from '../config/index.js';
import { StateStore } from '../state/index.js';
import { EventLog } from '../events/index.js';
import { BudgetTracker } from '../budget/index.js';
import { ResourceMonitor } from '../monitor/index.js';
import { JobQueue } from './queue.js';
import type { Job, JobPhase } from './types.js';
import { runRoadmapStage } from '../workflow/stages/roadmap.js';
import { runPlanStage } from '../workflow/stages/plan.js';
import { runTestStage } from '../workflow/stages/test.js';
import { runDevelopStage } from '../workflow/stages/develop.js';
import { runPRStage } from '../workflow/stages/pr.js';
import { markForReview } from '../workflow/stages/review.js';
import { runReflectionStage } from '../workflow/stages/reflect.js';
import { scanOpenPRs, runPRReviewStage } from '../workflow/stages/review-prs.js';
import { STAGE_AGENT_MAP, type WorkItem } from '../workflow/types.js';

const POLL_INTERVAL_MS = 3_000;  // Check for new jobs every 3s
const IDLE_LOG_INTERVAL_MS = 60_000;  // Log "still waiting" every 60s when idle

/**
 * Maps job types to the resource slots they consume.
 * Jobs not listed here are "lightweight" and don't need slots.
 *
 * This is the single place to express "this job type is heavy because
 * it launches X". The worker checks slot availability before dispatch,
 * so 5 agents can run concurrently but at most N of them can be doing
 * expensive operations like running browsers or dev servers.
 */
const JOB_RESOURCE_SLOTS: Readonly<Record<string, readonly string[]>> = {
  'work-item':  ['build'],              // TDD cycle: compiles, runs tests
  'pr-fix':     ['build'],              // Fixes + test run
  'implement':  ['build'],              // Posts work-item sub-jobs (each acquires own slot)
};

export class Worker {
  private readonly settings: ForgeSettings;
  private readonly store: StateStore;
  private readonly eventLog: EventLog;
  private readonly budget: BudgetTracker;
  private readonly resources: ResourceMonitor;
  private readonly agents: Map<AgentRole, AgentDefinition>;
  private readonly queue: JobQueue;

  private _shutdownRequested = false;
  private _activeJobs = 0;
  private _processedCount = 0;
  /** Promises for all in-flight jobs — tracked so we can await them on shutdown. */
  private readonly _inflightJobs = new Set<Promise<void>>();

  constructor(workspaceRoot?: string) {
    this.settings = loadSettings(workspaceRoot);
    const forgeRoot = resolve(this.settings.workspaceRoot, '.forge');

    this.store = new StateStore(this.settings.workspaceRoot);
    this.eventLog = new EventLog(forgeRoot);
    this.budget = new BudgetTracker(forgeRoot, this.settings.budget);
    this.resources = new ResourceMonitor(this.settings.resourceThresholds);
    this.agents = loadAgents(this.settings);
    this.queue = new JobQueue(forgeRoot);

    // Migrate legacy work items
    const migrated = this.store.migrateLegacyWorkItems();
    if (migrated > 0) {
      console.log(chalk.dim(`  Migrated ${migrated} legacy work items to new layout.`));
    }

    setGlobalEventLog(this.eventLog);
    this.setupShutdownHandlers();
  }

  /**
   * Start the worker loop. Runs until:
   * - All jobs are processed and no more are queued
   * - Budget is exhausted
   * - SIGINT/SIGTERM received
   *
   * Processes up to `maxConcurrency` jobs in parallel. Each tick, the
   * worker fills empty slots from the queue. When a job finishes, its
   * slot opens for the next queued job on the following tick.
   *
   * @param keepAlive If true, don't exit when the queue is empty — wait for new jobs.
   */
  async start(keepAlive = false): Promise<void> {
    this.budget.resetRun();

    // Recover any stuck jobs from a previous crash
    const recovered = this.queue.recoverStuck();
    if (recovered > 0) {
      console.log(chalk.yellow(`  Recovered ${recovered} stuck job(s) from previous run.`));
    }

    // Prune old completed jobs and stale logs
    const pruned = this.queue.prune();
    const prunedLogs = this.eventLog.pruneLogs();
    if (pruned > 0 || prunedLogs > 0) {
      const parts = [];
      if (pruned > 0) parts.push(`${pruned} old job(s)`);
      if (prunedLogs > 0) parts.push(`${prunedLogs} old log(s)`);
      console.log(chalk.dim(`  Pruned ${parts.join(', ')}.`));
    }

    const maxConcurrency = this.settings.maxConcurrency;

    console.log(chalk.bold.blue('\n▶ Forge Worker started'));
    console.log(chalk.dim(`  Budget: ${this.budget.summary()}`));
    console.log(chalk.dim(`  ${this.resources.summary()}`));
    console.log(chalk.dim(`  Queue: ${this.queue.summaryString()}`));
    console.log(chalk.dim(`  Concurrency: ${maxConcurrency} parallel jobs`));
    console.log(chalk.dim(`  Mode: ${keepAlive ? 'daemon (keep-alive)' : 'drain (exit when empty)'}`));
    console.log();

    this.eventLog.emit({
      type: 'worker.start',
      summary: `Worker started (concurrency=${maxConcurrency}). Queue: ${this.queue.summaryString()}`,
    });

    let lastIdleLog = 0;

    while (!this._shutdownRequested) {
      // Budget gate
      if (!this.budget.canAfford()) {
        console.log(chalk.red(`\n  ⛔ Budget exhausted. ${this.budget.summary()}`));
        console.log(chalk.dim('     Start a new worker session to continue.\n'));
        break;
      }

      // Resource gate
      const health = this.resources.check();
      if (!health.healthy) {
        console.log(chalk.yellow(`  ⏳ System stressed (${health.reason}) — waiting...`));
        await this.resources.waitForHealth();
      }

      // Fill available concurrency slots
      let claimedAny = false;
      while (this._activeJobs < maxConcurrency && !this._shutdownRequested) {
        const job = this.queue.claim();
        if (!job) break;  // No more queued jobs

        // Check resource slot availability for heavyweight jobs.
        // If slots are full, unclaim and skip — it'll be retried next tick.
        const requiredSlots = JOB_RESOURCE_SLOTS[job.type] ?? [];
        const blocked = requiredSlots.find((s) => !this.resources.hasCapacity(s));
        if (blocked) {
          this.queue.unclaim(job.id);
          console.log(chalk.dim(`  ⏳ ${job.type} for ${job.project ?? '?'} waiting on "${blocked}" slot`));
          break; // Don't try more jobs this tick — slots won't free until a job finishes
        }

        // Acquire all required slots
        for (const slot of requiredSlots) {
          this.resources.acquire(slot, job.id);
        }

        claimedAny = true;

        // Launch the job without awaiting — it runs concurrently.
        // We track the promise so we can await all inflight on shutdown.
        const jobPromise = this.runJobAndTrack(job);
        this._inflightJobs.add(jobPromise);
        jobPromise.finally(() => this._inflightJobs.delete(jobPromise));

        // Stagger agent spawns slightly to avoid rate-limit bursts
        await this.sleep(300 + Math.random() * 700);
      }

      // If nothing is running and nothing was claimed
      if (this._activeJobs === 0 && !claimedAny) {
        if (!keepAlive) {
          if (this._processedCount > 0) {
            console.log(chalk.bold.green(`\n✓ All jobs processed (${this._processedCount} total)`));
            console.log(chalk.dim(`  ${this.budget.summary()}\n`));
          } else {
            console.log(chalk.dim('  No jobs in queue. Nothing to do.\n'));
          }
          break;
        }

        // Keep-alive: log idle status periodically
        const now = Date.now();
        if (now - lastIdleLog > IDLE_LOG_INTERVAL_MS) {
          console.log(chalk.dim(`  [${new Date().toLocaleTimeString()}] Waiting for jobs... (${this.queue.summaryString()})`));
          lastIdleLog = now;
        }
      }

      // Poll interval — check for new jobs or finished slots
      await this.sleep(POLL_INTERVAL_MS);
    }

    // Wait for any in-flight jobs to finish before exiting
    if (this._inflightJobs.size > 0) {
      console.log(chalk.dim(`  Waiting for ${this._inflightJobs.size} in-flight job(s) to finish...`));
      await Promise.allSettled([...this._inflightJobs]);
    }

    this.eventLog.emit({
      type: 'worker.stop',
      summary: `Worker stopped. Processed: ${this._processedCount}. ${this.budget.summary()}`,
    });
  }

  /**
   * Execute a job, incrementing/decrementing active count and processed count.
   * This runs as a detached promise — the main loop doesn't await it.
   */
  private async runJobAndTrack(job: Job): Promise<void> {
    try {
      await this.executeJob(job);
    } finally {
      this._processedCount++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Execution
  // ═══════════════════════════════════════════════════════════════════

  private async executeJob(job: Job): Promise<void> {
    this._activeJobs++;
    const startTime = Date.now();

    this.eventLog.emit({
      type: 'job.start',
      project: job.project ?? undefined,
      summary: `Starting job: ${job.type}${job.project ? ` for ${job.project}` : ''}`,
    });

    try {
      switch (job.type) {
        case 'roadmap':
          await this.executeRoadmapJob(job);
          break;
        case 'plan':
          await this.executePlanJob(job);
          break;
        case 'implement':
          await this.executeImplementJob(job);
          break;
        case 'reflect':
          await this.executeReflectJob(job);
          break;
        case 'review':
          await this.executeReviewJob(job);
          break;
        case 'pr-fix':
          await this.executePrFixJob(job);
          break;
        case 'work-item':
          await this.executeWorkItemJob(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      this.queue.complete(job.id);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      this.eventLog.emit({
        type: 'job.complete',
        project: job.project ?? undefined,
        summary: `Job complete: ${job.type}${job.project ? ` for ${job.project}` : ''} (${elapsed}s)`,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.queue.fail(job.id, msg);

      this.eventLog.emit({
        type: 'job.failed',
        project: job.project ?? undefined,
        summary: `Job failed: ${job.type}${job.project ? ` for ${job.project}` : ''}: ${msg}`,
      });
    } finally {
      this._activeJobs--;
      // Release any resource slots held by this job
      this.resources.releaseAll(job.id);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Type Executors
  // ═══════════════════════════════════════════════════════════════════

  private async executeRoadmapJob(job: Job): Promise<void> {
    const project = this.requireProject(job);
    const projectPath = resolve(this.settings.workspaceRoot, project);
    const architect = this.requireAgent('architect');
    const userDirection = job.metadata.userDirection as string | undefined;

    const { roadmap } = await runRoadmapStage(
      architect,
      project,
      projectPath,
      this.store,
      userDirection,
    );
    await this.recordAgentCost();

    this.eventLog.emit({
      type: 'roadmap.created',
      project,
      summary: `Roadmap: ${project} — ${roadmap.milestones.length} milestones`,
    });
  }

  private async executePlanJob(job: Job): Promise<void> {
    const project = this.requireProject(job);
    const projectPath = resolve(this.settings.workspaceRoot, project);
    const planner = this.requireAgent('planner');

    const roadmap = this.store.getRoadmap(project);
    const brief = this.store.getDesignBrief(project);

    if (!roadmap && !brief) {
      throw new Error(`No roadmap or design brief for ${project} — run "forge roadmap ${project}" first`);
    }

    await runPlanStage(
      planner,
      roadmap ?? brief!,
      projectPath,
      this.store,
    );
    await this.recordAgentCost();
  }

  private async executeImplementJob(job: Job): Promise<void> {
    const project = this.requireProject(job);
    const allItems = this.store.getWorkItemsByProject(project);
    const actionable = allItems.filter(
      (item) => item.status === 'pending' || item.status === 'in-progress' || item.status === 'failed',
    );

    if (actionable.length === 0) return;

    // Rather than running all items inline, post individual work-item jobs
    // so each one can be independently scheduled and parallelized by the worker.
    let posted = 0;
    for (const item of actionable) {
      // Reset stuck items
      if (item.status === 'in-progress' || item.status === 'failed') {
        item.status = 'pending';
        this.store.saveWorkItem(item);
      }

      this.queue.post('work-item', 'implementation', project, {
        workItemId: item.id,
      });
      posted++;
    }
  }


  private async executeReviewJob(job: Job): Promise<void> {
    const prReviewer = this.requireAgent('pr-reviewer');
    const prNumber = job.metadata.prNumber as number | undefined;
    const repo = job.metadata.repo as string | undefined;
    const project = job.metadata.project as string | undefined;

    // Single PR review (posted per-PR by forge review command)
    if (prNumber && repo && project) {
      // SHA-change guard: skip review if remote HEAD hasn't changed since last review.
      // This prevents infinite loops where the fixer fails to push and the reviewer
      // keeps posting identical "changes requested" comments.
      const lastReviewedSha = job.metadata.lastReviewedSha as string | undefined;
      let currentRemoteSha = '';
      try {

        currentRemoteSha = execSync(
          `gh api repos/${repo}/pulls/${prNumber} --jq .head.sha`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
      } catch { /* if we can't check, proceed with review */ }

      if (lastReviewedSha && currentRemoteSha && lastReviewedSha === currentRemoteSha) {
        console.log(chalk.yellow(`  PR #${prNumber}: remote HEAD unchanged (${currentRemoteSha.slice(0, 7)}) — skipping review`));
        this.eventLog.emit({
          type: 'review.complete',
          project,
          summary: `PR #${prNumber} skipped: remote HEAD unchanged since last review`,
        });
        return;
      }

      // Also check if PR is still open — skip if already merged or closed
      try {

        const state = execSync(
          `gh pr view ${prNumber} --repo ${repo} --json state --jq .state`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (state === 'MERGED' || state === 'CLOSED') {
          console.log(chalk.dim(`  PR #${prNumber}: already ${state.toLowerCase()} — skipping review`));
          return;
        }
      } catch { /* proceed if we can't check */ }

      const pr = {
        number:        prNumber,
        title:         job.metadata.prTitle as string ?? `PR #${prNumber}`,
        url:           job.metadata.prUrl as string ?? `https://github.com/${repo}/pull/${prNumber}`,
        branch:        job.metadata.branch as string ?? '',
        repo,
        project,
        createdAt:     job.metadata.prCreatedAt as string ?? job.createdAt,
        mergeLayer:    (job.metadata.mergeLayer as number | undefined) ?? 0,
        dependsOnPRs:  (job.metadata.dependsOnPRs as number[] | undefined) ?? [],
        blocksPRs:     (job.metadata.blocksPRs as number[] | undefined) ?? [],
        uniqueHeadSha: (job.metadata.uniqueHeadSha as string | undefined) ?? '',
      };

      const result = await runPRReviewStage(prReviewer, pr, this.settings.workspaceRoot);
      await this.recordAgentCost();

      this.eventLog.emit({
        type: 'review.complete',
        project,
        summary: `PR #${prNumber} reviewed: ${result.output.slice(0, 120)}`,
      });

      // Parse the agent's output to decide the next step in the bounce cycle.
      // "REVIEW POSTED: changes-requested" → post pr-fix job (capped at MAX_FIX_ROUNDS)
      // "REVIEW POSTED: approved" → reviewer agent handles merge; nothing more to queue
      // "REVIEW DEFERRED" → will be re-queued on next `forge review` run
      // "FAILED" / other → no follow-up
      const MAX_FIX_ROUNDS = 3;
      const output = result.output;
      const currentRound = (job.metadata.fixRound as number | undefined) ?? 0;

      if (/REVIEW POSTED:\s*changes-requested/i.test(output)) {
        const nextRound = currentRound + 1;
        if (nextRound > MAX_FIX_ROUNDS) {
          console.log(chalk.yellow(`  PR #${prNumber} hit max fix rounds (${MAX_FIX_ROUNDS}). Escalating to human.`));
          this.eventLog.emit({
            type: 'review.complete',
            project,
            summary: `PR #${prNumber} exceeded ${MAX_FIX_ROUNDS} fix rounds — needs human attention`,
          });
        } else {
          this.queue.post('pr-fix', 'pr-fix' as JobPhase, project, {
            ...job.metadata,
            fixRound: nextRound,
            lastReviewedSha: currentRemoteSha || undefined,
          }, 12);
        }
      }
      return;
    }

    // Bulk scan — scan all projects for open PRs and post individual review jobs
    const openPRs = scanOpenPRs(this.settings.projects, this.settings.workspaceRoot);
    if (openPRs.length === 0) {
      this.eventLog.emit({ type: 'review.scan', summary: 'No open PRs found across managed projects' });
      return;
    }

    // Post one review job per PR; priority = 5 + mergeLayer so foundation PRs run first
    for (const pr of openPRs) {
      this.queue.post('review', 'review' as JobPhase, pr.project, {
        prNumber:      pr.number,
        prTitle:       pr.title,
        prUrl:         pr.url,
        branch:        pr.branch,
        repo:          pr.repo,
        project:       pr.project,
        prCreatedAt:   pr.createdAt,
        mergeLayer:    pr.mergeLayer,
        dependsOnPRs:  pr.dependsOnPRs,
        blocksPRs:     pr.blocksPRs,
        uniqueHeadSha: pr.uniqueHeadSha,
      }, 5 + pr.mergeLayer);
    }

    this.eventLog.emit({
      type: 'review.scan',
      summary: `Scanned repos: found ${openPRs.length} open PR(s) across ${this.settings.projects.length} projects`,
    });
  }

  private async executePrFixJob(job: Job): Promise<void> {
    const developer = this.requireAgent('developer');
    const prNumber = job.metadata.prNumber as number | undefined;
    const repo = job.metadata.repo as string | undefined;
    const project = job.metadata.project as string | undefined;

    if (!prNumber || !repo || !project) {
      throw new Error('pr-fix job missing prNumber, repo, or project in metadata');
    }

    const branch = job.metadata.branch as string ?? '';
    const fixRound = (job.metadata.fixRound as number | undefined) ?? 1;
    const projectPath = resolve(this.settings.workspaceRoot, project);

    // Use a temporary git worktree so we don't pollute the main checkout.
    // This prevents the dirty-state problem where one fixer's uncommitted
    // changes block another fixer from checking out a different branch.
    const worktreeDir = resolve(this.settings.workspaceRoot, `.forge/worktrees/pr-${prNumber}-fix-${fixRound}`);
    let useWorktree = false;

    try {
      // Clean up any stale worktree from a previous crash
      try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      mkdirSync(resolve(this.settings.workspaceRoot, '.forge/worktrees'), { recursive: true });

      execSync(`git worktree add "${worktreeDir}" "origin/${branch}" --detach`, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Checkout the actual branch (not detached)
      execSync(`git checkout "${branch}"`, {
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      useWorktree = true;
    } catch (err) {
      console.log(chalk.yellow(`  Worktree creation failed for PR #${prNumber}, falling back to main checkout`));
    }

    const fixCwd = useWorktree ? worktreeDir : projectPath;

    const prompt = `You are fixing PR #${prNumber} in ${repo} (fix round ${fixRound}).

## PR Details
- Branch: ${branch}
- Repo: ${repo}
- Project: ${project}
- Fix round: ${fixRound}

## Your Task

1. Read the latest review comments on this PR:
   \`gh api repos/${repo}/issues/${prNumber}/comments --jq '.[-3:] | .[] | {user: .user.login, body: .body[:500]}'\`

2. Understand what was flagged as a blocker or concern.

3. Fix ONLY what was requested — do not refactor or add features.

4. Run the project's test suite to verify nothing breaks.

5. Commit and push:
   \`\`\`bash
   git add <changed files>
   git commit -m "fix: address reviewer feedback on PR #${prNumber}

   - <specific fix 1>
   - <specific fix 2>

   Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
   git push origin ${branch}
   \`\`\`

6. VERIFY the push landed (MANDATORY):
   \`\`\`bash
   LOCAL_SHA=$(git rev-parse HEAD)
   REMOTE_SHA=$(gh api repos/${repo}/pulls/${prNumber} --jq .head.sha)
   echo "Local:  $LOCAL_SHA"
   echo "Remote: $REMOTE_SHA"
   \`\`\`
   If they don't match, retry the push once more.

## Output

Your final line MUST be one of:
- \`FIX PUSHED: <N> issue(s) addressed on PR #${prNumber} — ${branch} pushed\`
- \`FIX BLOCKED: tests failing after fix on PR #${prNumber} — <reason>\`
- \`FIX SKIPPED: no blockers in review for PR #${prNumber}\`
- \`FAILED: <reason>\``;

    const result = await runAgent({
      agent: developer,
      prompt,
      cwd: fixCwd,
      maxTurns: 25,
    });
    await this.recordAgentCost();

    // Clean up worktree
    if (useWorktree) {
      try {
        execSync(`git worktree remove "${worktreeDir}" --force`, {
          cwd: projectPath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      } catch { /* worktree cleanup is best-effort */ }
    }

    this.eventLog.emit({
      type: 'pr-fix.complete',
      project,
      summary: `PR #${prNumber} fix round ${fixRound}: ${result.output.slice(0, 120)}`,
    });

    // After a fix, check if the remote HEAD actually changed before posting re-review.
    // If the fixer didn't manage to push, skip re-review to prevent infinite loops.
    const lastReviewedSha = job.metadata.lastReviewedSha as string | undefined;
    let currentRemoteSha = '';
    try {
      currentRemoteSha = execSync(
        `gh api repos/${repo}/pulls/${prNumber} --jq .head.sha`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
    } catch { /* if we can't check, assume changed */ }

    const pushLanded = !currentRemoteSha || !lastReviewedSha || currentRemoteSha !== lastReviewedSha;
    const fixSucceeded = !/FAILED|FIX BLOCKED|ESCALATE/i.test(result.output);

    if (fixSucceeded && pushLanded) {
      this.queue.post('review', 'review' as JobPhase, project, {
        ...job.metadata,
        fixRound,
        lastReviewedSha: currentRemoteSha || lastReviewedSha,
      }, 9);
    } else if (!pushLanded) {
      console.log(chalk.yellow(`  PR #${prNumber} fix round ${fixRound}: remote SHA unchanged — skipping re-review`));
      this.eventLog.emit({
        type: 'pr-fix.complete',
        project,
        summary: `PR #${prNumber} fix round ${fixRound}: push did not land, no re-review posted`,
      });
    }
  }

  private async executeWorkItemJob(job: Job): Promise<void> {
    const workItemId = job.metadata.workItemId as string;
    if (!workItemId) throw new Error('work-item job missing workItemId in metadata');

    const workItem = this.store.getWorkItem(workItemId);
    if (!workItem) throw new Error(`Work item not found: ${workItemId}`);

    // Check dependencies before executing
    const deps = workItem.dependsOn ?? [];
    if (deps.length > 0) {
      const allItems = this.store.getWorkItemsByProject(workItem.project);
      const completedIds = new Set(allItems.filter((i) => i.status === 'completed').map((i) => i.id));
      const unmet = deps.filter((dep) => !completedIds.has(dep));
      if (unmet.length > 0) {
        // Re-queue with a small delay (higher priority number = later)
        this.queue.post('work-item', 'implementation', workItem.project, {
          workItemId,
        }, (job.priority ?? 35) + 1);
        return;
      }
    }

    const projectPath = resolve(this.settings.workspaceRoot, workItem.project);
    await this.runWorkItemPipeline(workItem, projectPath);
  }

  private async executeReflectJob(_job: Job): Promise<void> {
    const reflector = this.requireAgent('reflector');

    const { report } = await runReflectionStage(
      reflector,
      this.store,
      this.eventLog,
      this.settings.workspaceRoot,
    );
    await this.recordAgentCost();

    const firstLine = report.split('\n')[0] ?? 'Reflection complete';
    this.eventLog.emit({
      type: 'reflection.complete',
      summary: firstLine,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Work Item Pipeline (moved from orchestrator)
  // ═══════════════════════════════════════════════════════════════════

  private async runWorkItemPipeline(workItem: WorkItem, projectPath: string): Promise<void> {

    try {
      // Test stage
      if (workItem.stage === 'test' && workItem.status === 'pending') {
        const testAgent = this.requireAgent(STAGE_AGENT_MAP.test);
        workItem.status = 'in-progress';
        this.store.saveWorkItem(workItem);

        await runTestStage(testAgent, workItem, projectPath, this.store);
        await this.recordAgentCost();

        if ((workItem.status as string) === 'failed') return;
      }

      // Develop stage
      if (workItem.stage === 'develop' && workItem.status === 'pending') {
        const devAgent = this.requireAgent(STAGE_AGENT_MAP.develop);
        workItem.status = 'in-progress';
        this.store.saveWorkItem(workItem);

        await runDevelopStage(devAgent, workItem, projectPath, this.store);
        await this.recordAgentCost();

        const currentStatus = workItem.status as string;
        if (currentStatus === 'blocked' || currentStatus === 'failed') return;
      }

      // PR stage
      if (workItem.stage === 'pr' && workItem.status === 'pending') {
        const prAgent = this.requireAgent(STAGE_AGENT_MAP.pr);
        workItem.status = 'in-progress';
        this.store.saveWorkItem(workItem);

        await runPRStage(prAgent, workItem, projectPath, this.store);
        await this.recordAgentCost();
      }

      // Review stage
      if (workItem.stage === 'review') {
        markForReview(workItem, this.store);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      workItem.status = 'failed';
      workItem.blockReason = msg;
      this.store.saveWorkItem(workItem);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: Budget & Resource Management
  // ═══════════════════════════════════════════════════════════════════

  private async recordAgentCost(): Promise<void> {
    const events = this.eventLog.recent(5);
    for (const event of events.reverse()) {
      if (event.type === 'agent.cost' && event.data?.totalCostUsd) {
        const cost = event.data.totalCostUsd as number;
        const result = this.budget.recordCost(cost);

        if (!result.allowed) {
          console.log(chalk.red(`\n  ⛔ Budget limit reached. $${result.remaining.toFixed(2)} remaining.`));
          this._shutdownRequested = true;
        }
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: Helpers
  // ═══════════════════════════════════════════════════════════════════

  private requireAgent(role: AgentRole): AgentDefinition {
    const agent = this.agents.get(role);
    if (!agent) throw new Error(`Agent not found: ${role}`);
    return agent;
  }

  private requireProject(job: Job): string {
    if (!job.project) throw new Error(`Job ${job.id} (${job.type}) has no project`);
    return job.project;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private setupShutdownHandlers(): void {
    let signalCount = 0;

    const handler = (signal: string) => {
      signalCount++;

      if (signalCount === 1) {
        console.log(chalk.yellow(`\n\n  ⚠ ${signal} — shutting down worker gracefully...`));
        console.log(chalk.dim(`    ${this.budget.summary()}`));
        console.log(chalk.dim(`    Jobs processed: ${this._processedCount} | Active: ${this._activeJobs}`));
        console.log(chalk.dim('    Finishing current job, then stopping...\n'));

        this._shutdownRequested = true;
        this.eventLog.emit({
          type: 'worker.shutdown',
          summary: `Worker shutdown by ${signal}. Processed: ${this._processedCount}. ${this.budget.summary()}`,
        });
      } else {
        console.log(chalk.red('\n  Force exit.'));
        process.exit(1);
      }
    };

    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  }
}
