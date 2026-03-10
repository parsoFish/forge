/**
 * Monitoring pane — compact live system health display.
 *
 * Reads `.forge/worker-status.json` every 2s and renders everything
 * in a single compact view designed to fit a small tmux pane (~12 rows).
 *
 * Shows: worker state, jobs, CPU, memory, slots, budget — all inline.
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { readWorkerStatus } from './worker-status-file.js';
import { loadSettings } from '../config/index.js';
import { getAdaptiveIntervalMs } from './render-throttle.js';
import { DiffRenderer } from './diff-renderer.js';

function bar(ratio: number, width = 12): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const color = ratio > 0.85 ? chalk.red : ratio > 0.6 ? chalk.yellow : chalk.green;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function buildLines(forgeRoot: string): string[] {
  const status = readWorkerStatus(forgeRoot);
  const lines: string[] = [];

  lines.push(chalk.bold(' MONITOR') + chalk.dim('  ' + new Date().toLocaleTimeString()));
  lines.push(chalk.dim(' ─'.repeat(20)));

  if (!status) {
    lines.push(chalk.dim('  Worker: ') + chalk.red.bold('OFF'));
    lines.push(chalk.dim('  Use /worker on in the main pane'));
    return lines;
  }

  const stateColor = {
    'running': chalk.green.bold,
    'paused': chalk.yellow.bold,
    'rate-limited': chalk.red.bold,
    'off': chalk.dim,
  }[status.state] ?? chalk.dim;

  // Worker state + jobs on one compact block
  lines.push(chalk.dim('  Worker  ') + stateColor(status.state.toUpperCase()));

  if (status.state === 'rate-limited' && status.rateLimitResetAt) {
    const waitSec = Math.max(0, Math.ceil((status.rateLimitResetAt - Date.now()) / 1000));
    lines.push(chalk.dim('  Resets  ') + chalk.yellow(`${waitSec}s`));
  }

  // Jobs — single line
  const failStr = status.queue.failed > 0 ? chalk.red(` ${status.queue.failed}✗`) : '';
  lines.push(chalk.dim('  Jobs    ') +
    chalk.white.bold(String(status.activeJobs)) + chalk.dim(' run') +
    chalk.dim(' / ') + chalk.white(String(status.queue.queued)) + chalk.dim(' queue') +
    chalk.dim(' / ') + chalk.green(String(status.processedCount)) + chalk.dim(' done') + failStr
  );

  // Adaptive concurrency — how many agents the system is targeting
  if (status.concurrency) {
    const c = status.concurrency;
    const smoothCpu = (c.smoothedCpuLoad * 100).toFixed(0);
    lines.push(chalk.dim('  Scale ') +
      chalk.white.bold(String(c.current)) + chalk.dim('/') +
      chalk.cyan(String(c.target)) + chalk.dim(` (max ${c.ceiling})`) +
      chalk.dim(`  avg CPU ${smoothCpu}%`));
  }

  // CPU + Memory — compact with inline bars
  const cpuPct = (status.resources.cpuLoadFactor * 100).toFixed(0);
  const memPct = (status.resources.memoryUsagePercent * 100).toFixed(0);
  const memFree = status.resources.availableMemoryMb.toFixed(0);
  lines.push(chalk.dim('  CPU   ') + bar(status.resources.cpuLoadFactor) + ` ${cpuPct}%`);
  lines.push(chalk.dim('  Mem   ') + bar(status.resources.memoryUsagePercent) + ` ${memPct}% (${memFree}MB)`);

  if (!status.resources.healthy && status.resources.reason) {
    lines.push(chalk.red(`  ⚠ ${status.resources.reason.slice(0, 50)}`));
  }

  // Slots — inline, only show if any are in use
  const slots = Object.entries(status.resources.slots);
  const usedSlots = slots.filter(([, { used }]) => used > 0);
  if (usedSlots.length > 0) {
    const slotStr = usedSlots.map(([name, { used, capacity }]) => `${name}:${used}/${capacity}`).join(' ');
    lines.push(chalk.dim('  Slots ') + slotStr);
  }

  // API-equivalent cost — does NOT reflect actual plan usage.
  // Subscriptions meter by tokens/requests, not dollars.
  lines.push(chalk.dim('  API~  ') + chalk.dim(status.budget.summary));
  lines.push(chalk.dim('        ') + chalk.dim.italic('est. cost, not plan usage'));

  return lines;
}

export function startMonitorPane(workspaceRoot?: string): void {
  const settings = loadSettings(workspaceRoot);
  const forgeRoot = resolve(settings.workspaceRoot, '.forge');

  const rows = process.stdout.rows ?? 24;
  const cols = process.stdout.columns ?? 40;
  const diffRenderer = new DiffRenderer(rows, cols, (data) => process.stdout.write(data));

  process.stdout.write('\x1b[?25l');
  process.on('exit', () => process.stdout.write('\x1b[?25h'));
  process.on('SIGINT', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });
  process.on('SIGTERM', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });

  const renderFrame = (): void => {
    const currentRows = process.stdout.rows ?? 24;
    const currentCols = process.stdout.columns ?? 40;
    diffRenderer.resize(currentRows, currentCols);

    diffRenderer.render(buildLines(forgeRoot));
  };

  const scheduleNextRender = (): void => {
    const interval = getAdaptiveIntervalMs();
    setTimeout(() => {
      renderFrame();
      scheduleNextRender();
    }, interval);
  };

  renderFrame();
  scheduleNextRender();
}
