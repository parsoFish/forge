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
import { setGlobalEventLog, runAgent, parseRateLimitReset } from '../agents/runner.js';
import { loadSettings, resolveProjectPath, type ForgeSettings } from '../config/index.js';
import { StateStore } from '../state/index.js';
import { EventLog } from '../events/index.js';
import { BudgetTracker } from '../budget/index.js';
import { ResourceMonitor, DEFAULT_THRESHOLDS } from '../monitor/index.js';
import { AdaptiveConcurrency } from '../monitor/adaptive-concurrency.js';
import { ResourceProfiler, type ResourceObservation } from '../monitor/resource-profiler.js';
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
import { writeWorkerStatus, clearWorkerStatus, type WorkerStatus } from '../ui/worker-status-file.js';

const POLL_INTERVAL_MS = 3_000;  // Check for new jobs every 3s
const IDLE_LOG_INTERVAL_MS = 60_000;  // Log "still waiting" every 60s when idle

/**
 * Thrown by job executors when a job should be put back in the queue
 * instead of marked complete or failed (e.g. dependency not met).
 */
class JobDeferred extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JobDeferred';
  }
}

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
  private readonly adaptive: AdaptiveConcurrency;
  private readonly profiler: ResourceProfiler;
  private readonly agents: Map<AgentRole, AgentDefinition>;
  private readonly queue: JobQueue;

  private _shutdownRequested = false;
  private _paused = false;
  private _activeJobs = 0;
  private _processedCount = 0;
  /** When rate-limited, the time (ms epoch) we can resume. 0 = not limited. */
  private _rateLimitResetAt = 0;
  /** Tracks processed count at end of each tick to detect no-progress spins. */
  private _lastTickProcessed = 0;
  private _noProgressTicks = 0;
  /** Last slot name logged as blocked — avoids spamming the same message. */
  private _lastSlotBlockLogged: string | null = null;
  /** Promises for all in-flight jobs — tracked so we can await them on shutdown. */
  private readonly _inflightJobs = new Set<Promise<void>>();
  /** Projects with an active pr-fix job — serialize fixes per project to avoid conflict whack-a-mole. */
  private readonly _projectFixLocks = new Set<string>();

  // ── Session integration callbacks ──────────────────────────────

  /**
   * Called when the worker hits a rate limit. The session uses this to
   * auto-pause the worker and schedule a resume timer.
   * @param resetAt - ms epoch when the rate limit resets
   */
  onRateLimited?: (resetAt: number) => void;

  /**
   * Called when the budget is exhausted. The session uses this to
   * auto-pause the worker.
   */
  onBudgetExhausted?: () => void;

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
    this.profiler = new ResourceProfiler(forgeRoot);
    this.adaptive = new AdaptiveConcurrency(this.resources, this.profiler, {
      ceiling: this.settings.concurrency.ceiling,
      targetCpuLoad: this.settings.concurrency.targetCpuLoad,
      criticalCpuLoad: this.settings.concurrency.criticalCpuLoad,
      memoryPerAgentMb: this.settings.concurrency.memoryPerAgentMb,
    });
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
   * Pause the worker — stops claiming new jobs but lets in-flight jobs
   * finish naturally. Used by the session for rate limit recovery and
   * manual toggle.
   */
  pause(): void {
    if (this._paused) return;
    this._paused = true;
    console.log(chalk.dim('  ⏸ Worker paused'));
  }

  /**
   * Resume a paused worker — start claiming jobs again on the next tick.
   */
  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    this._rateLimitResetAt = 0; // Clear any stale rate limit
    console.log(chalk.dim('  ▶ Worker resumed'));
  }

  /** Whether the worker is currently paused. */
  get isPaused(): boolean {
    return this._paused;
  }

  /** The rate limit reset time (ms epoch), or 0 if not rate-limited. */
  get rateLimitResetTime(): number {
    return this._rateLimitResetAt;
  }

  /** Number of jobs currently executing. */
  get activeJobCount(): number {
    return this._activeJobs;
  }

  /** Number of jobs processed this session. */
  get processedCount(): number {
    return this._processedCount;
  }

  /** Expose the job queue for monitoring (read-only access). */
  get jobQueue(): JobQueue {
    return this.queue;
  }

  /** Expose the resource monitor for monitoring (read-only access). */
  get resourceMonitor(): ResourceMonitor {
    return this.resources;
  }

  /** Expose the budget tracker for monitoring (read-only access). */
  get budgetTracker(): BudgetTracker {
    return this.budget;
  }

  /** Write current status to .forge/worker-status.json for UI panes. */
  private broadcastStatus(): void {
    const health = this.resources.check();
    const queueSummary = this.queue.summary();
    const status: WorkerStatus = {
      pid: process.pid,
      state: this._rateLimitResetAt > Date.now()
        ? 'rate-limited'
        : this._paused ? 'paused' : 'running',
      updatedAt: new Date().toISOString(),
      activeJobs: this._activeJobs,
      processedCount: this._processedCount,
      rateLimitResetAt: this._rateLimitResetAt > 0 ? this._rateLimitResetAt : undefined,
      queue: {
        queued: queueSummary.queued,
        running: queueSummary.running,
        completed: queueSummary.completed,
        failed: queueSummary.failed,
      },
      resources: {
        healthy: health.healthy,
        cpuLoadFactor: health.cpuLoadFactor,
        memoryUsagePercent: health.memoryUsagePercent,
        availableMemoryMb: health.availableMemoryMb,
        reason: health.reason,
        slots: health.slots,
      },
      budget: {
        runCostUsd: this.budget.runCost,
        weekCostUsd: this.budget.weekCost,
        summary: this.budget.summary(),
      },
      concurrency: {
        current: this._activeJobs,
        target: this.adaptive.currentTarget,
        ceiling: this.adaptive.maxCeiling,
        smoothedCpuLoad: this.adaptive.currentSmoothedCpu,
      },
    };
    writeWorkerStatus(resolve(this.settings.workspaceRoot, '.forge'), status);
  }

  /**
   * Start the worker loop. Runs until:
   * - All jobs are processed and no more are queued
   * - Budget is exhausted
   * - SIGINT/SIGTERM received
   *
   * Fills available concurrency slots each tick using adaptive scaling.
   * When a job finishes, its slot opens for the next queued job.
   *
   * @param keepAlive If true, don't exit when the queue is empty — wait for new jobs.
   */
  async start(keepAlive = false): Promise<void> {
    this.budget.resetRun();
    this.resources.resetMetrics();

    // Recover any stuck jobs from a previous crash
    const recovered = this.queue.recoverStuck();
    if (recovered > 0) {
      console.log(chalk.yellow(`  Recovered ${recovered} stuck job(s) from previous run.`));
    }

    // Detect agents orphaned by a previous crash (OOM, SIGKILL, etc.)
    const orphans = this.eventLog.detectOrphans();
    if (orphans.length > 0) {
      console.log(chalk.yellow(`  Detected ${orphans.length} orphaned agent(s) from previous run:`));
      for (const o of orphans) {
        console.log(chalk.dim(`    - ${o.agentRole} [${o.runId}]${o.project ? ` (${o.project})` : ''}`));
      }
    }

    // Prune old completed jobs and stale logs, rotate event log
    const pruned = this.queue.prune();
    const prunedLogs = this.eventLog.pruneLogs();
    const rotated = this.eventLog.rotate(5000);
    if (pruned > 0 || prunedLogs > 0 || rotated > 0) {
      const parts = [];
      if (pruned > 0) parts.push(`${pruned} old job(s)`);
      if (prunedLogs > 0) parts.push(`${prunedLogs} old log(s)`);
      if (rotated > 0) parts.push(`~${rotated} old event(s) rotated`);
      console.log(chalk.dim(`  Pruned ${parts.join(', ')}.`));
    }

    let bannerPrinted = false;
    let lastIdleLog = 0;

    while (!this._shutdownRequested) {
      // Pause gate — sleep while paused, but keep the loop alive.
      // Still broadcast status so monitoring pane shows current state.
      if (this._paused) {
        try { this.broadcastStatus(); } catch { /* best-effort */ }
        await this.sleep(POLL_INTERVAL_MS);
        continue;
      }

      // Print the startup banner once when the worker first starts processing
      if (!bannerPrinted) {
        bannerPrinted = true;
        console.log(chalk.bold.green('\n  ▶ Worker enabled'));
        console.log(chalk.dim(`    Queue: ${this.queue.summaryString()}`));
        console.log(chalk.dim(`    Adaptive concurrency: target ${this.adaptive.currentTarget}, ceiling ${this.adaptive.maxCeiling}`));
        console.log();
        this.eventLog.emit({
          type: 'worker.start',
          summary: `Worker started (adaptive, ceiling=${this.adaptive.maxCeiling}). Queue: ${this.queue.summaryString()}`,
        });
      }

      // Rate limit gate — notify the session and pause instead of sleeping inline.
      // The session will schedule a resume timer and re-enable the worker.
      if (this._rateLimitResetAt > Date.now()) {
        const waitMs = this._rateLimitResetAt - Date.now();
        const resumeTime = new Date(this._rateLimitResetAt).toLocaleTimeString();
        console.log(chalk.yellow(`  ⏳ Rate limited — resuming at ${resumeTime} (${Math.ceil(waitMs / 1000)}s)`));

        if (this.onRateLimited) {
          // Session mode: delegate recovery to the session
          this.onRateLimited(this._rateLimitResetAt);
          this._paused = true;
          continue;
        }

        // Standalone worker mode: sleep inline
        await this.sleep(Math.min(waitMs + 2000, 600_000)); // +2s buffer, cap 10min
        this._rateLimitResetAt = 0;
        continue; // Re-check health before claiming
      }

      // Adaptive concurrency — evaluate how many agents the system can handle
      // based on CPU load, memory, and learned resource profiles.
      const pendingJobs = this.queue.queued().slice(0, 5).map(j => ({
        type: j.type, project: j.project ?? undefined,
      }));
      const concurrency = this.adaptive.evaluate(this._activeJobs, pendingJobs);

      // If throttled (critical pressure), wait for the system to recover
      if (concurrency.throttled && this._activeJobs > 0) {
        console.log(chalk.yellow(`  ⏳ ${concurrency.reason} — waiting for running agents to finish...`));
        await this.sleep(POLL_INTERVAL_MS * 2);
        continue;
      }

      // Fill available concurrency slots (up to adaptive target).
      // Scans through queued jobs to find eligible ones — skips jobs
      // blocked by project locks or resource slots instead of stopping
      // at the first blocked job. This allows cross-project parallelism.
      let claimedAny = false;
      while (this._activeJobs < concurrency.target && !this._shutdownRequested) {
        const queued = this.queue.queued();
        if (queued.length === 0) break;

        // Find the first eligible job in the queue
        let eligible: Job | null = null;
        let allBlocked = true;

        for (const candidate of queued) {
          // Per-project serialization for pr-fix jobs: only one fix at a time
          // per project to prevent parallel fixes from creating new conflicts.
          if (candidate.type === 'pr-fix' && candidate.project && this._projectFixLocks.has(candidate.project)) {
            continue; // Skip — this project already has a fix running
          }

          const requiredSlots = JOB_RESOURCE_SLOTS[candidate.type] ?? [];
          const blocked = requiredSlots.find((s) => !this.resources.hasCapacity(s));
          if (blocked) {
            if (!this._lastSlotBlockLogged || this._lastSlotBlockLogged !== blocked) {
              this._lastSlotBlockLogged = blocked;
              console.log(chalk.dim(`  ⏳ ${candidate.type} for ${candidate.project ?? '?'} waiting on "${blocked}" slot (${this.resources.slotSnapshot()[blocked]?.used ?? 0}/${this.resources.slotSnapshot()[blocked]?.capacity ?? '?'})`));
            }
            this.resources.recordBlock(blocked);
            continue; // Skip — try next job in queue
          }

          // Found an eligible job
          eligible = candidate;
          allBlocked = false;
          break;
        }

        if (!eligible) {
          // All queued jobs are blocked — nothing to claim this tick
          if (allBlocked) this._lastSlotBlockLogged = null;
          break;
        }
        this._lastSlotBlockLogged = null;

        // Claim this specific job from disk
        const job = this.queue.claimById(eligible.id);
        if (!job) break; // Race condition — someone else claimed it

        // Acquire all required resource slots
        const requiredSlots = JOB_RESOURCE_SLOTS[job.type] ?? [];
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
            console.log(chalk.dim(`  Cost: ${this.budget.summary()}\n`));
          } else {
            console.log(chalk.dim('  No jobs in queue. Nothing to do.\n'));
          }
          break;
        }

        // Keep-alive: run heartbeat to close the autonomous loop
        const now = Date.now();
        if (now - lastIdleLog > IDLE_LOG_INTERVAL_MS) {
          console.log(chalk.dim(`  [${new Date().toLocaleTimeString()}] Heartbeat — checking for merged PRs, unblocked work...`));
          await this.heartbeat();
          lastIdleLog = now;

          // If heartbeat queued new work, skip the poll sleep and claim immediately
          if (this.queue.hasWork()) continue;
          console.log(chalk.dim(`  [${new Date().toLocaleTimeString()}] Waiting for jobs... (${this.queue.summaryString()})`));
        }
      }

      // Detect no-progress spins: if jobs are queued but nothing actually ran
      // (e.g. all dependency-blocked), back off exponentially to avoid tight loops.
      if (this._processedCount === this._lastTickProcessed && this._activeJobs === 0 && claimedAny) {
        this._noProgressTicks++;
        // Back off: 10s, 20s, 30s... up to 60s between checks
        const backoffMs = Math.min(this._noProgressTicks * 10_000, 60_000);
        if (this._noProgressTicks === 1) {
          const queuedCount = this.queue.summary().queued;
          console.log(chalk.dim(`  [${new Date().toLocaleTimeString()}] ${queuedCount} job(s) waiting on dependencies — running heartbeat`));
          // Heartbeat may unblock work by syncing merged PRs or retrying failures
          if (keepAlive) await this.heartbeat();
        }
        await this.sleep(backoffMs);
        continue;
      }
      this._lastTickProcessed = this._processedCount;
      this._noProgressTicks = 0;

      // Broadcast status for UI panes and flush resource profiles before sleeping
      try { this.broadcastStatus(); } catch { /* best-effort */ }
      try { this.profiler.flush(); } catch { /* best-effort */ }

      // Poll interval — check for new jobs or finished slots
      await this.sleep(POLL_INTERVAL_MS);
    }

    // Wait for any in-flight jobs to finish before exiting
    if (this._inflightJobs.size > 0) {
      console.log(chalk.dim(`  Waiting for ${this._inflightJobs.size} in-flight job(s) to finish...`));
      await Promise.allSettled([...this._inflightJobs]);
    }

    // Clear status file so UI panes know the worker is off
    clearWorkerStatus(resolve(this.settings.workspaceRoot, '.forge'));

    this.eventLog.emit({
      type: 'worker.stop',
      summary: `Worker stopped. Processed: ${this._processedCount}. ${this.budget.summary()}`,
    });

    // Tuning report — log metrics and suggest slot capacity changes
    this.printTuningReport();
  }

  /**
   * Analyse resource usage from this run and print tuning recommendations.
   * Logs the full report as an event for future analysis. Only suggests
   * changes — never auto-applies. Targets ~75% machine utilisation.
   */
  private printTuningReport(): void {
    const report = this.resources.tuningReport();

    // Always log the full report as an event (for trend analysis over time)
    this.eventLog.emit({
      type: 'tuning.report',
      summary: `Peak CPU: ${(report.peakCpuLoadFactor * 100).toFixed(0)}% | Peak mem: ${(report.peakMemoryUsagePercent * 100).toFixed(0)}% | Healthy: ${report.healthySamples}/${report.totalSamples} samples`,
      data: {
        ...report,
        slotMetrics: report.slotMetrics as unknown as Record<string, unknown>,
        recommendations: report.recommendations as unknown as Record<string, unknown>[],
      } as unknown as Record<string, unknown>,
    });

    // Print metrics summary
    if (report.totalSamples > 0) {
      console.log(chalk.bold.blue('\n── Resource Tuning Report ──'));
      console.log(chalk.dim(`  Samples: ${report.totalSamples} | Healthy: ${report.healthySamples} (${(report.healthySamples / report.totalSamples * 100).toFixed(0)}%)`));
      console.log(chalk.dim(`  Peak CPU: ${(report.peakCpuLoadFactor * 100).toFixed(0)}% | Peak memory: ${(report.peakMemoryUsagePercent * 100).toFixed(0)}%`));

      for (const [name, metrics] of Object.entries(report.slotMetrics)) {
        const utilPct = metrics.totalSamples > 0 ? (metrics.activeSamples / metrics.totalSamples * 100).toFixed(0) : '0';
        console.log(chalk.dim(`  Slot "${name}": peak ${metrics.peakUsage}/${metrics.capacity} | active ${utilPct}% of time | ${metrics.blockCount} block(s)`));
      }
    }

    // Print recommendations (interactive — user decides)
    if (report.recommendations.length > 0) {
      console.log(chalk.yellow('\n  Tuning suggestions for forge.config.json:'));
      for (const rec of report.recommendations) {
        const arrow = rec.suggestedCapacity > rec.currentCapacity ? '↑' : '↓';
        console.log(chalk.yellow(`    ${arrow} ${rec.slot}: ${rec.currentCapacity} → ${rec.suggestedCapacity} — ${rec.reason}`));
      }

      // Show the exact JSON to merge into config
      const slotOverrides: Record<string, { capacity: number }> = {};
      for (const rec of report.recommendations) {
        slotOverrides[rec.slot] = { capacity: rec.suggestedCapacity };
      }
      console.log(chalk.dim('\n  Add to forge.config.json → "resourceSlots":'));
      console.log(chalk.dim(`  ${JSON.stringify(slotOverrides, null, 2).split('\n').join('\n  ')}`));
      console.log();
    } else if (report.totalSamples > 0) {
      console.log(chalk.green('  No tuning changes suggested — current config looks good.\n'));
    }
  }

  /**
   * Execute a job, incrementing/decrementing active count and processed count.
   * This runs as a detached promise — the main loop doesn't await it.
   */
  private async runJobAndTrack(job: Job): Promise<void> {
    // Acquire per-project fix lock
    if (job.type === 'pr-fix' && job.project) {
      this._projectFixLocks.add(job.project);
    }
    try {
      await this.executeJob(job);
    } finally {
      this._processedCount++;
      // Release per-project fix lock
      if (job.type === 'pr-fix' && job.project) {
        this._projectFixLocks.delete(job.project);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Execution
  // ═══════════════════════════════════════════════════════════════════

  private async executeJob(job: Job): Promise<void> {
    this._activeJobs++;
    const startTime = Date.now();

    // Snapshot baseline metrics before the job starts — used to calculate
    // the resource delta for the profiler after the job completes.
    const baselineHealth = this.resources.check();
    let jobSuccess = false;

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

      jobSuccess = true;
      this.queue.complete(job.id);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      this.eventLog.emit({
        type: 'job.complete',
        project: job.project ?? undefined,
        summary: `Job complete: ${job.type}${job.project ? ` for ${job.project}` : ''} (${elapsed}s)`,
        data: {
          durationMs: Date.now() - startTime,
          jobType: job.type,
        },
      });
    } catch (error) {
      // Deferred jobs go back in the queue — not completed, not failed
      if (error instanceof JobDeferred) {
        this.queue.unclaim(job.id);
        return;
      }

      const msg = error instanceof Error ? error.message : String(error);

      // Rate limit detection — re-queue instead of failing
      const resetAt = parseRateLimitReset(msg);
      if (resetAt) {
        this._rateLimitResetAt = Math.max(this._rateLimitResetAt, resetAt);
        this.queue.unclaim(job.id);
        const resumeTime = new Date(resetAt).toLocaleTimeString();
        console.log(chalk.yellow(`  ⚡ Rate limited on ${job.type}${job.project ? ` (${job.project})` : ''} — will resume at ${resumeTime}`));
        // Notify session so it can pause the worker and schedule resume
        this.onRateLimited?.(this._rateLimitResetAt);
        this.eventLog.emit({
          type: 'job.start', // reusing type since there's no 'job.ratelimited'
          project: job.project ?? undefined,
          summary: `Rate limited: ${job.type}${job.project ? ` for ${job.project}` : ''} — retry at ${resumeTime}`,
        });
      } else {
        this.queue.fail(job.id, msg);
        this.eventLog.emit({
          type: 'job.failed',
          project: job.project ?? undefined,
          summary: `Job failed: ${job.type}${job.project ? ` for ${job.project}` : ''}: ${msg}`,
        });
      }
    } finally {
      this._activeJobs--;
      // Release any resource slots held by this job
      this.resources.releaseAll(job.id);

      // Record resource observation for the profiler — builds per-project
      // resource usage knowledge over time for smarter scheduling.
      const endHealth = this.resources.check();
      const durationMs = Date.now() - startTime;
      const observation: ResourceObservation = {
        jobType: job.type,
        project: job.project ?? undefined,
        cpuLoadFactor: Math.max(0, endHealth.cpuLoadFactor - baselineHealth.cpuLoadFactor + 0.05),
        peakMemoryPercent: endHealth.memoryUsagePercent,
        memoryDeltaMb: Math.max(0, baselineHealth.availableMemoryMb - endHealth.availableMemoryMb),
        durationMs,
        success: jobSuccess,
        recordedAt: new Date().toISOString(),
      };
      try { this.profiler.record(observation); } catch { /* best-effort */ }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Type Executors
  // ═══════════════════════════════════════════════════════════════════

  private async executeRoadmapJob(job: Job): Promise<void> {
    const project = this.requireProject(job);
    const projectPath = resolveProjectPath(this.settings, project);
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
    const projectPath = resolveProjectPath(this.settings, project);
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
    for (const item of actionable) {
      // Reset stuck items
      if (item.status === 'in-progress' || item.status === 'failed') {
        item.status = 'pending';
        this.store.saveWorkItem(item);
      }

      this.queue.post('work-item', 'implementation', project, {
        workItemId: item.id,
      });
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

      // Dependency gate: if this PR depends on other PRs that are still open,
      // defer it. Reviewing/fixing dependent PRs before their parents merge
      // wastes effort — they'll have conflicts that resolve automatically
      // once the parent merges.
      const dependsOnPRs = (job.metadata.dependsOnPRs as number[] | undefined) ?? [];
      if (dependsOnPRs.length > 0) {
        try {
          const stillOpen = dependsOnPRs.filter((depPr) => {
            try {
              const depState = execSync(
                `gh pr view ${depPr} --repo ${repo} --json state --jq .state`,
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
              ).trim();
              return depState === 'OPEN';
            } catch { return false; } // Can't check — assume not blocking
          });
          if (stillOpen.length > 0) {
            console.log(chalk.dim(`  PR #${prNumber}: deferred — depends on open PR(s) ${stillOpen.map(n => `#${n}`).join(', ')}`));
            this.eventLog.emit({
              type: 'review.complete',
              project,
              summary: `PR #${prNumber} deferred: waiting for parent PR(s) ${stillOpen.join(', ')} to merge`,
            });
            return;
          }
        } catch { /* if dependency check fails, proceed anyway */ }
      }

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
        chainTipPR:    (job.metadata.chainTipPR as number | undefined),
        chainMembers:  (job.metadata.chainMembers as number[] | undefined),
      };

      const result = await runPRReviewStage(prReviewer, pr, this.settings.workspaceRoot, this.settings.projectsDir);
      await this.recordAgentCost();

      this.eventLog.emit({
        type: 'review.complete',
        project,
        summary: `PR #${prNumber} reviewed: ${result.output.slice(0, 120)}`,
      });

      // Parse the agent's output to decide the next step in the bounce cycle.
      //
      // Round 0 (initial review): DON'T auto-queue fix — let the user see the
      //   review and provide their own feedback first. This is one of the two
      //   interactive leverage points (roadmapping + PR review).
      //
      // Round 1+ (re-review after fix): Let it ride autonomously. The reviewer
      //   queues fixes, the fixer pushes and queues re-reviews, until either
      //   approved or MAX_FIX_ROUNDS is hit.
      //
      // "REVIEW POSTED: changes-requested" → queue pr-fix (round 1+) or pause (round 0)
      // "REVIEW POSTED: approved" → auto-merge if self-authored, otherwise nothing
      // "REVIEW DEFERRED" → will be re-queued on next `forge review` run
      // "FAILED" / other → no follow-up
      const MAX_FIX_ROUNDS = 3;
      const output = result.output;
      const currentRound = (job.metadata.fixRound as number | undefined) ?? 0;

      // Auto-merge: if approved AND we authored this PR, merge it.
      // Self-authored PRs must never use `gh pr review` (GitHub rejects self-reviews).
      // Instead we comment + merge directly.
      if (/REVIEW POSTED:\s*approved/i.test(output)) {
        try {
          const isMergeable = await this.isSelfAuthoredAndMergeable(prNumber, repo);
          if (isMergeable) {
            execSync(
              `gh pr merge ${prNumber} --repo ${repo} --squash --delete-branch`,
              { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
            );
            console.log(chalk.green(`  ✓ PR #${prNumber} (${project}) auto-merged`));
            this.eventLog.emit({
              type: 'pr.merged',
              project,
              summary: `PR #${prNumber} auto-merged (self-authored, approved, CI passing)`,
            });

            // Chain consolidation: if this was a chain tip, close ancestor PRs.
            // Their content is already included in the tip's branch, so merging
            // the tip lands everything. Ancestor branches are now stale.
            const ancestorPRs = (job.metadata.ancestorPRs as number[] | undefined) ?? [];
            if (ancestorPRs.length > 0) {
              this.closeAncestorPRs(ancestorPRs, repo, project, prNumber);
            }

            // Merge train: re-queue dependent PRs now that their parent merged.
            // These PRs were previously deferred by the dependency gate.
            // After the parent merges, GitHub updates their diff automatically —
            // re-reviewing them now shows only their unique delta.
            this.requeueDependentPRs(prNumber, repo, project, pr);
          }
        } catch (mergeErr) {
          const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          console.log(chalk.yellow(`  PR #${prNumber} approved but merge failed: ${mergeMsg.slice(0, 100)}`));
        }
        return;
      }

      if (/REVIEW POSTED:\s*changes-requested/i.test(output)) {
        const userTriaged = job.metadata.userTriaged as boolean | undefined;

        if (currentRound === 0 && !userTriaged) {
          // First review without prior triage — pause for human input
          console.log(chalk.cyan(`  PR #${prNumber}: initial review posted. Waiting for your feedback before auto-fixing.`));
          console.log(chalk.dim(`    To start the autonomous fix loop: forge fix ${prNumber} --project ${project}`));
          this.eventLog.emit({
            type: 'review.complete',
            project,
            summary: `PR #${prNumber} initial review posted — paused for user feedback`,
          });
        } else if (currentRound === 0 && userTriaged) {
          // User already triaged this PR via /review — auto-queue fix
          const userFeedback = job.metadata.userFeedback as string | undefined;
          const feedbackNote = userFeedback ? ` (with user feedback)` : '';
          console.log(chalk.cyan(`  PR #${prNumber}: initial review posted — auto-fixing (user-triaged${feedbackNote})`));
          this.queue.post('pr-fix', 'pr-fix' as JobPhase, project, {
            ...job.metadata,
            fixRound: 1,
            lastReviewedSha: currentRemoteSha || undefined,
          }, 12);
          this.eventLog.emit({
            type: 'review.complete',
            project,
            summary: `PR #${prNumber} initial review posted — auto-queued fix round 1 (user-triaged)`,
          });
        } else {
          const nextRound = currentRound + 1;
          if (nextRound > MAX_FIX_ROUNDS) {
            // Escalation alert — this PR needs human guidance
            console.log(chalk.bold.red(`\n  ALERT: PR #${prNumber} (${project}) hit ${MAX_FIX_ROUNDS} fix rounds without resolution.`));
            console.log(chalk.yellow(`  The reviewer and developer couldn't converge. This PR needs your guidance.`));
            console.log(chalk.dim(`    Review: https://github.com/${repo}/pull/${prNumber}`));
            console.log(chalk.dim(`    Resume: forge fix ${prNumber} --project ${project}\n`));
            this.eventLog.emit({
              type: 'review.complete',
              project,
              summary: `ALERT: PR #${prNumber} exceeded ${MAX_FIX_ROUNDS} fix rounds — needs human guidance`,
            });
          } else {
            // Autonomous loop — queue the fix
            console.log(chalk.dim(`  PR #${prNumber}: queuing fix round ${nextRound}/${MAX_FIX_ROUNDS}`));
            this.queue.post('pr-fix', 'pr-fix' as JobPhase, project, {
              ...job.metadata,
              fixRound: nextRound,
              lastReviewedSha: currentRemoteSha || undefined,
            }, 12);
          }
        }
      }
      return;
    }

    // Bulk scan — scan all projects for open PRs and post individual review jobs
    const openPRs = scanOpenPRs(this.settings.projects, this.settings.workspaceRoot, this.settings.projectsDir);
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

  /**
   * Chain consolidation: close ancestor PRs after the chain tip merges.
   * Their content was already included in the tip branch, so they're
   * effectively merged. We close them with a comment explaining why.
   */
  private closeAncestorPRs(
    ancestorPRs: number[],
    repo: string,
    project: string,
    tipPrNumber: number,
  ): void {
    console.log(chalk.cyan(`  Chain consolidation: closing ${ancestorPRs.length} ancestor PR(s) (content landed via PR #${tipPrNumber})`));

    for (const ancestorNum of ancestorPRs) {
      try {
        // Check if already closed/merged
        const state = execSync(
          `gh pr view ${ancestorNum} --repo ${repo} --json state --jq .state`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();

        if (state !== 'OPEN') {
          console.log(chalk.dim(`    PR #${ancestorNum}: already ${state.toLowerCase()}`));
          continue;
        }

        // Comment explaining the closure, then close
        const comment = `Closing: this PR's content was included in the consolidated chain tip PR #${tipPrNumber}, which has been merged. All changes from this branch were landed as part of that merge.`;
        execSync(
          `gh pr comment ${ancestorNum} --repo ${repo} --body "${comment}"`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        execSync(
          `gh pr close ${ancestorNum} --repo ${repo} --delete-branch`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );

        console.log(chalk.dim(`    PR #${ancestorNum}: closed (content in #${tipPrNumber})`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`    PR #${ancestorNum}: failed to close — ${msg.slice(0, 80)}`));
      }
    }

    this.eventLog.emit({
      type: 'pr.chain.closed',
      project,
      summary: `Chain consolidation: closed ${ancestorPRs.length} ancestor PR(s) after tip PR #${tipPrNumber} merged`,
    });
  }

  /**
   * Merge train: after a PR merges, re-queue review jobs for any PRs
   * that were waiting on it. This unblocks the dependency chain so
   * stacked branches get reviewed and merged in layer order automatically.
   */
  private requeueDependentPRs(
    mergedPrNumber: number,
    repo: string,
    project: string,
    mergedPr: { blocksPRs: number[] },
  ): void {
    const dependentPRs = mergedPr.blocksPRs;
    if (dependentPRs.length === 0) return;

    console.log(chalk.cyan(`  Merge train: PR #${mergedPrNumber} merged, re-queuing ${dependentPRs.length} dependent PR(s)`));

    for (const depPrNumber of dependentPRs) {
      try {
        // Fetch current metadata for the dependent PR
        const raw = execSync(
          `gh pr view ${depPrNumber} --repo ${repo} --json number,title,url,headRefName,state`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const depPr = JSON.parse(raw) as {
          number: number;
          title: string;
          url: string;
          headRefName: string;
          state: string;
        };

        // Skip if already merged/closed
        if (depPr.state !== 'OPEN') {
          console.log(chalk.dim(`    PR #${depPrNumber}: already ${depPr.state.toLowerCase()} — skipping`));
          continue;
        }

        // Queue a review job for this now-unblocked PR
        this.queue.post('review', 'review' as JobPhase, project, {
          prNumber: depPr.number,
          prTitle: depPr.title,
          prUrl: depPr.url,
          branch: depPr.headRefName,
          repo,
          project,
          mergeLayer: 0, // Recalculated on next full scan; safe to set 0 since parent merged
          dependsOnPRs: [],
          blocksPRs: [],
          uniqueHeadSha: '',
        }, 6); // Slightly lower priority than foundation (5) so new scans take precedence

        console.log(chalk.dim(`    PR #${depPrNumber}: queued for review (${depPr.title})`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`    PR #${depPrNumber}: failed to re-queue — ${msg.slice(0, 80)}`));
      }
    }

    this.eventLog.emit({
      type: 'review.scan',
      project,
      summary: `Merge train: PR #${mergedPrNumber} merged, re-queued ${dependentPRs.length} dependent PR(s)`,
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
    const projectPath = resolveProjectPath(this.settings, project);

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
    } catch {
      console.log(chalk.yellow(`  Worktree creation failed for PR #${prNumber}, falling back to main checkout`));
    }

    const fixCwd = useWorktree ? worktreeDir : projectPath;

    const userFeedback = job.metadata.userFeedback as string | undefined;
    const userFeedbackBlock = userFeedback ? `
## User Direction (from triage)

The user provided this feedback during interactive triage — prioritise it:

> ${userFeedback}

` : '';

    const isChainTip = job.metadata.isChainTip as boolean | undefined;
    const ancestorPRs = (job.metadata.ancestorPRs as number[] | undefined) ?? [];
    const chainBlock = isChainTip ? `
## Chain Consolidation Context

This is the **tip PR of a ${ancestorPRs.length + 1}-PR chain**. Your branch contains
all commits from ancestor PRs: ${ancestorPRs.map((n) => `#${n}`).join(', ')}.
After this PR is approved and merged, those ancestor PRs will be closed automatically.

Fix ALL issues across the entire chain's codebase, not just this PR's unique delta.
The goal is to get this branch into a mergeable, approved state that lands everything.
` : '';

    const prompt = `You are fixing PR #${prNumber} in ${repo} (fix round ${fixRound}).

## PR Details
- Branch: ${branch}
- Repo: ${repo}
- Project: ${project}
- Fix round: ${fixRound}
${userFeedbackBlock}${chainBlock}
## Local-First Fix Workflow

All work happens locally in your worktree. Fix everything, verify it passes,
then push once at the end. Never push partial or broken state.

### Step 1: Sync with main
\`\`\`bash
git fetch origin main
git merge origin/main --no-edit 2>&1 || echo "MERGE_CONFLICT"
\`\`\`
If merge conflicts exist, resolve them. You wrote this code — use the project's
CLAUDE.md, core values, and test suite to decide the right resolution.
After resolving: \`git add <resolved files> && git commit -m "fix: resolve merge conflicts with main"\`

### Step 2: Gather all feedback
Collect everything that needs fixing before making any changes:

a) **CI failures** — often the real blocker:
   \`\`\`bash
   gh pr checks ${prNumber} --repo ${repo} 2>&1
   # If any checks failed, get failure logs:
   # gh run view <run-id> --repo ${repo} --log-failed 2>&1 | tail -80
   \`\`\`

b) **Review comments**:
   \`gh api repos/${repo}/issues/${prNumber}/comments --jq '.[-5:] | .[] | {user: .user.login, body: .body[:500]}'\`

c) **PR review threads** (inline comments):
   \`gh api repos/${repo}/pulls/${prNumber}/comments --jq '.[-5:] | .[] | {user: .user.login, path: .path, body: .body[:500]}'\`

### Step 3: Fix everything locally
- Address ALL identified issues: CI failures, review comments, merge conflicts.
- If CI fails due to missing tooling in workflow config, fix the workflow file.
- If tests fail, fix the code (not the tests, unless tests are wrong).
- Do not refactor or add features beyond what's needed to resolve feedback.

### Step 4: Verify locally before pushing
Run the project's full test suite and linter. Do NOT push until tests pass:
\`\`\`bash
# Discover and run the project's test/lint commands from package.json, Makefile, etc.
\`\`\`
If tests fail after your fixes, debug and fix again. Do not push broken code.

### Step 5: Push once, clean
\`\`\`bash
git add <changed files>
git commit -m "fix: address review feedback on PR #${prNumber}

- <specific fix 1>
- <specific fix 2>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push origin ${branch}
\`\`\`

### Step 6: Verify push landed (MANDATORY)
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

    // Skip items that are already done or blocked
    if (workItem.status === 'completed' || workItem.status === 'blocked') {
      return;
    }

    // Check dependencies before executing
    const deps = workItem.dependsOn ?? [];
    if (deps.length > 0) {
      const allItems = this.store.getWorkItemsByProject(workItem.project);
      const completedIds = new Set(allItems.filter((i) => i.status === 'completed').map((i) => i.id));
      const unmet = deps.filter((dep) => !completedIds.has(dep));
      if (unmet.length > 0) {
        throw new JobDeferred(`Waiting on: ${unmet.map(d => d.split('/').pop()).join(', ')}`);
      }
    }

    const projectPath = resolveProjectPath(this.settings, workItem.project);
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

  /**
   * Check if a PR was authored by us (the GitHub authenticated user) and is
   * in a mergeable state (CI passing, no conflicts). Only self-authored PRs
   * should be auto-merged — we must never `gh pr review` our own PRs.
   */
  private async isSelfAuthoredAndMergeable(prNumber: number, repo: string): Promise<boolean> {
    try {
      const json = execSync(
        `gh pr view ${prNumber} --repo ${repo} --json author,mergeable,mergeStateStatus,statusCheckRollup`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const pr = JSON.parse(json) as {
        author: { login: string };
        mergeable: string;
        mergeStateStatus: string;
        statusCheckRollup?: Array<{ conclusion: string }>;
      };

      // Get the current authenticated user
      const currentUser = execSync('gh api user --jq .login', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (pr.author.login !== currentUser) return false;
      if (pr.mergeable !== 'MERGEABLE') return false;

      // Check CI — all checks must pass (or no checks configured)
      const checks = pr.statusCheckRollup ?? [];
      const hasFailures = checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR');
      if (hasFailures) return false;

      // mergeStateStatus must be CLEAN or UNSTABLE (warnings-only)
      if (pr.mergeStateStatus !== 'CLEAN' && pr.mergeStateStatus !== 'UNSTABLE') return false;

      return true;
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Heartbeat — autonomous cycle continuation (daemon mode only)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Heartbeat runs between job batches in daemon mode. It closes the
   * autonomous loop by:
   * 1. Detecting merged PRs and completing their work items
   * 2. Retrying failed work items (with a cap to prevent infinite retries)
   * 3. Queueing newly-unblocked work items
   *
   * Without this, the worker drains its queue and sits idle even though
   * merged PRs have unblocked downstream work.
   */
  private async heartbeat(): Promise<void> {
    const { scanOpenPRs } = await import('../workflow/stages/review-prs.js');

    // 1. Sync merged PRs → complete work items
    let mergedCount = 0;
    for (const project of this.settings.projects) {
      const items = this.store.getWorkItemsByProject(project);
      const reviewItems = items.filter(
        (i) => i.stage === 'review' && i.status !== 'completed',
      );

      for (const item of reviewItems) {
        // If a work item is in review stage but its PR was merged, mark it done.
        const prOutput = item.stageOutputs.pr;
        const prUrl = prOutput?.summary?.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        if (!prUrl) continue;

        const prNumber = parseInt(prUrl[1], 10);
        const projectPath = resolveProjectPath(this.settings, project);
        try {
          const state = execSync(
            `gh pr view ${prNumber} --json state --jq .state`,
            { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();

          if (state === 'MERGED') {
            item.status = 'completed';
            item.stage = 'review';
            item.updatedAt = new Date().toISOString();
            this.store.saveWorkItem(item);
            mergedCount++;
          }
        } catch { /* can't check — skip */ }
      }
    }

    if (mergedCount > 0) {
      console.log(chalk.green(`  ♻ Heartbeat: ${mergedCount} work item(s) completed (PR merged)`));
      this.eventLog.emit({
        type: 'heartbeat.sync',
        summary: `Synced ${mergedCount} merged PR(s) → work items completed`,
      });
    }

    // 2. Auto-merge self-authored PRs that are ready.
    //
    // Merge in order: lowest mergeLayer first (base PRs before tips).
    // After each merge, requeue fix jobs for remaining PRs in that project
    // since the merge changes the base and may resolve or create conflicts.
    const openPRs = scanOpenPRs(this.settings.projects, this.settings.workspaceRoot, this.settings.projectsDir);
    const mergeOrder = [...openPRs].sort((a, b) => (a.mergeLayer ?? 0) - (b.mergeLayer ?? 0));
    let autoMerged = 0;
    const mergedProjects = new Set<string>();

    for (const pr of mergeOrder) {
      try {
        const isMergeable = await this.isSelfAuthoredAndMergeable(pr.number, pr.repo);
        if (!isMergeable) continue;

        // Only require no *unmerged* dependencies — a dependency that was
        // just merged in this heartbeat cycle should not block us.
        const hasBlockingDeps = pr.dependsOnPRs.some((depPR) =>
          openPRs.some((op) => op.number === depPR && !mergedProjects.has(`${op.repo}#${op.number}`)),
        );
        if (hasBlockingDeps) continue;

        execSync(
          `gh pr merge ${pr.number} --repo ${pr.repo} --squash --delete-branch`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        console.log(chalk.green(`  ✓ Heartbeat: auto-merged PR #${pr.number} (${pr.project})`));
        mergedProjects.add(`${pr.repo}#${pr.number}`);
        autoMerged++;
      } catch { /* merge failed — will retry next heartbeat */ }
    }
    if (autoMerged > 0) {
      this.eventLog.emit({
        type: 'heartbeat.merge',
        summary: `Auto-merged ${autoMerged} self-authored PR(s)`,
      });

      // Cascade: requeue fix jobs for remaining open PRs in merged projects.
      // Merging changes the base branch — remaining PRs likely need conflict
      // resolution or at minimum a re-review to verify they're still clean.
      const remainingPRs = openPRs.filter(
        (pr) => !mergedProjects.has(`${pr.repo}#${pr.number}`),
      );
      const projectsToRefix = new Set(
        [...mergedProjects].map((key) => {
          const match = openPRs.find((p) => `${p.repo}#${p.number}` === key);
          return match?.project;
        }).filter(Boolean) as string[],
      );

      let cascadeQueued = 0;
      for (const pr of remainingPRs) {
        if (!projectsToRefix.has(pr.project)) continue;

        // Don't double-queue if a fix or review job already exists for this PR
        const existing = this.queue.all().find(
          (j) => (j.type === 'pr-fix' || j.type === 'review')
            && j.metadata.prNumber === pr.number
            && (j.status === 'queued' || j.status === 'running'),
        );
        if (existing) continue;

        this.queue.post('pr-fix', 'review' as JobPhase, pr.project, {
          prNumber: pr.number,
          branch: pr.branch,
          repo: pr.repo,
          fixRound: 1,
          userTriaged: true,
        }, 12);
        cascadeQueued++;
      }
      if (cascadeQueued > 0) {
        console.log(chalk.blue(`  ♻ Heartbeat: queued ${cascadeQueued} cascade fix(es) after merge`));
        this.eventLog.emit({
          type: 'heartbeat.queue',
          summary: `Cascade: queued ${cascadeQueued} fix job(s) for PRs in projects where a PR just merged`,
        });
      }
    }

    // 3. Retry failed work items (max 2 retries tracked via blockReason)
    const MAX_RETRIES = 2;
    let retriedCount = 0;
    for (const project of this.settings.projects) {
      const items = this.store.getWorkItemsByProject(project);
      const failed = items.filter((i) => i.status === 'failed');

      for (const item of failed) {
        const retryCount = (item.blockReason?.match(/\[retry (\d+)\]/)?.[1] ?? '0');
        const retries = parseInt(retryCount, 10);
        if (retries >= MAX_RETRIES) continue;

        item.status = 'pending';
        item.blockReason = `[retry ${retries + 1}] ${item.blockReason ?? ''}`.trim();
        item.updatedAt = new Date().toISOString();
        this.store.saveWorkItem(item);
        retriedCount++;
      }
    }
    if (retriedCount > 0) {
      console.log(chalk.yellow(`  ♻ Heartbeat: reset ${retriedCount} failed work item(s) for retry`));
      this.eventLog.emit({
        type: 'heartbeat.retry',
        summary: `Reset ${retriedCount} failed work item(s) for retry`,
      });
    }

    // 4. Queue newly-unblocked work items
    let queuedCount = 0;
    for (const project of this.settings.projects) {
      const items = this.store.getWorkItemsByProject(project);
      const completedIds = new Set(
        items.filter((i) => i.status === 'completed').map((i) => i.id),
      );
      const actionable = items.filter(
        (i) => i.status === 'pending' && i.stage !== 'review',
      );

      for (const item of actionable) {
        const deps = item.dependsOn ?? [];
        const allDepsMet = deps.length === 0 || deps.every((d) => completedIds.has(d));
        if (!allDepsMet) continue;

        // Check if a work-item job already exists for this item
        const existing = this.queue.all().find(
          (j) => j.type === 'work-item'
            && j.metadata.workItemId === item.id
            && (j.status === 'queued' || j.status === 'running'),
        );
        if (existing) continue;

        this.queue.post('work-item', 'implementation', project, {
          workItemId: item.id,
        });
        queuedCount++;
      }
    }
    if (queuedCount > 0) {
      console.log(chalk.blue(`  ♻ Heartbeat: queued ${queuedCount} newly-unblocked work item(s)`));
      this.eventLog.emit({
        type: 'heartbeat.queue',
        summary: `Queued ${queuedCount} unblocked work item(s)`,
      });
    }

    // 5. Clean up local branches for merged/closed PRs.
    //    Remote branches are handled by --delete-branch on merge/close.
    //    Local branches accumulate silently, creating clutter and confusion.
    this.pruneLocalBranches();
  }

  /**
   * Delete local branches whose remote tracking branch no longer exists.
   * These are branches from merged or closed PRs where --delete-branch
   * already removed the remote ref.
   */
  private pruneLocalBranches(): void {
    for (const project of this.settings.projects) {
      const projectPath = resolveProjectPath(this.settings, project);
      try {
        // Fetch and prune remote tracking refs
        execSync('git fetch --prune', {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Find local branches with a gone remote
        const branches = execSync(
          "git branch -vv | grep ': gone]' | awk '{print $1}'",
          { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();

        if (!branches) continue;

        for (const branch of branches.split('\n').filter(Boolean)) {
          // Never delete the default branch
          if (branch === 'main' || branch === 'master') continue;
          try {
            execSync(`git branch -D "${branch}"`, {
              cwd: projectPath,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch { /* branch might be checked out — skip */ }
        }
      } catch { /* git errors in this project — skip */ }
    }
  }

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
