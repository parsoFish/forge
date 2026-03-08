/**
 * Status bar — periodic status line + enriched prompt.
 *
 * WHY NOT scroll regions: Scroll regions (CSI Ps;Ps r) fight with readline's
 * own cursor management and the OutputInterceptor's clear-line/redraw pattern.
 * Three cursor managers = flickering and corrupted input. We tried it, it broke.
 *
 * This approach instead:
 * - The readline prompt itself shows live status (updated every 3s by session)
 * - A periodic status summary line prints via console.log (interceptor-safe)
 * - Agent messages scroll naturally through the OutputInterceptor
 *
 * The result is clean, jank-free, and works in every terminal.
 */

import chalk from 'chalk';
import type { Worker } from '../jobs/worker.js';

/** How often to print a status summary line (ms). */
const STATUS_INTERVAL_MS = 10_000;

export class StatusBar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private lastStatusLine = '';

  constructor(
    private readonly worker: Worker,
  ) {}

  /**
   * Start printing periodic status lines.
   */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.timer = setInterval(() => this.printStatusLine(), STATUS_INTERVAL_MS);
  }

  /**
   * Stop printing status lines.
   */
  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the status bar is currently active. */
  get isActive(): boolean {
    return this.enabled;
  }

  /** Toggle on/off. */
  toggle(): void {
    if (this.enabled) {
      this.stop();
    } else {
      this.start();
    }
  }

  /**
   * Build a compact status string for use in the readline prompt.
   * Called by the session to build the enriched prompt line.
   */
  buildPromptStatus(): string {
    const queue = this.worker.jobQueue;
    const budget = this.worker.budgetTracker;

    const summary = queue.summary();
    const parts: string[] = [];
    if (summary.running > 0) parts.push(chalk.yellow(`${summary.running} run`));
    if (summary.queued > 0) parts.push(chalk.blue(`${summary.queued} queue`));
    if (summary.failed > 0) parts.push(chalk.red(`${summary.failed} fail`));

    // Show active slot usage (hide zero-count)
    const slots = this.worker.resourceMonitor.slotSnapshot();
    for (const [name, info] of Object.entries(slots)) {
      if (info.used > 0) {
        const color = info.used >= info.capacity ? chalk.red : chalk.yellow;
        parts.push(color(`${name}:${info.used}/${info.capacity}`));
      }
    }

    const cost = budget.runCost;
    if (cost > 0) {
      parts.push(chalk.dim(`$${cost.toFixed(2)}`));
    }

    return parts.length > 0 ? parts.join(chalk.dim(' | ')) : chalk.dim('idle');
  }

  /**
   * Force a redraw — no-op in this implementation since we don't own the screen.
   * Kept for API compatibility with /clear command.
   */
  redraw(): void {
    // The prompt is redrawn by session.updatePrompt() on its timer.
    // Nothing to do here.
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Print a compact status summary line into the scrolling output.
   * Goes through console.log so the OutputInterceptor handles it cleanly.
   */
  private printStatusLine(): void {
    if (!this.enabled) return;

    const line = this.buildStatusLine();

    // Don't print duplicate status lines (nothing changed)
    if (line === this.lastStatusLine) return;
    this.lastStatusLine = line;

    console.log(line);
  }

  private buildStatusLine(): string {
    const queue = this.worker.jobQueue;
    const resources = this.worker.resourceMonitor;
    const budget = this.worker.budgetTracker;

    const summary = queue.summary();
    const slots = resources.slotSnapshot();
    const width = Math.min(process.stdout.columns ?? 80, 100);

    // Job counts
    const parts: string[] = [];
    if (summary.running > 0) parts.push(chalk.yellow(`${summary.running} running`));
    if (summary.queued > 0) parts.push(chalk.blue(`${summary.queued} queued`));
    if (summary.failed > 0) parts.push(chalk.red(`${summary.failed} failed`));
    if (summary.completed > 0) parts.push(chalk.dim(`${summary.completed} done`));

    // Slot usage — only show slots with active usage
    const slotParts: string[] = [];
    for (const [name, info] of Object.entries(slots)) {
      if (info.used > 0) {
        const color = info.used >= info.capacity ? chalk.red : info.used > 0 ? chalk.yellow : chalk.dim;
        slotParts.push(color(`${name}:${info.used}/${info.capacity}`));
      }
    }

    // Budget
    const budgetStr = `$${budget.runCost.toFixed(2)}`;

    const content = [
      parts.join(chalk.dim(' | ')),
      slotParts.join(' '),
      chalk.dim(budgetStr),
    ].filter(Boolean).join(chalk.dim('  '));

    // Render as a separator-style line
    const stripped = content.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = Math.max(0, width - stripped.length - 4);
    return chalk.dim('──') + ' ' + content + ' ' + chalk.dim('─'.repeat(pad));
  }
}
