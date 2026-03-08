/**
 * Worker status file — shared state between worker and UI panes.
 *
 * The worker writes `.forge/worker-status.json` every few seconds.
 * UI panes read it for live monitoring without any IPC.
 *
 * WHY file-based: Same rationale as the job queue — survives crashes,
 * human-inspectable, no external dependencies. The file is tiny (~1KB)
 * so the I/O cost is negligible.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkerStatus {
  readonly pid: number;
  readonly state: 'running' | 'paused' | 'rate-limited' | 'off';
  readonly updatedAt: string;
  readonly activeJobs: number;
  readonly processedCount: number;
  readonly rateLimitResetAt?: number;
  readonly queue: {
    readonly queued: number;
    readonly running: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly resources: {
    readonly healthy: boolean;
    readonly cpuLoadFactor: number;
    readonly memoryUsagePercent: number;
    readonly availableMemoryMb: number;
    readonly reason?: string;
    readonly slots: Record<string, { used: number; capacity: number }>;
  };
  readonly budget: {
    readonly runCostUsd: number;
    readonly weekCostUsd: number;
    readonly summary: string;
  };
  readonly concurrency?: {
    readonly current: number;
    readonly target: number;
    readonly ceiling: number;
    readonly smoothedCpuLoad: number;
  };
}

const STATUS_FILE = 'worker-status.json';

/** Write current worker state to disk. Called by the worker on each tick. */
export function writeWorkerStatus(forgeRoot: string, status: WorkerStatus): void {
  const path = join(forgeRoot, STATUS_FILE);
  writeFileSync(path, JSON.stringify(status, null, 2));
}

/** Read the worker status file. Returns null if the worker isn't running. */
export function readWorkerStatus(forgeRoot: string): WorkerStatus | null {
  const path = join(forgeRoot, STATUS_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const status = JSON.parse(raw) as WorkerStatus;

    // Stale check: if the file hasn't been updated in 30s, worker is likely dead
    const age = Date.now() - new Date(status.updatedAt).getTime();
    if (age > 30_000) return null;

    return status;
  } catch {
    return null;
  }
}

/** Remove the status file (on graceful shutdown). */
export function clearWorkerStatus(forgeRoot: string): void {
  const path = join(forgeRoot, STATUS_FILE);
  try { unlinkSync(path); } catch { /* ignore */ }
}
