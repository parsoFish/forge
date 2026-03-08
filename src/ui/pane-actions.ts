/**
 * Rolling actions pane — live agent activity display.
 *
 * Tails `.forge/events.jsonl` and shows:
 *   - One line per running agent (updates in place)
 *   - Completed job summaries
 *
 * Format per running agent:
 *   [role] current action — output excerpt — 2m30s
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
import type { ForgeEvent } from '../events/event-log.js';

const REFRESH_MS = 2_000;
const MAX_COMPLETED = 8;

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
}

class ActionsPane {
  private readonly eventsPath: string;
  private lastFileSize = 0;
  private readonly activeAgents = new Map<string, ActiveAgent>();
  private readonly completed: CompletedEntry[] = [];

  constructor(forgeRoot: string) {
    this.eventsPath = resolve(forgeRoot, 'events.jsonl');
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
        case 'agent.error':
          if (runId && this.activeAgents.has(runId)) {
            const agent = this.activeAgents.get(runId)!;
            this.completed.unshift({
              role: agent.role,
              project: agent.project,
              summary: event.summary.slice(0, 100),
              completedAt: Date.now(),
            });
            if (this.completed.length > MAX_COMPLETED) this.completed.pop();
            this.activeAgents.delete(runId);
          }
          break;

        case 'job.complete':
        case 'job.failed': {
          const status = event.type === 'job.complete' ? chalk.green('✓') : chalk.red('✗');
          this.completed.unshift({
            role: event.data?.type as string ?? 'job',
            project: event.project,
            summary: `${status} ${event.summary.slice(0, 90)}`,
            completedAt: Date.now(),
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

  private formatDuration(startMs: number): string {
    const sec = Math.floor((Date.now() - startMs) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min}m${remSec.toString().padStart(2, '0')}s`;
  }

  render(): void {
    const events = this.readNewEvents();
    this.processEvents(events);

    process.stdout.write('\x1b[H\x1b[2J');

    console.log(chalk.bold(' ACTIONS') + chalk.dim(`  (${this.activeAgents.size} running)`));
    console.log(chalk.dim(' ─'.repeat(30)));

    if (this.activeAgents.size === 0 && this.completed.length === 0) {
      console.log();
      console.log(chalk.dim('  No agent activity.'));
      console.log(chalk.dim('  Agents will appear here when the worker processes jobs.'));
      return;
    }

    // Active agents — one line each, updating in place
    if (this.activeAgents.size > 0) {
      console.log();
      for (const agent of this.activeAgents.values()) {
        const role = chalk.cyan(`[${agent.role}]`);
        const project = agent.project ? chalk.dim(` ${agent.project}`) : '';
        const duration = chalk.dim(this.formatDuration(agent.startedAt));
        const action = agent.lastAction;
        const output = agent.lastOutput ? chalk.dim(` — ${agent.lastOutput.slice(0, 50)}`) : '';

        console.log(`  ${role}${project} ${action}${output} ${duration}`);
      }
    }

    // Completed jobs summary
    if (this.completed.length > 0) {
      console.log();
      console.log(chalk.dim('  Recent completions:'));
      for (const entry of this.completed) {
        const project = entry.project ? chalk.dim(`${entry.project} `) : '';
        const age = this.formatDuration(entry.completedAt);
        console.log(chalk.dim(`  ${project}${entry.summary} (${age} ago)`));
      }
    }

    // Footer
    console.log();
    console.log(chalk.dim(`  Updated: ${new Date().toLocaleTimeString()}`));
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
    setInterval(() => this.render(), REFRESH_MS);
  }
}

export function startActionsPane(workspaceRoot?: string): void {
  const settings = loadSettings(workspaceRoot);
  const forgeRoot = resolve(settings.workspaceRoot, '.forge');
  const pane = new ActionsPane(forgeRoot);
  pane.start();
}
