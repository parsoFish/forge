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

import { appendFileSync, mkdirSync, existsSync, readFileSync, createWriteStream, readdirSync, unlinkSync, statSync, rmdirSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
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
  | 'pr.merged'
  | 'pr.chain.closed'
  | 'tuning.report'
  | 'heartbeat.sync'
  | 'heartbeat.merge'
  | 'heartbeat.retry'
  | 'heartbeat.queue'
  | 'agent.orphaned'
  | 'cycle.archived'
  | 'session.start'
  | 'session.resume'
  | 'session.complete'
  | 'job.shed'
  | 'review.drift'
  | 'health.check.pass'
  | 'health.check.fail';

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

  /**
   * Buffered event writes — accumulate events and flush periodically.
   *
   * WHY: appendFileSync per event caused hundreds of sync writes/sec through
   * WSL2's 9P bridge, saturating wslvmem CPU. Buffering amortizes the cost
   * into a single write every FLUSH_INTERVAL_MS.
   */
  private readonly eventBuffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;

  constructor(forgeRoot: string) {
    this.eventsPath = join(forgeRoot, 'events.jsonl');
    this.logsDir = join(forgeRoot, 'logs');
    mkdirSync(this.logsDir, { recursive: true });

    // Start periodic flush
    this.flushTimer = setInterval(() => this.flushBuffer(), EventLog.FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for event flushing
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /**
   * Emit an event to the global event log.
   *
   * Events are buffered and flushed every 500ms to avoid sync I/O storms.
   * Call flushBuffer() explicitly on shutdown for data integrity.
   */
  emit(event: Omit<ForgeEvent, 'timestamp'>): ForgeEvent {
    const fullEvent: ForgeEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };
    this.eventBuffer.push(JSON.stringify(fullEvent));
    return fullEvent;
  }

  /**
   * Flush buffered events to disk. Called periodically and on shutdown.
   */
  flushBuffer(): void {
    if (this.eventBuffer.length === 0) return;
    const batch = this.eventBuffer.splice(0);
    appendFileSync(this.eventsPath, batch.join('\n') + '\n');
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
   * Close all open log streams and flush buffered events (for graceful shutdown).
   */
  closeAll(): void {
    // Flush any remaining buffered events before closing
    this.flushBuffer();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const [id, stream] of this.activeStreams) {
      stream.end();
      this.activeStreams.delete(id);
    }
  }

  /**
   * Read recent events from the global log.
   *
   * WHY tail-read instead of full-file read:
   * The events file grows unbounded (264K+ lines / 38MB+). Reading the whole
   * file into memory just to take the last N lines caused OOM crashes.
   * This reads backwards from EOF in fixed-size chunks — O(N) in the number
   * of requested lines, not O(file-size).
   */
  recent(count = 50): ForgeEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const lines = this.tailLines(this.eventsPath, count);
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as ForgeEvent];
      } catch {
        return []; // Skip corrupted lines (e.g. partial writes during crash)
      }
    });
  }

  /**
   * Read events for a specific project.
   *
   * Reads more lines than requested since we filter by project after.
   * Uses a multiplier to increase odds of finding enough matches.
   */
  forProject(project: string, count = 50): ForgeEvent[] {
    const candidates = this.tailLines(this.eventsPath, count * 5);
    const events: ForgeEvent[] = [];
    for (const line of candidates) {
      const event = JSON.parse(line) as ForgeEvent;
      if (event.project === project) events.push(event);
    }
    return events.slice(-count);
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
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let pruned = 0;

    if (!existsSync(this.logsDir)) return 0;

    // Remove legacy flat UUID logs in root (from old structure)
    for (const file of readdirSync(this.logsDir)) {
      const fullPath = join(this.logsDir, file);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile() && file.endsWith('.jsonl') && stat.mtimeMs < cutoff) {
          unlinkSync(fullPath);
          pruned++;
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
        if (readdirSync(projectDir).length === 0) rmdirSync(projectDir);
      } catch { /* skip */ }
    }

    return pruned;
  }

  /**
   * Detect agents that spawned but never logged a result or error.
   * These are agents that were killed (OOM, SIGKILL, process crash)
   * without the parent process being able to log their termination.
   *
   * Scans the last `lookbackEvents` events. Returns orphaned run IDs
   * and logs `agent.orphaned` events for each.
   */
  detectOrphans(lookbackEvents = 500): Array<{ runId: string; agentRole: string; project?: string }> {
    const events = this.recent(lookbackEvents);
    const spawned = new Map<string, { agentRole: string; project?: string; timestamp: string }>();
    const completed = new Set<string>();

    for (const event of events) {
      if (event.type === 'agent.spawn' && event.runId) {
        spawned.set(event.runId, {
          agentRole: event.agentRole ?? 'unknown',
          project: event.project,
          timestamp: event.timestamp,
        });
      }
      if ((event.type === 'agent.result' || event.type === 'agent.error' || event.type === 'agent.orphaned') && event.runId) {
        completed.add(event.runId);
      }
    }

    const orphans: Array<{ runId: string; agentRole: string; project?: string }> = [];
    for (const [runId, meta] of spawned) {
      if (!completed.has(runId)) {
        orphans.push({ runId, agentRole: meta.agentRole, project: meta.project });
        this.emit({
          type: 'agent.orphaned',
          agentRole: meta.agentRole,
          runId,
          project: meta.project,
          summary: `Orphaned: ${meta.agentRole} [${runId}] (spawned ${meta.timestamp}, never completed — likely OOM/SIGKILL)`,
        });
      }
    }

    return orphans;
  }

  /**
   * Rotate the event log — keep the most recent `keepLines` lines,
   * discard the rest. This prevents unbounded growth.
   *
   * Returns the number of lines discarded.
   */
  rotate(keepLines = 5000): number {
    if (!existsSync(this.eventsPath)) return 0;
    const stat = statSync(this.eventsPath);
    // Skip rotation for small files (< 1MB)
    if (stat.size < 1_000_000) return 0;

    const kept = this.tailLines(this.eventsPath, keepLines);

    // Atomic replace: write to temp, then rename
    const tmpPath = this.eventsPath + '.tmp';
    writeFileSync(tmpPath, kept.join('\n') + '\n');
    const oldSize = stat.size;
    renameSync(tmpPath, this.eventsPath);
    const newSize = statSync(this.eventsPath).size;

    // Return approximate lines discarded based on size reduction
    const ratio = oldSize > 0 ? newSize / oldSize : 1;
    return Math.round(kept.length * ((1 / ratio) - 1));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Read the last N lines from a file by reading backwards from EOF.
   * Only allocates memory proportional to the bytes needed, not the file size.
   */
  private tailLines(filePath: string, count: number): string[] {
    if (!existsSync(filePath)) return [];
    const stat = statSync(filePath);
    if (stat.size === 0) return [];

    const fd = openSync(filePath, 'r');
    try {
      // Read in 64KB chunks from the end
      const CHUNK_SIZE = 65_536;
      let position = stat.size;
      let tail = '';
      let lines: string[] = [];

      while (position > 0 && lines.length <= count) {
        const readSize = Math.min(CHUNK_SIZE, position);
        position -= readSize;
        const buffer = Buffer.alloc(readSize);
        readSync(fd, buffer, 0, readSize, position);
        tail = buffer.toString('utf-8') + tail;
        lines = tail.split('\n').filter(Boolean);
      }

      return lines.slice(-count);
    } finally {
      closeSync(fd);
    }
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
