/**
 * Event log — structured JSONL event logging.
 *
 * Follows Ralph's pattern: events are small routing signals with timestamps.
 * Detailed agent output goes to separate log files.
 *
 * All events append-only to `.forge/events.jsonl`.
 * Per-agent run output goes to `.forge/logs/<project>/<date>-<role>-<slug>.jsonl`.
 *
 * Log naming convention:
 *   <ISO-date>-<agent-role>-<work-item-slug>.jsonl
 * This ensures logs are sortable by date, filterable by role, and identifiable
 * by what work was being done — without needing to open the file.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, createWriteStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

export type EventType =
  | 'pipeline.start'
  | 'pipeline.complete'
  | 'pipeline.error'
  | 'phase.enter'
  | 'phase.complete'
  | 'stage.start'
  | 'stage.complete'
  | 'stage.error'
  | 'agent.spawn'
  | 'agent.output'
  | 'agent.tool_use'
  | 'agent.result'
  | 'agent.error'
  | 'agent.cost'
  | 'work_item.created'
  | 'work_item.updated'
  | 'roadmap.created'
  | 'roadmap.updated'
  | 'reflection.complete'
  | 'shutdown.requested'
  | 'shutdown.complete'
  | 'jobs.queued'
  | 'job.start'
  | 'job.complete'
  | 'job.failed'
  | 'worker.start'
  | 'worker.stop'
  | 'worker.shutdown'
  | 'review.complete'
  | 'review.scan'
  | 'pr-fix.complete'
  | 'pr.merged';

export interface ForgeEvent {
  readonly timestamp: string;
  readonly type: EventType;
  readonly project?: string;
  readonly agentRole?: string;
  readonly runId?: string;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
}

/** Metadata stored alongside a run log for easy identification */
export interface RunLogMeta {
  readonly runId: string;
  readonly agentRole: string;
  readonly project: string;
  readonly workItemTitle: string;
  readonly startedAt: string;
}

export class EventLog {
  private readonly eventsPath: string;
  private readonly logsDir: string;
  private readonly activeStreams = new Map<string, WriteStream>();
  /** Maps runId → descriptive filename for log lookup */
  private readonly runIdToLogFile = new Map<string, string>();

  constructor(forgeRoot: string) {
    this.eventsPath = join(forgeRoot, 'events.jsonl');
    this.logsDir = join(forgeRoot, 'logs');
    mkdirSync(this.logsDir, { recursive: true });
  }

  /**
   * Emit an event to the global event log.
   */
  emit(event: Omit<ForgeEvent, 'timestamp'>): ForgeEvent {
    const fullEvent: ForgeEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.eventsPath, JSON.stringify(fullEvent) + '\n');
    return fullEvent;
  }

  /**
   * Open a per-run log stream for streaming agent output.
   *
   * File is named descriptively:
   *   logs/<project>/<date>-<role>-<slug>.jsonl
   */
  openRunLog(runId: string, meta?: { project?: string; agentRole?: string; workItemTitle?: string }): WriteStream {
    const existing = this.activeStreams.get(runId);
    if (existing) return existing;

    // Build descriptive filename with full datetime for sortability:
    //   2026-03-06T22-15-30-developer-campaign-persistence.jsonl
    const now = new Date();
    const datetime = now.toISOString().slice(0, 19).replace(/:/g, '-');
    const role = meta?.agentRole ?? 'agent';
    const slug = meta?.workItemTitle
      ? this.slugify(meta.workItemTitle)
      : runId.slice(0, 8);
    const project = meta?.project ?? 'general';
    const filename = `${datetime}-${role}-${slug}.jsonl`;

    // Organize by project
    const projectDir = join(this.logsDir, project);
    mkdirSync(projectDir, { recursive: true });
    const logPath = join(projectDir, filename);

    const stream = createWriteStream(logPath, { flags: 'a' });
    this.activeStreams.set(runId, stream);
    this.runIdToLogFile.set(runId, join(project, filename));

    // Write a header line for context
    stream.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'run.start',
      runId,
      agentRole: role,
      project,
      workItemTitle: meta?.workItemTitle ?? 'unknown',
    }) + '\n');

    return stream;
  }

  /**
   * Write a line to a run's log stream.
   */
  writeRunLog(runId: string, data: Record<string, unknown>): void {
    const stream = this.activeStreams.get(runId);
    if (stream) {
      stream.write(JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n');
    }
  }

  /**
   * Close a run's log stream.
   */
  closeRunLog(runId: string): void {
    const stream = this.activeStreams.get(runId);
    if (stream) {
      stream.end();
      this.activeStreams.delete(runId);
    }
  }

  /**
   * Close all open log streams (for graceful shutdown).
   */
  closeAll(): void {
    for (const [id, stream] of this.activeStreams) {
      stream.end();
      this.activeStreams.delete(id);
    }
  }

  /**
   * Read recent events from the global log.
   */
  recent(count = 50): ForgeEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const lines = readFileSync(this.eventsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);
    return lines
      .slice(-count)
      .map((line) => JSON.parse(line) as ForgeEvent);
  }

  /**
   * Read events for a specific project.
   */
  forProject(project: string, count = 50): ForgeEvent[] {
    return this.recent(count * 3).filter((e) => e.project === project).slice(-count);
  }

  /**
   * Read a run's output log. Tries descriptive filename first, falls back to runId.
   */
  readRunLog(runId: string): Record<string, unknown>[] {
    // Try the mapped descriptive filename
    const descriptivePath = this.runIdToLogFile.get(runId);
    if (descriptivePath) {
      const fullPath = join(this.logsDir, descriptivePath);
      if (existsSync(fullPath)) {
        return this.parseLogFile(fullPath);
      }
    }

    // Fallback: legacy <runId>.jsonl in logs root
    const legacyPath = join(this.logsDir, `${runId}.jsonl`);
    if (existsSync(legacyPath)) {
      return this.parseLogFile(legacyPath);
    }

    // Search through project subdirs
    if (existsSync(this.logsDir)) {
      for (const entry of readdirSync(this.logsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const projectDir = join(this.logsDir, entry.name);
        for (const file of readdirSync(projectDir)) {
          const filePath = join(projectDir, file);
          try {
            const firstLine = readFileSync(filePath, 'utf-8').split('\n')[0];
            if (firstLine && firstLine.includes(runId)) {
              return this.parseLogFile(filePath);
            }
          } catch { /* skip */ }
        }
      }
    }

    return [];
  }

  /**
   * Remove log files older than `daysOld` days and any legacy UUID-named logs
   * in the root logs directory. Returns the number of files removed.
   */
  pruneLogs(daysOld = 7): number {
    const { unlinkSync, statSync } = require('node:fs') as typeof import('node:fs');
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let pruned = 0;

    if (!existsSync(this.logsDir)) return 0;

    // Remove legacy flat UUID logs in root (from old structure)
    for (const file of readdirSync(this.logsDir)) {
      const fullPath = join(this.logsDir, file);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && file.endsWith('.jsonl')) {
          // Legacy UUID log or old log — remove if older than cutoff
          if (stat.mtimeMs < cutoff) {
            unlinkSync(fullPath);
            pruned++;
          }
        }
      } catch { /* skip */ }
    }

    // Prune old logs in project subdirectories
    for (const entry of readdirSync(this.logsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(this.logsDir, entry.name);
      for (const file of readdirSync(projectDir)) {
        const fullPath = join(projectDir, file);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            unlinkSync(fullPath);
            pruned++;
          }
        } catch { /* skip */ }
      }
      // Remove empty project directories
      try {
        const remaining = readdirSync(projectDir);
        if (remaining.length === 0) {
          const { rmdirSync } = require('node:fs') as typeof import('node:fs');
          rmdirSync(projectDir);
        }
      } catch { /* skip */ }
    }

    return pruned;
  }

  private parseLogFile(path: string): Record<string, unknown>[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }
}
