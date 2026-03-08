/**
 * Resource profiler — learns per-project, per-job-type resource usage over time.
 *
 * After each job completes, the worker records the observed resource impact:
 * CPU load delta, peak memory usage, and duration. The profiler persists this
 * to `.forge/resource-profiles.json` so forge gets better at predicting
 * resource needs over time.
 *
 * The profiler uses exponential moving averages so recent runs are weighted
 * more heavily than old ones, adapting to changes in project size/complexity.
 *
 * WHY this matters for adaptive concurrency:
 * A `develop` job on a small project might use 5% CPU, while the same job
 * type on a large project with Playwright tests might use 40%. Without
 * per-project data, the adaptive concurrency module can't make good
 * predictions. With it, forge can schedule the right number of agents
 * before seeing pressure build.
 *
 * This also feeds the broader memory system — every data point includes
 * metadata (timestamps, job type, project, outcome) that reflection
 * and future indexing can use.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Smoothing factor for exponential moving average. 0.3 = 30% new, 70% history. */
const EMA_ALPHA = 0.3;

/** A single observation from a completed job. */
export interface ResourceObservation {
  /** Job type (roadmap, plan, implement, review, pr-fix, etc.) */
  readonly jobType: string;
  /** Project name (or undefined for project-agnostic jobs like reflect) */
  readonly project?: string;
  /** Average CPU load factor during the job (0-1, relative to cores) */
  readonly cpuLoadFactor: number;
  /** Peak memory usage percentage during the job (0-1) */
  readonly peakMemoryPercent: number;
  /** Memory consumed by the job in MB (delta from baseline) */
  readonly memoryDeltaMb: number;
  /** Job duration in milliseconds */
  readonly durationMs: number;
  /** Whether the job succeeded */
  readonly success: boolean;
  /** ISO timestamp */
  readonly recordedAt: string;
}

/** Smoothed resource estimate for a job type + project combo. */
export interface ResourceEstimate {
  /** Expected CPU load factor per agent for this job type */
  readonly cpuLoadFactor: number;
  /** Expected memory consumption in MB */
  readonly memoryMb: number;
  /** Expected duration in ms */
  readonly durationMs: number;
  /** Number of observations this estimate is based on */
  readonly sampleCount: number;
  /** Last updated */
  readonly updatedAt: string;
}

/** Persisted profile data — keyed by "jobType" or "jobType:project". */
interface ProfileStore {
  /** Version for future migration */
  version: number;
  /** Smoothed profiles: key = "jobType" or "jobType:project" */
  profiles: Record<string, {
    cpuLoadFactor: number;
    memoryMb: number;
    durationMs: number;
    sampleCount: number;
    updatedAt: string;
  }>;
  /** Recent raw observations for debugging/reflection (capped at 100). */
  recentObservations: ResourceObservation[];
}

function profileKey(jobType: string, project?: string): string {
  return project ? `${jobType}:${project}` : jobType;
}

export class ResourceProfiler {
  private store: ProfileStore;
  private readonly storePath: string;
  private dirty = false;

  constructor(forgeRoot: string) {
    this.storePath = join(forgeRoot, 'resource-profiles.json');
    this.store = this.load();
  }

  /**
   * Record a resource observation from a completed job.
   * Updates the exponential moving average for the job type + project combo.
   */
  record(obs: ResourceObservation): void {
    const key = profileKey(obs.jobType, obs.project);
    const existing = this.store.profiles[key];

    if (existing) {
      // EMA update — recent observations weighted more heavily
      this.store.profiles[key] = {
        cpuLoadFactor: ema(existing.cpuLoadFactor, obs.cpuLoadFactor),
        memoryMb: ema(existing.memoryMb, obs.memoryDeltaMb),
        durationMs: ema(existing.durationMs, obs.durationMs),
        sampleCount: existing.sampleCount + 1,
        updatedAt: obs.recordedAt,
      };
    } else {
      // First observation — use raw values
      this.store.profiles[key] = {
        cpuLoadFactor: obs.cpuLoadFactor,
        memoryMb: obs.memoryDeltaMb,
        durationMs: obs.durationMs,
        sampleCount: 1,
        updatedAt: obs.recordedAt,
      };
    }

    // Also update the job-type-only profile (aggregate across projects)
    if (obs.project) {
      const typeKey = profileKey(obs.jobType);
      const typeExisting = this.store.profiles[typeKey];
      if (typeExisting) {
        this.store.profiles[typeKey] = {
          cpuLoadFactor: ema(typeExisting.cpuLoadFactor, obs.cpuLoadFactor),
          memoryMb: ema(typeExisting.memoryMb, obs.memoryDeltaMb),
          durationMs: ema(typeExisting.durationMs, obs.durationMs),
          sampleCount: typeExisting.sampleCount + 1,
          updatedAt: obs.recordedAt,
        };
      } else {
        this.store.profiles[typeKey] = {
          cpuLoadFactor: obs.cpuLoadFactor,
          memoryMb: obs.memoryDeltaMb,
          durationMs: obs.durationMs,
          sampleCount: 1,
          updatedAt: obs.recordedAt,
        };
      }
    }

    // Keep recent observations for reflection/debugging
    this.store.recentObservations.unshift(obs);
    if (this.store.recentObservations.length > 100) {
      this.store.recentObservations.length = 100;
    }

    this.dirty = true;
  }

  /**
   * Get the estimated resource usage for a job type + project combo.
   * Falls back to job-type-only estimate if no project-specific data exists.
   * Returns null if no data is available.
   */
  estimate(jobType: string, project?: string): ResourceEstimate | null {
    // Try project-specific first
    if (project) {
      const specific = this.store.profiles[profileKey(jobType, project)];
      if (specific) return { ...specific };
    }

    // Fall back to job-type aggregate
    const general = this.store.profiles[profileKey(jobType)];
    if (general) return { ...general };

    return null;
  }

  /** Get all profiles for display/debugging. */
  allProfiles(): Readonly<Record<string, ResourceEstimate>> {
    return this.store.profiles;
  }

  /** Recent observations for reflection. */
  recentObservations(): readonly ResourceObservation[] {
    return this.store.recentObservations;
  }

  /** Flush to disk if dirty. Called periodically by the worker. */
  flush(): void {
    if (!this.dirty) return;
    this.save();
    this.dirty = false;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private load(): ProfileStore {
    if (existsSync(this.storePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.storePath, 'utf-8')) as ProfileStore;
        if (raw.version === 1) return raw;
      } catch { /* corrupted — start fresh */ }
    }
    return { version: 1, profiles: {}, recentObservations: [] };
  }

  private save(): void {
    writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
  }
}

function ema(oldValue: number, newValue: number): number {
  return EMA_ALPHA * newValue + (1 - EMA_ALPHA) * oldValue;
}
