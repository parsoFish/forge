/**
 * Agent pool — manages concurrent agent subprocesses.
 *
 * Inspired by Ralph's parallel loop system: isolates agents but shares
 * coordination state. Limits concurrency to prevent API rate limiting
 * and machine overload.
 *
 * The pool is the bridge between the orchestrator (conductor) and the
 * individual agent runs. It handles:
 * - Concurrency limiting (max N agents at once)
 * - Queuing excess work
 * - Real-time output routing to the event log
 * - Cancellation propagation for graceful shutdown
 */

import chalk from 'chalk';
import { AgentRun } from '../agents/runner.js';
import type { AgentInvocation, AgentResult } from '../agents/types.js';
import { EventLog } from '../events/event-log.js';

export interface PoolTask {
  /** Unique task ID */
  readonly id: string;
  /** Human-readable label for display */
  readonly label: string;
  /** The agent invocation to run */
  readonly invocation: AgentInvocation;
  /** Callback when complete */
  readonly resolve: (result: AgentResult) => void;
}

export interface PoolStatus {
  readonly running: number;
  readonly queued: number;
  readonly completed: number;
  readonly maxConcurrency: number;
  readonly activeRuns: Array<{
    readonly runId: string;
    readonly label: string;
    readonly agentRole: string;
    readonly elapsedMs: number;
  }>;
}

/**
 * Manages a pool of concurrent agent runs.
 */
export class AgentPool {
  private readonly maxConcurrency: number;
  private readonly activeRuns = new Map<string, { run: AgentRun; label: string; startTime: number }>();
  private readonly queue: PoolTask[] = [];
  private completedCount = 0;
  private totalCostUsd = 0;
  private _shuttingDown = false;
  private readonly eventLog: EventLog;

  constructor(maxConcurrency: number, eventLog: EventLog) {
    this.maxConcurrency = maxConcurrency;
    this.eventLog = eventLog;
  }

  /**
   * Submit an agent invocation to the pool.
   * Returns a promise that resolves when the agent completes.
   * If the pool is at capacity, the task is queued.
   */
  submit(label: string, invocation: AgentInvocation): Promise<AgentResult> {
    return new Promise<AgentResult>((resolve) => {
      const taskId = `${invocation.agent.role}-${Date.now()}`;
      const task: PoolTask = { id: taskId, label, invocation, resolve };

      if (this._shuttingDown) {
        resolve({
          success: false,
          output: 'Pool is shutting down — task rejected',
          filesChanged: [],
          durationMs: 0,
          escalate: false,
        });
        return;
      }

      if (this.activeRuns.size < this.maxConcurrency) {
        this.startTask(task);
      } else {
        this.queue.push(task);
        this.eventLog.emit({
          type: 'agent.spawn',
          agentRole: invocation.agent.role,
          summary: `Queued: ${label} (${this.queue.length} in queue, ${this.activeRuns.size} running)`,
        });
        console.log(chalk.dim(`  ⏳ Queued: ${label} (${this.queue.length} in queue)`));
      }
    });
  }

  /**
   * Get current pool status.
   */
  status(): PoolStatus {
    const now = Date.now();
    return {
      running: this.activeRuns.size,
      queued: this.queue.length,
      completed: this.completedCount,
      maxConcurrency: this.maxConcurrency,
      activeRuns: Array.from(this.activeRuns.entries()).map(([, { run, label, startTime }]) => ({
        runId: run.runId,
        label,
        agentRole: run.agentRole,
        elapsedMs: now - startTime,
      })),
    };
  }

  /** Total cost across all runs so far. */
  get cost(): number { return this.totalCostUsd; }

  /** Whether the pool is shutting down. */
  get shuttingDown(): boolean { return this._shuttingDown; }

  /**
   * Wait for all active and queued tasks to complete.
   */
  async drain(): Promise<void> {
    while (this.activeRuns.size > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * Cancel all active runs and clear the queue (graceful shutdown).
   */
  shutdown(): void {
    this._shuttingDown = true;

    // Clear the queue — resolve queued tasks as cancelled
    for (const task of this.queue) {
      task.resolve({
        success: false,
        output: 'Cancelled: pool shutting down',
        filesChanged: [],
        durationMs: 0,
        escalate: false,
      });
    }
    this.queue.length = 0;

    // Cancel active runs
    for (const [, { run }] of this.activeRuns) {
      run.cancel();
    }

    this.eventLog.emit({
      type: 'shutdown.requested',
      summary: `Pool shutdown: cancelled ${this.activeRuns.size} active runs`,
    });
  }

  // --- Internal ---

  private startTask(task: PoolTask): void {
    const run = new AgentRun(task.invocation);
    const startTime = Date.now();

    this.activeRuns.set(run.runId, { run, label: task.label, startTime });

    // Log the spawn
    this.eventLog.emit({
      type: 'agent.spawn',
      agentRole: task.invocation.agent.role,
      runId: run.runId,
      summary: `Started: ${task.label} [${run.runId}]`,
    });
    this.eventLog.openRunLog(run.runId);

    console.log(chalk.cyan(`  ▶ ${task.label} [${run.agentRole}] started (${this.activeRuns.size}/${this.maxConcurrency} slots)`));

    // Wire up streaming events to the event log and console
    run.on('tool_use', (data: { tool: string; input: string }) => {
      this.eventLog.writeRunLog(run.runId, { type: 'tool_use', ...data });
      this.eventLog.emit({
        type: 'agent.tool_use',
        agentRole: run.agentRole,
        runId: run.runId,
        summary: `${task.label}: ${data.tool}`,
        data: data as unknown as Record<string, unknown>,
      });
      console.log(chalk.dim(`    🔧 [${run.agentRole}] ${data.tool}`));
    });

    run.on('text', (data: { text: string }) => {
      this.eventLog.writeRunLog(run.runId, { type: 'text', text: data.text.slice(0, 500) });
      // Only log short text snippets to console to avoid flooding
      if (data.text.length < 200) {
        console.log(chalk.dim(`    📝 [${run.agentRole}] ${data.text.slice(0, 120)}`));
      }
    });

    run.on('cost', (data: { totalCostUsd: number; durationMs: number; numTurns: number }) => {
      this.totalCostUsd += data.totalCostUsd;
      this.eventLog.emit({
        type: 'agent.cost',
        agentRole: run.agentRole,
        runId: run.runId,
        summary: `${task.label}: $${data.totalCostUsd.toFixed(4)} / ${data.numTurns} turns / ${(data.durationMs / 1000).toFixed(1)}s`,
        data: data as unknown as Record<string, unknown>,
      });
      console.log(
        chalk.yellow(`    💰 [${run.agentRole}] $${data.totalCostUsd.toFixed(4)} | ${data.numTurns} turns | ${(data.durationMs / 1000).toFixed(1)}s`),
      );
    });

    run.on('error', (err: Error) => {
      this.eventLog.emit({
        type: 'agent.error',
        agentRole: run.agentRole,
        runId: run.runId,
        summary: `Error in ${task.label}: ${err.message}`,
      });
      console.log(chalk.red(`    ✗ [${run.agentRole}] Error: ${err.message.slice(0, 200)}`));
    });

    run.on('done', (result: AgentResult) => {
      this.activeRuns.delete(run.runId);
      this.completedCount++;

      this.eventLog.writeRunLog(run.runId, {
        type: 'result',
        success: result.success,
        output: result.output.slice(0, 1000),
        durationMs: result.durationMs,
      });
      this.eventLog.closeRunLog(run.runId);

      this.eventLog.emit({
        type: 'agent.result',
        agentRole: run.agentRole,
        runId: run.runId,
        summary: `${result.success ? 'Completed' : 'Failed'}: ${task.label} (${(result.durationMs / 1000).toFixed(1)}s)`,
      });

      const icon = result.success ? '✓' : '✗';
      const color = result.success ? chalk.green : chalk.red;
      console.log(color(`  ${icon} ${task.label} [${run.agentRole}] done (${(result.durationMs / 1000).toFixed(1)}s)`));

      task.resolve(result);

      // Dequeue next task if available
      this.dequeue();
    });

    // Start the actual subprocess
    run.start();
  }

  private dequeue(): void {
    if (this._shuttingDown) return;
    while (this.queue.length > 0 && this.activeRuns.size < this.maxConcurrency) {
      const next = this.queue.shift();
      if (next) {
        this.startTask(next);
      }
    }
  }
}
