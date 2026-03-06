/**
 * Job queue — file-based persistence for orchestrator jobs.
 *
 * Jobs are stored as `.forge/jobs/<id>.json`. The queue provides
 * FIFO ordering with priority support. The orchestrator writes jobs;
 * the worker reads and processes them.
 *
 * WHY file-based:
 * - Survives process crashes and WSL restarts
 * - Human-inspectable with `ls` and `cat`
 * - No external dependencies (no Redis, no SQLite)
 * - Atomic enough for single-worker use
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Job, JobType, JobStatus, JobPhase } from './types.js';
import { JOB_PRIORITY } from './types.js';

const JOBS_DIR = 'jobs';

export class JobQueue {
  private readonly dir: string;

  constructor(forgeRoot: string) {
    this.dir = join(forgeRoot, JOBS_DIR);
    mkdirSync(this.dir, { recursive: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Posting Jobs
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create and persist a new job. Returns immediately.
   */
  post(
    type: JobType,
    phase: JobPhase,
    project: string | null = null,
    metadata: Record<string, unknown> = {},
    priority?: number,
  ): Job {
    const id = this.generateId();
    const job: Job = {
      id,
      type,
      phase,
      project,
      status: 'queued',
      priority: priority ?? JOB_PRIORITY[type],
      createdAt: new Date().toISOString(),
      metadata,
    };
    this.save(job);
    return job;
  }

  /**
   * Post multiple jobs at once — one per project.
   * Returns all created jobs.
   */
  postForProjects(
    type: JobType,
    phase: JobPhase,
    projects: readonly string[],
    metadata: Record<string, unknown> = {},
  ): Job[] {
    return projects.map((project) =>
      this.post(type, phase, project, { ...metadata }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Querying Jobs
  // ═══════════════════════════════════════════════════════════════════

  /** Load all jobs from disk. */
  all(): Job[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as Job;
        } catch {
          return null;
        }
      })
      .filter((j): j is Job => j !== null);
  }

  /** Get jobs by status, sorted by priority then createdAt. */
  byStatus(status: JobStatus): Job[] {
    return this.all()
      .filter((j) => j.status === status)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }

  /** Get all queued jobs, sorted by priority then FIFO. */
  queued(): Job[] {
    return this.byStatus('queued');
  }

  /** Get all running jobs. */
  running(): Job[] {
    return this.byStatus('running');
  }

  /** Get a specific job by ID. */
  get(id: string): Job | null {
    const path = join(this.dir, `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Job;
    } catch {
      return null;
    }
  }

  /** Check if there are any queued or running jobs. */
  hasWork(): boolean {
    const jobs = this.all();
    return jobs.some((j) => j.status === 'queued' || j.status === 'running');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Claiming & Updating Jobs (used by the worker)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Claim the next available queued job — atomically marks it as running.
   * Returns null if no jobs are available.
   */
  claim(): Job | null {
    const next = this.queued()[0];
    if (!next) return null;

    next.status = 'running';
    next.startedAt = new Date().toISOString();
    this.save(next);
    return next;
  }

  /**
   * Put a claimed (running) job back in the queue.
   * Used when a job can't start due to resource slot limits.
   */
  unclaim(id: string): void {
    const job = this.get(id);
    if (!job || job.status !== 'running') return;
    job.status = 'queued';
    job.startedAt = undefined;
    this.save(job);
  }

  /** Mark a job as completed. */
  complete(id: string): void {
    const job = this.get(id);
    if (!job) return;
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    this.save(job);
  }

  /** Mark a job as failed with an error message. */
  fail(id: string, error: string): void {
    const job = this.get(id);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    job.completedAt = new Date().toISOString();
    this.save(job);
  }

  /** Cancel a job (only if queued). */
  cancel(id: string): boolean {
    const job = this.get(id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    this.save(job);
    return true;
  }

  /** Cancel all queued jobs of a specific type (and optionally project). */
  cancelByType(type: JobType, project?: string): number {
    const matching = this.queued().filter(
      (j) => j.type === type && (!project || j.project === project),
    );
    for (const job of matching) {
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      this.save(job);
    }
    return matching.length;
  }

  /** Cancel all queued jobs. */
  cancelAll(): number {
    const queued = this.queued();
    for (const job of queued) {
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      this.save(job);
    }
    return queued.length;
  }

  /**
   * Reset any jobs stuck in 'running' state back to 'queued'.
   * Called on worker startup to recover from crashes.
   */
  recoverStuck(): number {
    const running = this.running();
    for (const job of running) {
      job.status = 'queued';
      job.startedAt = undefined;
      this.save(job);
    }
    return running.length;
  }

  /**
   * Reset failed jobs back to queued so they can be retried.
   * Returns the number of jobs reset.
   */
  retryFailed(): number {
    const failed = this.all().filter((j) => j.status === 'failed');
    for (const job of failed) {
      job.status = 'queued';
      job.startedAt = undefined;
      job.completedAt = undefined;
      job.error = undefined;
      this.save(job);
    }
    return failed.length;
  }

  /**
   * Clean up old completed/failed/cancelled jobs (older than daysOld days).
   */
  prune(daysOld = 7): number {
    const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const job of this.all()) {
      if (
        (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
        new Date(job.completedAt ?? job.createdAt).getTime() < cutoff
      ) {
        try {
          unlinkSync(join(this.dir, `${job.id}.json`));
          pruned++;
        } catch { /* ignore */ }
      }
    }
    return pruned;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════

  /** Get a summary of the job queue state. */
  summary(): { queued: number; running: number; completed: number; failed: number; cancelled: number } {
    const jobs = this.all();
    return {
      queued: jobs.filter((j) => j.status === 'queued').length,
      running: jobs.filter((j) => j.status === 'running').length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    };
  }

  /** Human-readable summary string. */
  summaryString(): string {
    const s = this.summary();
    const parts: string[] = [];
    if (s.queued > 0) parts.push(`${s.queued} queued`);
    if (s.running > 0) parts.push(`${s.running} running`);
    if (s.completed > 0) parts.push(`${s.completed} completed`);
    if (s.failed > 0) parts.push(`${s.failed} failed`);
    if (parts.length === 0) return 'No jobs';
    return parts.join(' | ');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal
  // ═══════════════════════════════════════════════════════════════════

  private save(job: Job): void {
    writeFileSync(join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 2));
  }

  /**
   * Generate a time-sortable unique ID.
   * Format: <epoch-ms>-<random-hex> — lexicographic sort = creation order.
   */
  private generateId(): string {
    const ts = Date.now().toString(36).padStart(9, '0');
    const rand = randomBytes(3).toString('hex');
    return `${ts}-${rand}`;
  }
}
