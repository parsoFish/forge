/**
 * Orchestrator — a thin coordination layer that posts jobs and exits.
 *
 * WHY this is thin:
 * The orchestrator is a job poster, not a job executor. Commands like
 * `forge roadmap` or `forge implement` write job files to `.forge/jobs/`
 * and return immediately. A separate long-running worker (`forge worker`)
 * picks up and executes those jobs within concurrency/budget constraints.
 *
 * This decoupling means:
 * - CLI commands are always fast (no blocking on agent runs)
 * - Parallelism is controlled by the worker, not the command issuer
 * - Crashes don't lose work — jobs are persisted on disk
 * - Multiple jobs can be queued while the worker processes them at its pace
 */

import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadAgents, type AgentRole, type AgentDefinition } from './agents/index.js';
import { loadSettings, resolveProjectPath, type ForgeSettings } from './config/index.js';
import type { Roadmap } from './workflow/types.js';
import type { RoadmapSessionIO } from './workflow/stages/interactive-roadmap.js';
import type { ReviewSessionIO } from './workflow/stages/interactive-review.js';
import type { ReflectSessionIO } from './workflow/stages/interactive-reflect.js';
import { StateStore } from './state/index.js';
import { EventLog } from './events/index.js';
import { BudgetTracker } from './budget/index.js';
import { ResourceMonitor, DEFAULT_THRESHOLDS } from './monitor/index.js';
import { JobQueue } from './jobs/index.js';
import type { OrchestratorPhase } from './workflow/types.js';

export class Orchestrator {
  private readonly settings: ForgeSettings;
  private readonly store: StateStore;
  private readonly eventLog: EventLog;
  private readonly budget: BudgetTracker;
  private readonly resources: ResourceMonitor;
  private readonly queue: JobQueue;
  private readonly agents: Map<AgentRole, AgentDefinition>;

  constructor(workspaceRoot?: string) {
    this.settings = loadSettings(workspaceRoot);
    const forgeRoot = resolve(this.settings.workspaceRoot, '.forge');

    this.store = new StateStore(this.settings.workspaceRoot);
    this.eventLog = new EventLog(forgeRoot);
    this.budget = new BudgetTracker(forgeRoot, this.settings.costTracking);
    this.resources = new ResourceMonitor({
      ...DEFAULT_THRESHOLDS,
      resourceSlots: this.settings.resourceSlots,
    });
    this.queue = new JobQueue(forgeRoot);
    this.agents = loadAgents(this.settings);

    // Migrate legacy work items on first run
    const migrated = this.store.migrateLegacyWorkItems();
    if (migrated > 0) {
      console.log(chalk.dim(`  Migrated ${migrated} legacy work items to new layout.`));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase Management
  // ═══════════════════════════════════════════════════════════════════

  /** Get the current orchestrator phase. */
  getCurrentPhase(): OrchestratorPhase {
    return this.store.getPhase().currentPhase;
  }

  /** Switch to a specific phase. */
  setPhase(phase: OrchestratorPhase, notes = ''): void {
    const prev = this.store.getPhase();
    this.store.setPhase(phase, notes);
    this.eventLog.emit({
      type: 'phase.enter',
      summary: `Phase changed: ${prev.currentPhase} → ${phase}${notes ? ` (${notes})` : ''}`,
    });
    console.log(chalk.bold.blue(`\n  Phase: ${prev.currentPhase} → ${phase}`));
    if (notes) console.log(chalk.dim(`  Notes: ${notes}`));
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job-Posting Commands (all non-blocking)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Queue roadmapping jobs for one or all projects.
   * Returns immediately — use `forge worker` to execute.
   */
  async roadmap(projectName?: string, userDirection?: string): Promise<void> {
    const projects = projectName
      ? [this.validateAndReturn(projectName)]
      : [...this.settings.projects];

    const jobs = this.queue.postForProjects('roadmap', 'roadmapping', projects, { userDirection });

    console.log(chalk.bold.blue(`\n▶ Roadmapping: queued ${jobs.length} job(s)`));
    for (const j of jobs) {
      console.log(chalk.dim(`    ${j.id}: ${j.project}`));
    }
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} roadmap job(s): ${projects.join(', ')}`,
    });
  }

  /**
   * Queue planning jobs for one or all projects.
   * Returns immediately — use `forge worker` to execute.
   */
  async plan(projectName?: string): Promise<void> {
    const projects = projectName
      ? [this.validateAndReturn(projectName)]
      : [...this.settings.projects];

    // Validate that projects have roadmaps or briefs
    const valid: string[] = [];
    for (const project of projects) {
      const roadmap = this.store.getRoadmap(project);
      const brief = this.store.getDesignBrief(project);
      if (!roadmap && !brief) {
        console.log(chalk.yellow(`  ⚠ No roadmap or brief for ${project} — skipping (run "forge roadmap ${project}" first)`));
        continue;
      }
      valid.push(project);
    }

    if (valid.length === 0) {
      console.log(chalk.yellow('\n  No projects ready for planning.\n'));
      return;
    }

    const jobs = this.queue.postForProjects('plan', 'implementation', valid, {});

    console.log(chalk.bold.blue(`\n▶ Planning: queued ${jobs.length} job(s)`));
    for (const j of jobs) {
      console.log(chalk.dim(`    ${j.id}: ${j.project}`));
    }
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} plan job(s): ${valid.join(', ')}`,
    });
  }

  /**
   * Queue implementation jobs for one or all projects.
   * Returns immediately — the worker will generate individual work-item
   * jobs when it processes these.
   */
  async implement(projectName?: string): Promise<void> {
    const projects = projectName
      ? [this.validateAndReturn(projectName)]
      : [...this.settings.projects];

    // Validate that projects have work items
    const valid: string[] = [];
    for (const project of projects) {
      const items = this.store.getWorkItemsByProject(project);
      const actionable = items.filter(
        (i) => i.status === 'pending' || i.status === 'in-progress' || i.status === 'failed',
      );
      if (actionable.length === 0) {
        console.log(chalk.dim(`  No actionable work items for ${project}`));
        continue;
      }
      valid.push(project);
      console.log(chalk.dim(`  ${project}: ${actionable.length} actionable items`));
    }

    if (valid.length === 0) {
      console.log(chalk.yellow('\n  No projects with actionable work items.\n'));
      return;
    }

    const jobs = this.queue.postForProjects('implement', 'implementation', valid, {});

    console.log(chalk.bold.blue(`\n▶ Implementation: queued ${jobs.length} job(s)`));
    for (const j of jobs) {
      console.log(chalk.dim(`    ${j.id}: ${j.project}`));
    }
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} implement job(s): ${valid.join(', ')}`,
    });
  }


  /**
   * Queue PR review jobs for open GitHub PRs.
   *
   * Review jobs have priority 5 — they run before roadmap (10), plan (20),
   * implement (30), and work-item (35) jobs. This ensures the human-in-the-loop
   * feedback cycle completes before new implementation work starts.
   *
   * Two modes:
   * - No project specified: posts one bulk-scan job that discovers all open PRs
   *   and posts per-PR jobs automatically
   * - Project specified: scans only that project's repo
   */
  async review(projectName?: string): Promise<void> {
    const { scanOpenPRs } = await import('./workflow/stages/review-prs.js');

    // Cancel stale queued review/pr-fix jobs to prevent duplicate processing
    const cancelledReviews = this.queue.cancelByType('review', projectName ?? undefined);
    const cancelledFixes = this.queue.cancelByType('pr-fix', projectName ?? undefined);
    if (cancelledReviews + cancelledFixes > 0) {
      console.log(chalk.dim(`  Cancelled ${cancelledReviews + cancelledFixes} stale review/fix job(s) from previous run.`));
    }

    if (projectName) {
      this.validateProject(projectName);
      const prs = scanOpenPRs([projectName], this.settings.workspaceRoot, this.settings.projectsDir);

      if (prs.length === 0) {
        console.log(chalk.dim(`\n  No open PRs found for ${projectName}.\n`));
        return;
      }

      const jobs = prs.map((pr) =>
        this.queue.post('review', 'review', pr.project, {
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
        // Priority = 5 + mergeLayer: foundation PRs run first, children run after
        }, 5 + pr.mergeLayer),
      );

      console.log(chalk.bold.blue(`\n▶ Review: queued ${jobs.length} PR review job(s) for ${projectName}`));
      for (const pr of prs) {
        const layerLabel = pr.mergeLayer > 0 ? ` [layer ${pr.mergeLayer}]` : ' [foundation]';
        console.log(chalk.dim(`    PR #${pr.number}${layerLabel} — ${pr.title}`));
      }
    } else {
      // Scan all projects and post per-PR jobs directly
      const prs = scanOpenPRs(this.settings.projects, this.settings.workspaceRoot, this.settings.projectsDir);

      if (prs.length === 0) {
        console.log(chalk.dim('\n  No open PRs found across managed projects.\n'));
        return;
      }

      const jobs = prs.map((pr) =>
        this.queue.post('review', 'review', pr.project, {
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
        }, 5 + pr.mergeLayer),
      );

      console.log(chalk.bold.blue(`\n▶ Review: queued ${jobs.length} PR review job(s) across all projects`));
      for (const pr of prs) {
        const layerLabel = pr.mergeLayer > 0 ? ` [layer ${pr.mergeLayer}]` : ' [foundation]';
        console.log(chalk.dim(`    [${pr.project}] PR #${pr.number}${layerLabel} — ${pr.title}`));
      }
    }

    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued PR review jobs (priority 5)`,
    });
  }

  /**
   * Interactive review — automated reviews first, then user presentation.
   *
   * Replaces the old triage-first approach. Now runs automated code reviews
   * for all PRs, presents results with rich context, collects scoped feedback,
   * and creates close-out work items for autonomous processing.
   *
   * Requires a Worker reference for waitForReviewsDrained and worker control.
   */
  async newInteractiveReview(
    project: string,
    io: ReviewSessionIO,
    workerControls: {
      enableWorker: () => void;
      disableWorker: () => void;
      waitForReviewsDrained: (project: string) => Promise<void>;
      waitForCloseOutsDrained: (project: string, prNumbers: readonly number[]) => Promise<void>;
    },
  ): Promise<void> {
    this.validateProject(project);

    // Cancel stale queued review/pr-fix jobs
    const cancelledReviews = this.queue.cancelByType('review', project);
    const cancelledFixes = this.queue.cancelByType('pr-fix', project);
    if (cancelledReviews + cancelledFixes > 0) {
      io.print(chalk.dim(`  Cancelled ${cancelledReviews + cancelledFixes} stale review/fix job(s) from previous run.`));
    }

    this.setPhase('review', `Interactive review for ${project}`);

    const { runInteractiveReview } = await import('./workflow/stages/interactive-review.js');
    await runInteractiveReview(project, {
      store: this.store,
      queue: this.queue,
      eventLog: this.eventLog,
      settings: this.settings,
      summaryAgent: this.requireAgent('architect'),
      ...workerControls,
    }, io);
  }

  /**
   * Queue a reflection job.
   * Returns immediately — use `forge worker` to execute.
   */
  async reflect(): Promise<void> {
    const job = this.queue.post('reflect', 'reflection');

    console.log(chalk.bold.blue('\n▶ Reflection: queued 1 job'));
    console.log(chalk.dim(`    ${job.id}`));
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: 'Queued 1 reflection job',
    });
  }

  /**
   * Queue a fix job for a specific PR — kicks off the autonomous
   * review→fix→re-review loop starting from round 1.
   *
   * Called by the user after they've seen the initial review and want
   * the system to autonomously resolve the feedback.
   */
  async fix(prNumber: number, projectName: string): Promise<void> {
    this.validateProject(projectName);

    // Look up PR metadata via gh
    const { execSync } = await import('node:child_process');
    const projectPath = resolveProjectPath(this.settings, projectName);

    let prData: { branch: string; repo: string; title: string; headSha: string };
    try {
      const json = execSync(
        `gh pr view ${prNumber} --json headRefName,headRepository,headRepositoryOwner,title,headRefOid`,
        { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const parsed = JSON.parse(json) as {
        headRefName: string;
        headRepository: { name: string };
        headRepositoryOwner: { login: string };
        title: string;
        headRefOid: string;
      };
      prData = {
        branch: parsed.headRefName,
        repo: `${parsed.headRepositoryOwner.login}/${parsed.headRepository.name}`,
        title: parsed.title,
        headSha: parsed.headRefOid,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Could not look up PR #${prNumber}: ${msg}`));
      process.exit(1);
    }

    const job = this.queue.post('pr-fix', 'pr-fix', projectName, {
      prNumber,
      repo: prData.repo,
      project: projectName,
      branch: prData.branch,
      prTitle: prData.title,
      fixRound: 1,
      lastReviewedSha: prData.headSha,
    }, 12);

    console.log(chalk.bold.blue(`\n▶ Fix: queued pr-fix job for PR #${prNumber} (${prData.title})`));
    console.log(chalk.dim(`    Branch: ${prData.branch} | Repo: ${prData.repo}`));
    console.log(chalk.dim(`    Fix round: 1 — autonomous loop will run until approved or max rounds hit`));
    console.log(chalk.dim(`    Job: ${job.id}`));
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued pr-fix for PR #${prNumber} in ${projectName} (round 1, autonomous)`,
    });
  }

  /**
   * Queue fix jobs for ALL open PRs across all (or one) project(s).
   *
   * This is the batch version of `fix()`. It scans for open PRs, then
   * queues a pr-fix job for each one at round 1 — kicking off the
   * autonomous review→fix→re-review loop for every open PR.
   */
  async fixAll(projectName?: string): Promise<void> {
    const { scanOpenPRs } = await import('./workflow/stages/review-prs.js');
    const { execSync } = await import('node:child_process');

    const projects = projectName
      ? [this.validateAndReturn(projectName)]
      : [...this.settings.projects];

    // Cancel stale pr-fix and review jobs to prevent duplicate processing
    const cancelledFixes = this.queue.cancelByType('pr-fix', projectName ?? undefined);
    const cancelledReviews = this.queue.cancelByType('review', projectName ?? undefined);
    if (cancelledFixes + cancelledReviews > 0) {
      console.log(chalk.dim(`  Cancelled ${cancelledFixes + cancelledReviews} stale job(s) from previous run.`));
    }

    const prs = scanOpenPRs(projects, this.settings.workspaceRoot, this.settings.projectsDir);

    if (prs.length === 0) {
      console.log(chalk.dim('\n  No open PRs found to fix.\n'));
      return;
    }

    // Chain consolidation: group PRs by chain tip.
    // For chains, only queue a fix for the tip PR — it contains all ancestor
    // commits, so fixing the tip fixes everything. Ancestors get closed after
    // the tip merges. This avoids wasted effort fixing PRs that will conflict
    // with each other.
    const chainTips = new Map<number, typeof prs[0]>();   // tipPR# → tip PR
    const chainAncestors = new Map<number, number[]>();    // tipPR# → ancestor PR#s
    const standalone: typeof prs = [];

    for (const pr of prs) {
      if (pr.chainTipPR && pr.chainTipPR !== pr.number) {
        // This is an ancestor — group under its chain tip
        const ancestors = chainAncestors.get(pr.chainTipPR) ?? [];
        ancestors.push(pr.number);
        chainAncestors.set(pr.chainTipPR, ancestors);
      } else if (pr.chainMembers && pr.chainMembers.length > 1) {
        // This IS the chain tip
        chainTips.set(pr.number, pr);
        const ancestors = chainAncestors.get(pr.number) ?? [];
        chainAncestors.set(pr.number, ancestors);
      } else {
        standalone.push(pr);
      }
    }

    const jobs: { prNumber: number; project: string; title: string; isChainTip?: boolean }[] = [];

    // Queue standalone PR fixes — prioritize by mergeLayer so base PRs
    // get fixed and merged first, clearing the way for dependent PRs.
    // Priority: 10 (base) → 11 → 12 → ... so lower layers run first.
    for (const pr of standalone) {
      const headSha = pr.uniqueHeadSha || this.getHeadSha(execSync, pr);
      const layerPriority = 10 + Math.min(pr.mergeLayer, 5);

      this.queue.post('pr-fix', 'pr-fix', pr.project, {
        prNumber: pr.number,
        repo: pr.repo,
        project: pr.project,
        branch: pr.branch,
        prTitle: pr.title,
        fixRound: 1,
        lastReviewedSha: headSha,
        userTriaged: true,
      }, layerPriority);

      jobs.push({ prNumber: pr.number, project: pr.project, title: pr.title });
    }

    // Queue chain tip fixes (one per chain, consolidates all ancestors)
    for (const [tipNum, tipPR] of chainTips) {
      const ancestors = chainAncestors.get(tipNum) ?? [];
      const headSha = tipPR.uniqueHeadSha || this.getHeadSha(execSync, tipPR);

      this.queue.post('pr-fix', 'pr-fix', tipPR.project, {
        prNumber: tipPR.number,
        repo: tipPR.repo,
        project: tipPR.project,
        branch: tipPR.branch,
        prTitle: tipPR.title,
        fixRound: 1,
        lastReviewedSha: headSha,
        userTriaged: true,
        isChainTip: true,
        ancestorPRs: ancestors,
        chainSize: ancestors.length + 1,
      }, 12);

      jobs.push({ prNumber: tipPR.number, project: tipPR.project, title: tipPR.title, isChainTip: true });

      if (ancestors.length > 0) {
        console.log(chalk.cyan(`  Chain: ${ancestors.length + 1} PRs → fixing tip #${tipNum} only (ancestors: ${ancestors.map(n => `#${n}`).join(', ')})`));
      }
    }

    console.log(chalk.bold.blue(`\n▶ Fix-all: queued ${jobs.length} pr-fix job(s) (${chainTips.size} chain(s), ${standalone.length} standalone)`));
    for (const j of jobs) {
      const tag = j.isChainTip ? chalk.cyan(' [chain tip]') : '';
      console.log(chalk.dim(`    [${j.project}] PR #${j.prNumber} — ${j.title}${tag}`));
    }
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} pr-fix jobs (${chainTips.size} chain(s), ${standalone.length} standalone) across ${projects.join(', ')}`,
    });
  }

  /** Helper to fetch HEAD SHA for a PR via gh CLI. */
  private getHeadSha(
    execSyncFn: typeof import('node:child_process').execSync,
    pr: { number: number; project: string },
  ): string {
    try {
      const projectPath = resolveProjectPath(this.settings, pr.project);
      return execSyncFn(
        `gh pr view ${pr.number} --json headRefOid --jq .headRefOid`,
        { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      return '';
    }
  }

  /**
   * Resume pending work by queuing appropriate jobs based on current phase.
   */
  async resume(projectOrWorkItemId?: string): Promise<void> {
    const phase = this.getCurrentPhase();

    switch (phase) {
      case 'roadmapping':
        await this.roadmap(projectOrWorkItemId);
        break;
      case 'implementation':
        await this.implement(projectOrWorkItemId);
        break;
      case 'review':
        await this.review(projectOrWorkItemId);
        break;
      case 'merging':
        await this.fixAll(projectOrWorkItemId);
        break;
      case 'reflect':
        await this.reflect();
        break;
    }
  }

  /**
   * Run the research agent. (Still blocking — research is interactive/exploratory.)
   */
  async research(): Promise<void> {
    const researcher = this.requireAgent('researcher');
    console.log(chalk.blue('\n▶ Running research agent...\n'));

    const { runResearchAgent } = await import('./research/researcher.js');
    await runResearchAgent(researcher, this.store, this.settings.workspaceRoot);
    console.log(chalk.green('✓ Research complete\n'));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Interactive Commands (blocking — used by session)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Run an interactive roadmap session for a project.
   *
   * Unlike `roadmap()` which queues a fire-and-forget job, this runs a
   * multi-phase conversation: discovery → direction → draft → refinement → approval.
   * Blocks until the user approves or cancels.
   */
  async interactiveRoadmap(
    projectName: string,
    io: RoadmapSessionIO,
  ): Promise<Roadmap | null> {
    this.validateProject(projectName);
    const architect = this.requireAgent('architect');
    const projectPath = resolveProjectPath(this.settings, projectName);

    const { runInteractiveRoadmap } = await import('./workflow/stages/interactive-roadmap.js');
    const roadmap = await runInteractiveRoadmap(architect, projectName, projectPath, this.store, io);

    if (roadmap) {
      this.eventLog.emit({
        type: 'roadmap.created',
        summary: `Interactive roadmap approved for ${projectName}: ${roadmap.milestones.length} milestones`,
      });
    }

    return roadmap;
  }

  /**
   * Run an interactive reflection session for a project.
   *
   * Unlike the autonomous `reflect()` which queues a fire-and-forget job,
   * this runs a multi-phase conversation: analysis → presentation →
   * commentary → synthesis → approval. Blocks until the user approves or cancels.
   *
   * Reflect is forge introspection — it evaluates forge's process performance,
   * not project direction. Project direction belongs in roadmapping.
   */
  async interactiveReflect(
    projectName: string,
    io: ReflectSessionIO,
  ): Promise<string | null> {
    this.validateProject(projectName);
    const reflector = this.requireAgent('reflector');
    const projectPath = resolveProjectPath(this.settings, projectName);

    const { runInteractiveReflect } = await import('./workflow/stages/interactive-reflect.js');
    const report = await runInteractiveReflect(
      reflector, projectName, projectPath, this.store, this.eventLog, io,
    );

    if (report) {
      this.eventLog.emit({
        type: 'reflection.complete',
        summary: `Interactive reflection completed for ${projectName}`,
        project: projectName,
      });
    }

    return report;
  }

  /**
   * Archive the current cycle and reset for a new one.
   *
   * Moves work items, jobs, and events to `.forge/archive/cycle-{date}/`.
   * Keeps learnings (valuable across cycles) and optionally roadmaps.
   * Resets phase to 'roadmapping'.
   */
  archiveCycle(opts: { keepRoadmaps?: boolean } = {}): void {
    const result = this.store.archiveCycle(opts);

    console.log(chalk.bold.blue('\n  Cycle archived:\n'));
    console.log(`  Work items: ${result.archivedWorkItems} archived`);
    console.log(`  Jobs:       ${result.archivedJobs} archived`);
    console.log(`  Phase:      reset to ${chalk.bold('roadmapping')}`);
    console.log(chalk.dim(`  Archive:    ${result.archivePath}`));
    console.log(chalk.dim(`  Learnings:  kept (valuable across cycles)`));
    if (opts.keepRoadmaps) {
      console.log(chalk.dim(`  Roadmaps:   kept (for continuity)`));
    } else {
      console.log(chalk.dim(`  Roadmaps:   archived (fresh start)`));
    }
    console.log();

    this.eventLog.emit({
      type: 'cycle.archived',
      summary: `Cycle archived: ${result.archivedWorkItems} items, ${result.archivedJobs} jobs → ${result.archivePath}`,
    });
  }

  /**
   * Get the list of managed project names. Exposed for interactive commands.
   */
  getProjectNames(): readonly string[] {
    return this.settings.projects;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Queue Management
  // ═══════════════════════════════════════════════════════════════════

  /** Show job queue summary. */
  jobs(): void {
    const summary = this.queue.summary();

    console.log(chalk.bold('\n  Job Queue:\n'));
    console.log(`  Queued: ${summary.queued} | Running: ${summary.running} | Completed: ${summary.completed} | Failed: ${summary.failed}`);
    console.log();

    // List active/queued jobs
    const activeJobs = this.queue.all().filter((j) => j.status === 'queued' || j.status === 'running');
    if (activeJobs.length > 0) {
      console.log(chalk.bold('  Pending Jobs:'));
      for (const j of activeJobs) {
        const icon = j.status === 'running' ? chalk.yellow('◆') : chalk.dim('○');
        const project = j.project ? ` [${j.project}]` : '';
        console.log(`    ${icon} ${j.id}: ${j.type}${project} (priority: ${j.priority})`);
      }
      console.log();
    }

    // List recently failed jobs
    const failedJobs = this.queue.all().filter((j) => j.status === 'failed');
    if (failedJobs.length > 0) {
      console.log(chalk.bold.red('  Failed Jobs:'));
      for (const j of failedJobs) {
        const project = j.project ? ` [${j.project}]` : '';
        console.log(chalk.red(`    ✗ ${j.id}: ${j.type}${project}`));
        if (j.error) {
          console.log(chalk.dim(`      ${j.error.slice(0, 120)}`));
        }
      }
      console.log();
    }
  }

  /** Cancel all queued jobs, or a specific one. */
  cancelJobs(jobId?: string): void {
    if (jobId) {
      this.queue.cancel(jobId);
      console.log(chalk.yellow(`\n  Cancelled job: ${jobId}\n`));
    } else {
      const count = this.queue.cancelAll();
      console.log(chalk.yellow(`\n  Cancelled ${count} queued job(s)\n`));
    }
  }

  /** Reset all failed jobs back to queued for retry. */
  retryFailed(): void {
    const count = this.queue.retryFailed();
    if (count > 0) {
      console.log(chalk.green(`\n  Reset ${count} failed job(s) back to queued\n`));
    } else {
      console.log(chalk.dim('\n  No failed jobs to retry\n'));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Status & Display
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Print current status including phase, budget, jobs, and work items.
   */
  status(): void {
    const summary = this.store.summary();
    const phase = this.store.getPhase();
    const jobSummary = this.queue.summary();

    console.log(chalk.bold('\n  Forge Orchestrator Status\n'));
    console.log(`  Phase: ${chalk.bold(phase.currentPhase)} (since ${new Date(phase.enteredAt).toLocaleDateString()})`);
    if (phase.notes) console.log(chalk.dim(`  Notes: ${phase.notes}`));
    console.log(`  Work items: ${summary.totalWorkItems} total | ${summary.pendingReview} pending review`);
    console.log(`  Jobs: ${jobSummary.queued} queued | ${jobSummary.running} running | ${jobSummary.completed} completed | ${jobSummary.failed} failed`);
    console.log(`  Budget: ${this.budget.summary()}`);
    console.log(`  ${this.resources.summary()}`);
    console.log();

    // Roadmaps
    const roadmaps = this.store.listRoadmaps();
    if (roadmaps.length > 0) {
      console.log(chalk.bold('  Roadmaps:'));
      for (const rm of roadmaps) {
        console.log(`    ${rm.project}: ${rm.milestones.length} milestones (updated ${new Date(rm.updatedAt).toLocaleDateString()})`);
      }
      console.log();
    }

    if (Object.keys(summary.byStage).length > 0) {
      console.log(chalk.bold('  By Stage:'));
      for (const [stage, count] of Object.entries(summary.byStage)) {
        console.log(`    ${stage}: ${count}`);
      }
      console.log();
    }

    if (Object.keys(summary.byStatus).length > 0) {
      console.log(chalk.bold('  By Status:'));
      for (const [status, count] of Object.entries(summary.byStatus)) {
        console.log(`    ${status}: ${count}`);
      }
      console.log();
    }

    // Work items by project
    for (const project of this.settings.projects) {
      const items = this.store.getWorkItemsByProject(project);
      if (items.length === 0) continue;

      console.log(chalk.bold(`  ${project}:`));
      for (const item of items) {
        const icon = item.status === 'completed' ? '✓'
          : item.status === 'blocked' ? '⊘'
          : item.status === 'in-progress' ? '◆'
          : item.status === 'failed' ? '✗'
          : '○';
        const color = item.status === 'completed' ? chalk.green
          : item.status === 'blocked' || item.status === 'failed' ? chalk.red
          : item.status === 'in-progress' ? chalk.yellow
          : chalk.dim;
        const depStr = item.dependsOn?.length > 0
          ? chalk.dim(` → after: ${item.dependsOn.map((d) => d.split('/').pop()).join(', ')}`)
          : '';
        console.log(color(`    ${icon} [${item.id}] ${item.title} (${item.stage}/${item.status})${depStr}`));
      }
      console.log();
    }

    // Recent events
    const recentEvents = this.eventLog.recent(10);
    if (recentEvents.length > 0) {
      console.log(chalk.bold('  Recent Events:'));
      for (const event of recentEvents) {
        const time = new Date(event.timestamp).toLocaleTimeString();
        console.log(chalk.dim(`    [${time}] ${event.type}: ${event.summary}`));
      }
      console.log();
    }
  }

  /**
   * List managed projects.
   */
  listProjects(): void {
    console.log(chalk.bold('\n  Managed Projects:\n'));
    for (const project of this.settings.projects) {
      const items = this.store.getWorkItemsByProject(project);
      const roadmap = this.store.getRoadmap(project);
      const brief = this.store.getDesignBrief(project);
      const roadmapStatus = roadmap ? `${roadmap.milestones.length} milestones` : 'no roadmap';
      const briefStatus = brief ? `${brief.features.length} features designed` : 'not analyzed';
      console.log(`  ${project} — ${items.length} work items (${roadmapStatus}, ${briefStatus})`);
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════════════════════════════

  private requireAgent(role: AgentRole): AgentDefinition {
    const agent = this.agents.get(role);
    if (!agent) throw new Error(`Agent not found: ${role}`);
    return agent;
  }

  private validateProject(name: string): void {
    if (!this.settings.projects.includes(name)) {
      throw new Error(
        `Unknown project "${name}". Managed projects: ${this.settings.projects.join(', ')}`,
      );
    }
  }

  private validateAndReturn(name: string): string {
    this.validateProject(name);
    return name;
  }

  private printWorkerHint(): void {
    console.log(chalk.dim(`\n  Run ${chalk.bold('forge worker')} to process these jobs.`));
    console.log(chalk.dim(`  Run ${chalk.bold('forge jobs')} to see the queue.\n`));
  }
}
