/**
 * Job queue pane — live job queue display with priority bumping.
 *
 * Reads `.forge/jobs/*.json` every 2s and renders:
 *   - Jobs sorted by priority (lowest number = highest priority)
 *   - Dependencies between jobs
 *   - Status indicators
 *
 * Keyboard controls:
 *   ↑/↓  Select a job
 *   +/-  Bump priority up/down (validates against dependencies)
 *   q    Quit
 *
 * Designed to run in a tmux pane.
 */

import chalk from 'chalk';
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadSettings } from '../config/index.js';
import { JobQueue } from '../jobs/queue.js';
import type { Job } from '../jobs/types.js';

const REFRESH_MS = 2_000;

const STATUS_ICON: Record<string, string> = {
  queued:    chalk.yellow('◦'),
  running:   chalk.green.bold('●'),
  completed: chalk.green('✓'),
  failed:    chalk.red('✗'),
  cancelled: chalk.dim('⊘'),
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

class QueuePane {
  private readonly queue: JobQueue;
  private readonly jobsDir: string;
  private selectedIndex = 0;
  private jobs: Job[] = [];

  constructor(forgeRoot: string) {
    this.queue = new JobQueue(forgeRoot);
    this.jobsDir = join(forgeRoot, 'jobs');
  }

  render(): void {
    this.jobs = this.queue.all()
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (b.status === 'running' && a.status !== 'running') return 1;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });

    // Clamp selection
    if (this.selectedIndex >= this.jobs.length) this.selectedIndex = Math.max(0, this.jobs.length - 1);

    process.stdout.write('\x1b[H\x1b[2J');

    console.log(chalk.bold(' JOB QUEUE') + chalk.dim(`  (${this.jobs.length} active)`));
    console.log(chalk.dim(' ─'.repeat(30)));

    if (this.jobs.length === 0) {
      console.log();
      console.log(chalk.dim('  No active jobs.'));
      console.log();
      console.log(chalk.dim('  Queue work with: forge roadmap, forge implement, etc.'));
      return;
    }

    // Header
    console.log(chalk.dim('  St  Pri  Type            Project          Age'));
    console.log(chalk.dim('  ' + '─'.repeat(55)));

    for (let i = 0; i < this.jobs.length; i++) {
      const job = this.jobs[i];
      const selected = i === this.selectedIndex;
      const icon = STATUS_ICON[job.status] ?? '?';
      const pri = String(job.priority).padStart(3);
      const type = truncate(job.type, 15).padEnd(15);
      const project = truncate(job.project ?? '—', 16).padEnd(16);
      const age = formatAge(job.startedAt ?? job.createdAt);

      const line = `  ${icon}  ${pri}  ${type} ${project} ${age}`;
      console.log(selected ? chalk.bgWhite.black(line) : line);

      // Show dependencies if any
      const deps = job.metadata?.dependsOnPRs as number[] | undefined;
      if (deps && deps.length > 0) {
        const depLine = `       └─ depends: ${deps.map((n) => `PR#${n}`).join(', ')}`;
        console.log(chalk.dim(depLine));
      }
    }

    // Recent completed (last 5)
    const recent = this.queue.all()
      .filter((j) => j.status === 'completed' || j.status === 'failed')
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
      .slice(0, 5);

    if (recent.length > 0) {
      console.log();
      console.log(chalk.dim('  Recent:'));
      for (const job of recent) {
        const icon = STATUS_ICON[job.status] ?? '?';
        const type = truncate(job.type, 15).padEnd(15);
        const project = truncate(job.project ?? '—', 12);
        console.log(chalk.dim(`  ${icon}  ${type} ${project}`));
      }
    }

    // Controls
    console.log();
    console.log(chalk.dim('  ↑/↓ select  +/- priority  q quit'));
  }

  handleKey(key: Buffer): void {
    const s = key.toString();

    if (s === 'q' || s === '\x03') {
      process.exit(0);
    }

    // Arrow up
    if (s === '\x1b[A' && this.selectedIndex > 0) {
      this.selectedIndex--;
      this.render();
    }
    // Arrow down
    if (s === '\x1b[B' && this.selectedIndex < this.jobs.length - 1) {
      this.selectedIndex++;
      this.render();
    }
    // + (bump priority up = lower number)
    if (s === '+' || s === '=') {
      this.bumpPriority(-1);
    }
    // - (bump priority down = higher number)
    if (s === '-') {
      this.bumpPriority(1);
    }
  }

  private bumpPriority(delta: number): void {
    const job = this.jobs[this.selectedIndex];
    if (!job || job.status !== 'queued') return;

    const newPriority = Math.max(1, job.priority + delta);
    const loaded = this.queue.get(job.id);
    if (!loaded || loaded.status !== 'queued') return;

    // Write back with new priority — intentional mutation of the file-based queue
    const updated = { ...loaded, priority: newPriority };
    writeFileSync(join(this.jobsDir, `${loaded.id}.json`), JSON.stringify(updated, null, 2));

    this.render();
  }

  start(): void {
    // Hide cursor
    process.stdout.write('\x1b[?25l');
    process.on('exit', () => process.stdout.write('\x1b[?25h'));
    process.on('SIGINT', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });
    process.on('SIGTERM', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });

    // Raw mode for keyboard input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (key) => this.handleKey(key));
    }

    this.render();
    setInterval(() => this.render(), REFRESH_MS);
  }
}

export function startQueuePane(workspaceRoot?: string): void {
  const settings = loadSettings(workspaceRoot);
  const forgeRoot = resolve(settings.workspaceRoot, '.forge');
  const pane = new QueuePane(forgeRoot);
  pane.start();
}
