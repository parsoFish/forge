/**
 * Rolling actions pane — live agent activity display.
 *
 * Tails `.forge/events.jsonl` and shows:
 *   - One live-updating line per running agent
 *   - 3 recent completion summaries with commit-style messages
 *
 * Format per running agent:
 *   [role] project — action — output — 2m30s
 *
 * Render interval adapts to system memory pressure (2s-15s).
 *
 * WHY tail events instead of reading job files:
 * Events contain agent.spawn, agent.output, agent.result — the full
 * lifecycle. Job files only have status. Events give us the "what is
 * this agent doing right now?" that the user wants.
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { loadSettings } from '../config/index.js';
import { getAdaptiveIntervalMs } from './render-throttle.js';
import { DiffRenderer } from './diff-renderer.js';
import type { ForgeEvent } from '../events/event-log.js';

const MAX_COMPLETED = 3;

interface ActiveAgent {
  runId: string;
  role: string;
  project?: string;
  lastAction: string;
  lastOutput: string;
  startedAt: number;
}

interface CompletedEntry {
  role: string;
  project?: string;
  summary: string;
  completedAt: number;
  durationMs: number;
}

class ActionsPane {
  private readonly eventsPath: string;
  private lastFileSize = 0;
  private readonly activeAgents = new Map<string, ActiveAgent>();
  private readonly completed: CompletedEntry[] = [];
  private termWidth = 40;
  private diffRenderer: DiffRenderer;

  constructor(forgeRoot: string) {
    this.eventsPath = resolve(forgeRoot, 'events.jsonl');

    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 40;
    this.diffRenderer = new DiffRenderer(rows, cols, (data) => process.stdout.write(data));
  }

  /** Read new events since last check by tracking file position. */
  private readNewEvents(): ForgeEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const stat = statSync(this.eventsPath);

    // File was rotated/truncated — reset position
    if (stat.size < this.lastFileSize) {
      this.lastFileSize = 0;
    }

    if (stat.size === this.lastFileSize) return [];

    const bytesToRead = stat.size - this.lastFileSize;
    const buffer = Buffer.alloc(bytesToRead);
    const fd = openSync(this.eventsPath, 'r');
    try {
      readSync(fd, buffer, 0, bytesToRead, this.lastFileSize);
    } finally {
      closeSync(fd);
    }
    this.lastFileSize = stat.size;

    const lines = buffer.toString('utf-8').split('\n').filter(Boolean);
    const events: ForgeEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as ForgeEvent);
      } catch { /* skip malformed lines */ }
    }
    return events;
  }

  private processEvents(events: ForgeEvent[]): void {
    for (const event of events) {
      const runId = event.runId;

      switch (event.type) {
        case 'agent.spawn':
          if (runId) {
            this.activeAgents.set(runId, {
              runId,
              role: event.agentRole ?? 'agent',
              project: event.project,
              lastAction: 'starting',
              lastOutput: '',
              startedAt: new Date(event.timestamp).getTime(),
            });
          }
          break;

        case 'agent.tool_use':
          if (runId && this.activeAgents.has(runId)) {
            const agent = this.activeAgents.get(runId)!;
            this.activeAgents.set(runId, {
              ...agent,
              lastAction: event.summary.slice(0, 60),
            });
          }
          break;

        case 'agent.output':
          if (runId && this.activeAgents.has(runId)) {
            const agent = this.activeAgents.get(runId)!;
            this.activeAgents.set(runId, {
              ...agent,
              lastOutput: event.summary.slice(0, 80),
            });
          }
          break;

        case 'agent.result':
        case 'agent.error': {
          if (runId && this.activeAgents.has(runId)) {
            const agent = this.activeAgents.get(runId)!;
            const durationMs = Date.now() - agent.startedAt;
            this.completed.unshift({
              role: agent.role,
              project: agent.project,
              summary: this.buildCompletionSummary(event),
              completedAt: Date.now(),
              durationMs,
            });
            if (this.completed.length > MAX_COMPLETED) this.completed.pop();
            this.activeAgents.delete(runId);
          }
          break;
        }

        case 'job.complete':
        case 'job.failed': {
          const status = event.type === 'job.complete' ? chalk.green('done') : chalk.red('fail');
          this.completed.unshift({
            role: event.data?.jobType as string ?? 'job',
            project: event.project,
            summary: `${status}: ${event.summary.slice(0, 80)}`,
            completedAt: Date.now(),
            durationMs: (event.data?.durationMs as number) ?? 0,
          });
          if (this.completed.length > MAX_COMPLETED) this.completed.pop();
          break;
        }

        case 'agent.orphaned':
          if (runId) this.activeAgents.delete(runId);
          break;
      }
    }

    // Prune agents that have been "active" for over 30 minutes — likely orphaned
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, agent] of this.activeAgents) {
      if (agent.startedAt < cutoff) this.activeAgents.delete(id);
    }
  }

  /**
   * Build a commit-style summary from an agent result event.
   * Extracts the meaningful outcome from the agent's output.
   */
  private buildCompletionSummary(event: ForgeEvent): string {
    const raw = event.summary ?? '';

    // Look for structured output lines (FIX PUSHED, REVIEW POSTED, etc.)
    const structured = raw.match(/(FIX PUSHED|FIX BLOCKED|FIX SKIPPED|REVIEW POSTED|FAILED|MERGED|APPROVED|CHANGES REQUESTED)[:\s]*(.*)/i);
    if (structured) {
      const [, action, detail] = structured;
      return `${action.toLowerCase()}: ${detail.slice(0, 60)}`;
    }

    // Fall back to first meaningful line
    const firstLine = raw.split('\n').find(l => l.trim().length > 10) ?? raw;
    return firstLine.slice(0, 80);
  }

  private formatDuration(startMs: number): string {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m${remSec.toString().padStart(2, '0')}s`;
  }

  private formatDurationMs(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    return `${min}m`;
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  private buildLines(): string[] {
    // Detect available width for content truncation
    this.termWidth = process.stdout.columns ?? 40;
    const contentWidth = this.termWidth - 4; // 2 indent + 2 margin

    const lines: string[] = [];

    lines.push(chalk.bold(' AGENTS') + chalk.dim(`  ${this.activeAgents.size} running`));
    lines.push(chalk.dim(' ' + '─'.repeat(Math.min(contentWidth, 35))));

    if (this.activeAgents.size === 0 && this.completed.length === 0) {
      lines.push(chalk.dim('  Waiting for agents...'));
      return lines;
    }

    // Active agents — one live-updating line per agent
    // Each agent gets 2 lines: identity + current activity
    for (const agent of this.activeAgents.values()) {
      const role = chalk.cyan(`[${agent.role}]`);
      const project = agent.project ? ` ${chalk.white(agent.project)}` : '';
      const duration = chalk.yellow(this.formatDuration(agent.startedAt));

      // Line 1: role, project, duration
      lines.push(`  ${role}${project} ${chalk.dim('—')} ${duration}`);

      // Line 2: current action + output (indented)
      const action = this.truncate(agent.lastAction, contentWidth - 4);
      const agentOutput = agent.lastOutput
        ? chalk.dim(this.truncate(agent.lastOutput, contentWidth - action.length - 6))
        : '';
      lines.push(chalk.dim(`    ${action}`) + (agentOutput ? ` ${agentOutput}` : ''));
    }

    // Completed — 3 recent with commit-style summaries
    if (this.completed.length > 0) {
      if (this.activeAgents.size > 0) lines.push(''); // spacer
      lines.push(chalk.dim('  Recent:'));
      for (const entry of this.completed) {
        const project = entry.project ? chalk.dim(`${entry.project} `) : '';
        const dur = this.formatDurationMs(entry.durationMs);
        const summary = this.truncate(entry.summary, contentWidth - 12);
        lines.push(`  ${project}${chalk.dim(summary)} ${chalk.dim(`(${dur})`)}`);
      }
    }

    return lines;
  }

  render(): void {
    const events = this.readNewEvents();
    this.processEvents(events);

    // Handle terminal resize
    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 40;
    this.diffRenderer.resize(rows, cols);

    this.diffRenderer.render(this.buildLines());
  }

  private scheduleNextRender(): void {
    const interval = getAdaptiveIntervalMs();
    setTimeout(() => {
      this.render();
      this.scheduleNextRender();
    }, interval);
  }

  start(): void {
    // Hide cursor
    process.stdout.write('\x1b[?25l');
    process.on('exit', () => process.stdout.write('\x1b[?25h'));
    process.on('SIGINT', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });
    process.on('SIGTERM', () => { process.stdout.write('\x1b[?25h'); process.exit(0); });

    // Seed from all events so we pick up spawn events for long-running agents.
    // processEvents is idempotent — completed agents get removed from activeAgents,
    // so processing the full history yields only genuinely active agents.
    this.lastFileSize = 0;
    const seedEvents = this.readNewEvents();
    this.processEvents(seedEvents);

    this.render();
    this.scheduleNextRender();
  }
}

export function startActionsPane(workspaceRoot?: string): void {
  const settings = loadSettings(workspaceRoot);
  const forgeRoot = resolve(settings.workspaceRoot, '.forge');
  const pane = new ActionsPane(forgeRoot);
  pane.start();
}
