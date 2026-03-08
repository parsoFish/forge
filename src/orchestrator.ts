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
import { StateStore } from './state/index.js';
import { EventLog } from './events/index.js';
import { BudgetTracker } from './budget/index.js';
import { ResourceMonitor } from './monitor/index.js';
import { JobQueue } from './jobs/index.js';
import type { WorkflowStage, OrchestratorPhase } from './workflow/types.js';

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
    this.budget = new BudgetTracker(forgeRoot, this.settings.budget);
    this.resources = new ResourceMonitor(this.settings.resourceThresholds);
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
    this.store.setPhase('roadmapping', userDirection ?? '');

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
    this.store.setPhase('planning');

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

    const jobs = this.queue.postForProjects('plan', 'planning', valid, {});

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
    this.store.setPhase('implementation');

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
   * Interactive review — triage PRs with user input before queuing.
   *
   * Shows each PR's intent and changes, lets the user accept, skip,
   * or provide feedback that gets included in the review prompt.
   * This replaces blind queue-all-and-go for the session's /review command.
   */
  async interactiveReview(projectName?: string, askFn?: (prompt: string) => Promise<string>): Promise<void> {
    const { scanOpenPRs, interactiveTriagePRs } = await import('./workflow/stages/review-prs.js');

    // Cancel stale queued review/pr-fix jobs
    const cancelledReviews = this.queue.cancelByType('review', projectName ?? undefined);
    const cancelledFixes = this.queue.cancelByType('pr-fix', projectName ?? undefined);
    if (cancelledReviews + cancelledFixes > 0) {
      console.log(chalk.dim(`  Cancelled ${cancelledReviews + cancelledFixes} stale review/fix job(s) from previous run.`));
    }

    const projects = projectName
      ? (this.validateProject(projectName), [projectName])
      : [...this.settings.projects];

    const prs = scanOpenPRs(projects, this.settings.workspaceRoot, this.settings.projectsDir);

    if (prs.length === 0) {
      console.log(chalk.dim('\n  No open PRs found.\n'));
      return;
    }

    // Interactive triage — pass askFn to avoid creating a second readline
    const decisions = await interactiveTriagePRs(prs, this.settings.workspaceRoot, this.settings.projectsDir, askFn);

    const accepted = decisions.filter((d) => d.action !== 'skip');
    if (accepted.length === 0) {
      console.log(chalk.dim('  No PRs selected for review.\n'));
      return;
    }

    // Chain consolidation: group accepted PRs by chain tip.
    // For chains, we queue a single consolidated review job for the tip PR
    // that includes feedback from all chain members. The tip branch already
    // contains all ancestor commits — fixing only the tip is sufficient.
    const chainGroups = new Map<number, typeof accepted>(); // tipPR# → decisions
    const standalone: typeof accepted = [];

    for (const d of accepted) {
      const tipNum = d.pr.chainTipPR;
      if (tipNum && tipNum !== d.pr.number) {
        // This PR is part of a chain but not the tip — group it
        const group = chainGroups.get(tipNum) ?? [];
        group.push(d);
        chainGroups.set(tipNum, group);
      } else if (d.pr.chainMembers && d.pr.chainMembers.length > 1) {
        // This IS the chain tip — start its group
        const group = chainGroups.get(d.pr.number) ?? [];
        group.push(d);
        chainGroups.set(d.pr.number, group);
      } else {
        standalone.push(d);
      }
    }

    const jobs: import('./jobs/types.js').Job[] = [];

    // Queue standalone PR reviews normally
    for (const d of standalone) {
      jobs.push(this.queue.post('review', 'review', d.pr.project, {
        prNumber:      d.pr.number,
        prTitle:       d.pr.title,
        prUrl:         d.pr.url,
        branch:        d.pr.branch,
        repo:          d.pr.repo,
        project:       d.pr.project,
        prCreatedAt:   d.pr.createdAt,
        mergeLayer:    d.pr.mergeLayer,
        dependsOnPRs:  d.pr.dependsOnPRs,
        blocksPRs:     d.pr.blocksPRs,
        uniqueHeadSha: d.pr.uniqueHeadSha,
        ...(d.feedback ? { userFeedback: d.feedback } : {}),
        userTriaged: true,
      }, 5 + d.pr.mergeLayer));
    }

    // Queue consolidated review jobs for chains — one job per chain tip
    for (const [tipNum, group] of chainGroups) {
      // Find the tip PR's decision (it may or may not be in the accepted list)
      const tipDecision = group.find((d) => d.pr.number === tipNum);
      const tipPR = tipDecision?.pr ?? prs.find((pr) => pr.number === tipNum);
      if (!tipPR) continue;

      // Collect feedback from all chain members
      const chainFeedback = group
        .filter((d) => d.feedback)
        .map((d) => `PR #${d.pr.number} (${d.pr.title}): ${d.feedback}`)
        .join('\n');

      // Collect all ancestor PR numbers for the consolidated close-on-merge
      const ancestorPRs = (tipPR.chainMembers ?? []).filter((n) => n !== tipNum);

      jobs.push(this.queue.post('review', 'review', tipPR.project, {
        prNumber:      tipPR.number,
        prTitle:       tipPR.title,
        prUrl:         tipPR.url,
        branch:        tipPR.branch,
        repo:          tipPR.repo,
        project:       tipPR.project,
        prCreatedAt:   tipPR.createdAt,
        mergeLayer:    0, // Chain tip gets priority — it's the only one that needs fixing
        dependsOnPRs:  [],
        blocksPRs:     [],
        uniqueHeadSha: tipPR.uniqueHeadSha,
        ...(chainFeedback ? { userFeedback: chainFeedback } : {}),
        userTriaged: true,
        // Chain consolidation metadata
        isChainTip: true,
        ancestorPRs,
        chainSize: (tipPR.chainMembers ?? []).length,
      }, 5));

      // Log the chain consolidation
      console.log(chalk.bold.cyan(`  Chain consolidation: ${ancestorPRs.length + 1} PRs → PR #${tipNum} (tip)`));
      for (const d of group) {
        const isTop = d.pr.number === tipNum ? chalk.bold(' ← tip') : '';
        console.log(chalk.dim(`    PR #${d.pr.number}: ${d.pr.title}${isTop}`));
      }
      // Show ancestor PRs that weren't explicitly accepted but will be closed
      for (const ancestorNum of ancestorPRs) {
        if (!group.some((d) => d.pr.number === ancestorNum)) {
          const ancestorPR = prs.find((pr) => pr.number === ancestorNum);
          if (ancestorPR) {
            console.log(chalk.dim(`    PR #${ancestorNum}: ${ancestorPR.title} (auto-included in chain)`));
          }
        }
      }
    }

    console.log(chalk.bold.blue(`\n▶ Review: queued ${jobs.length} review job(s) (${chainGroups.size} chain(s), ${standalone.length} standalone)`));
    for (const d of standalone) {
      const layerLabel = d.pr.mergeLayer > 0 ? ` [layer ${d.pr.mergeLayer}]` : ' [foundation]';
      const feedbackNote = d.feedback ? chalk.cyan(' +feedback') : '';
      console.log(chalk.dim(`    [${d.pr.project}] PR #${d.pr.number}${layerLabel} — ${d.pr.title}${feedbackNote}`));
    }

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} PR review jobs (${chainGroups.size} consolidated chain(s), ${standalone.length} standalone)`,
    });
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

    const job = this.queue.post('pr-fix', 'pr-fix' as import('./jobs/types.js').JobPhase, projectName, {
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

    // Cancel stale pr-fix jobs to prevent duplicate processing
    const cancelled = this.queue.cancelByType('pr-fix', projectName ?? undefined);
    if (cancelled > 0) {
      console.log(chalk.dim(`  Cancelled ${cancelled} stale pr-fix job(s) from previous run.`));
    }

    const prs = scanOpenPRs(projects, this.settings.workspaceRoot, this.settings.projectsDir);

    if (prs.length === 0) {
      console.log(chalk.dim('\n  No open PRs found to fix.\n'));
      return;
    }

    const jobs: { prNumber: number; project: string; title: string }[] = [];
    for (const pr of prs) {
      // Get HEAD SHA for each PR
      let headSha = pr.uniqueHeadSha ?? '';
      if (!headSha) {
        try {
          const projectPath = resolveProjectPath(this.settings, pr.project);
          const json = execSync(
            `gh pr view ${pr.number} --json headRefOid --jq .headRefOid`,
            { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
          headSha = json;
        } catch {
          headSha = '';
        }
      }

      this.queue.post('pr-fix', 'pr-fix' as import('./jobs/types.js').JobPhase, pr.project, {
        prNumber: pr.number,
        repo: pr.repo,
        project: pr.project,
        branch: pr.branch,
        prTitle: pr.title,
        fixRound: 1,
        lastReviewedSha: headSha,
      }, 12);

      jobs.push({ prNumber: pr.number, project: pr.project, title: pr.title });
    }

    console.log(chalk.bold.blue(`\n▶ Fix-all: queued ${jobs.length} pr-fix job(s)`));
    for (const j of jobs) {
      console.log(chalk.dim(`    [${j.project}] PR #${j.prNumber} — ${j.title}`));
    }
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued ${jobs.length} pr-fix jobs across ${projects.join(', ')}`,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Legacy / Convenience Commands
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Queue a full pipeline for a single project (roadmap + plan + implement).
   */
  async runProject(projectName: string): Promise<void> {
    this.validateProject(projectName);

    // Post jobs — the worker will execute them in priority order
    // (roadmap=10 → plan=20 → implement=30), so order is preserved.
    const roadmapJob = this.queue.post('roadmap', 'roadmapping', projectName, {});
    const planJob = this.queue.post('plan', 'planning', projectName, {});
    const implJob = this.queue.post('implement', 'implementation', projectName, {});

    console.log(chalk.bold.blue(`\n▶ Full pipeline for ${projectName}: queued 3 jobs`));
    console.log(chalk.dim(`    ${roadmapJob.id}: roadmap`));
    console.log(chalk.dim(`    ${planJob.id}: plan`));
    console.log(chalk.dim(`    ${implJob.id}: implement`));
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued full pipeline (3 jobs) for ${projectName}`,
    });
  }

  /**
   * Queue the full pipeline for ALL managed projects.
   */
  async runAll(): Promise<void> {
    let total = 0;
    for (const project of this.settings.projects) {
      this.queue.post('roadmap', 'roadmapping', project, {});
      this.queue.post('plan', 'planning', project, {});
      this.queue.post('implement', 'implementation', project, {});
      total += 3;
    }

    console.log(chalk.bold.blue(`\n▶ Full pipeline for all projects: queued ${total} jobs`));
    console.log(chalk.dim(`  Projects: ${this.settings.projects.join(', ')}`));
    this.printWorkerHint();

    this.eventLog.emit({
      type: 'jobs.queued',
      summary: `Queued full pipeline (${total} jobs) for all projects`,
    });
  }

  /**
   * Resume pending work by queuing appropriate jobs based on current phase.
   */
  async resume(projectOrWorkItemId?: string): Promise<void> {
    const phase = this.getCurrentPhase();

    if (phase === 'roadmapping') {
      await this.roadmap(projectOrWorkItemId);
      return;
    }

    if (phase === 'planning') {
      await this.plan(projectOrWorkItemId);
      return;
    }

    // Default: implementation
    await this.implement(projectOrWorkItemId);
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
        const limit = this.getPhaseLimitForStage(stage as WorkflowStage);
        console.log(`    ${stage}: ${count} (max ${limit} concurrent)`);
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

  private getPhaseLimitForStage(stage: WorkflowStage): number {
    const pc = this.settings.phaseConcurrency;
    switch (stage) {
      case 'design':
      case 'plan':
        return pc.designPlan;
      case 'test':
        return pc.test;
      case 'develop':
        return pc.develop;
      case 'pr':
      case 'review':
        return pc.prReview;
      default:
        return this.settings.maxConcurrency;
    }
  }

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
