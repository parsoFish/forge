/**
 * Process isolation — cgroup v2 resource limits for agent subprocesses.
 *
 * Architecture:
 * Forge must run inside a systemd user scope for cgroup delegation to work.
 * The tmux-launcher wraps `forge session` with `systemd-run --user --scope`.
 *
 * On startup, ProcessIsolation:
 * 1. Detects if the process is in a user-owned, delegated cgroup scope
 * 2. Self-migrates to a `main/` leaf (cgroup v2 "no internal processes" rule)
 * 3. Enables memory+cpu controllers on the scope's subtree_control
 * 4. Creates per-job sibling cgroups with memory.max / memory.high limits
 *
 * Falls back gracefully when cgroups are unavailable (permissions, non-Linux,
 * or running outside a delegated scope).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/** Resource request for a job — used for scheduling and cgroup limits. */
export interface ResourceRequest {
  /** Minimum memory (MB) required for scheduling. */
  readonly memoryRequestMb: number;
  /** Hard memory ceiling (MB) enforced by cgroup. */
  readonly memoryLimitMb: number;
  /** Relative CPU weight (cgroup cpu.weight). Default: 100. */
  readonly cpuWeight?: number;
}

/** Default resource profiles by job type. Learned values override these. */
export const DEFAULT_RESOURCE_PROFILES: Readonly<Record<string, ResourceRequest>> = {
  'work-item':  { memoryRequestMb: 512,  memoryLimitMb: 1500 },
  'pr-fix':     { memoryRequestMb: 512,  memoryLimitMb: 1500 },
  'implement':  { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'plan':       { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'review':     { memoryRequestMb: 256,  memoryLimitMb: 600  },
  'roadmap':    { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'reflect':    { memoryRequestMb: 256,  memoryLimitMb: 600  },
};

/** Per-job memory observation from cgroup. */
export interface CgroupMemoryStats {
  /** Current memory usage in bytes. */
  readonly currentBytes: number;
  /** Peak memory usage in bytes (memory.peak if available). */
  readonly peakBytes: number;
  /** Whether the OOM killer was triggered. */
  readonly oomKilled: boolean;
}

/** Pressure Stall Information from /proc/pressure/memory. */
export interface PressureStallInfo {
  /** Percentage of time at least some tasks are stalled on memory (10s window). */
  readonly someAvg10: number;
  /** Percentage of time ALL tasks are stalled on memory (10s window). */
  readonly fullAvg10: number;
  /** Total stall time in microseconds. */
  readonly someTotalUs: number;
  readonly fullTotalUs: number;
}

/**
 * Process isolation manager.
 *
 * Creates cgroup v2 hierarchies for agent subprocesses and enforces
 * memory limits. Falls back to no-op when cgroups are unavailable.
 */
export class ProcessIsolation {
  /** Path to the scope cgroup (parent of main/ and job cgroups). */
  private readonly scopePath: string;
  private _available: boolean;
  /** Human-readable reason why cgroups are unavailable (for diagnostics). */
  private readonly _unavailableReason: string;
  /** Track active cgroups for cleanup. */
  private readonly activeCgroups = new Set<string>();

  constructor() {
    const { path, reason } = this.detectAndSetup();
    this.scopePath = path;
    this._available = path !== '';
    this._unavailableReason = reason;
  }

  /** Whether cgroup isolation is available on this system. */
  get isAvailable(): boolean {
    return this._available;
  }

  /** Why cgroups are unavailable (empty string if available). */
  get unavailableReason(): string {
    return this._unavailableReason;
  }

  /**
   * Create a cgroup for a job with memory limits.
   *
   * Returns the cgroup path (for placing the child PID into),
   * or null if cgroups are unavailable.
   */
  createCgroup(jobId: string, limits: ResourceRequest): string | null {
    if (!this._available) return null;

    const cgroupPath = join(this.scopePath, sanitizeJobId(jobId));

    try {
      mkdirSync(cgroupPath, { recursive: true });

      // Set memory.max (hard limit — kernel kills on exceed)
      const memoryMax = limits.memoryLimitMb * 1024 * 1024;
      writeFileSync(join(cgroupPath, 'memory.max'), String(memoryMax));

      // Set memory.high (soft limit — triggers reclaim pressure at 80% of max)
      const memoryHigh = Math.floor(memoryMax * 0.8);
      writeFileSync(join(cgroupPath, 'memory.high'), String(memoryHigh));

      // Set CPU weight if specified (default: 100, range: 1-10000)
      if (limits.cpuWeight !== undefined) {
        try {
          writeFileSync(join(cgroupPath, 'cpu.weight'), String(limits.cpuWeight));
        } catch {
          // cpu controller may not be delegated — non-fatal
        }
      }

      this.activeCgroups.add(jobId);
      return cgroupPath;
    } catch {
      // Cgroup creation failed — clean up and return null
      try { rmSync(cgroupPath, { recursive: true, force: true }); } catch { /* ignore */ }
      return null;
    }
  }

  /**
   * Place a running process into a cgroup.
   *
   * Call this immediately after spawn() with the child's PID.
   */
  placeInCgroup(cgroupPath: string | null, pid: number): boolean {
    if (!cgroupPath) return false;

    try {
      writeFileSync(join(cgroupPath, 'cgroup.procs'), String(pid));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read current memory usage for a job's cgroup.
   */
  readMemoryStats(jobId: string): CgroupMemoryStats | null {
    if (!this._available) return null;

    const cgroupPath = join(this.scopePath, sanitizeJobId(jobId));
    if (!existsSync(cgroupPath)) return null;

    try {
      const current = parseInt(
        readFileSync(join(cgroupPath, 'memory.current'), 'utf-8').trim(),
        10,
      );

      let peak = current;
      try {
        peak = parseInt(
          readFileSync(join(cgroupPath, 'memory.peak'), 'utf-8').trim(),
          10,
        );
      } catch {
        // memory.peak may not exist on older kernels
      }

      let oomKilled = false;
      try {
        const events = readFileSync(join(cgroupPath, 'memory.events'), 'utf-8');
        const oomMatch = events.match(/oom_kill\s+(\d+)/);
        oomKilled = oomMatch ? parseInt(oomMatch[1], 10) > 0 : false;
      } catch {
        // memory.events may not exist
      }

      return { currentBytes: current, peakBytes: peak, oomKilled };
    } catch {
      return null;
    }
  }

  /**
   * Kill all processes in a job's cgroup.
   *
   * Used for graceful shedding when system memory is critical.
   * The cgroup.kill interface (kernel 5.14+) kills the entire subtree atomically.
   */
  killCgroup(jobId: string): boolean {
    if (!this._available) return false;

    const cgroupPath = join(this.scopePath, sanitizeJobId(jobId));
    if (!existsSync(cgroupPath)) return false;

    try {
      // Try cgroup.kill (kernel 5.14+, fast atomic kill)
      writeFileSync(join(cgroupPath, 'cgroup.kill'), '1');
      return true;
    } catch {
      // Fallback: read PIDs and send SIGKILL
      try {
        const pids = readFileSync(join(cgroupPath, 'cgroup.procs'), 'utf-8')
          .trim()
          .split('\n')
          .filter(Boolean);
        for (const pid of pids) {
          try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch { /* process may have exited */ }
        }
        return pids.length > 0;
      } catch {
        return false;
      }
    }
  }

  /**
   * Destroy a job's cgroup after the job completes.
   */
  destroyCgroup(jobId: string): void {
    if (!this._available) return;

    const cgroupPath = join(this.scopePath, sanitizeJobId(jobId));
    try {
      rmSync(cgroupPath, { recursive: true, force: true });
    } catch {
      // May fail if processes are still running — that's OK
    }
    this.activeCgroups.delete(jobId);
  }

  /**
   * Emergency: kill the largest memory consumer among active cgroups.
   *
   * Returns the jobId of the killed job, or null if nothing was killed.
   */
  shedLargest(): string | null {
    if (!this._available || this.activeCgroups.size === 0) return null;

    let largestJobId: string | null = null;
    let largestMemory = 0;

    for (const jobId of this.activeCgroups) {
      const stats = this.readMemoryStats(jobId);
      if (stats && stats.currentBytes > largestMemory) {
        largestMemory = stats.currentBytes;
        largestJobId = jobId;
      }
    }

    if (largestJobId) {
      this.killCgroup(largestJobId);
    }

    return largestJobId;
  }

  /**
   * Emergency: kill the lowest-priority job among active cgroups.
   *
   * WHY priority-based: During memory pressure, we want to sacrifice
   * recoverable work (build/test jobs) before killing planning or
   * reflection jobs that lose irreplaceable context. Among jobs at the
   * same priority, the largest memory consumer is killed first.
   *
   * @param jobPriorities Map of jobId → numeric priority (lower = more important)
   * @returns The jobId killed, or null if nothing was shed
   */
  shedByPriority(jobPriorities: ReadonlyMap<string, number>): string | null {
    if (!this._available || this.activeCgroups.size === 0) return null;

    let victimJobId: string | null = null;
    let victimPriority = -Infinity;
    let victimMemory = 0;

    for (const jobId of this.activeCgroups) {
      const priority = jobPriorities.get(jobId) ?? 50; // default mid-priority
      const stats = this.readMemoryStats(jobId);
      const memory = stats?.currentBytes ?? 0;

      // Pick the lowest-priority job (highest number). Tie-break by memory.
      if (
        priority > victimPriority ||
        (priority === victimPriority && memory > victimMemory)
      ) {
        victimJobId = jobId;
        victimPriority = priority;
        victimMemory = memory;
      }
    }

    if (victimJobId) {
      this.killCgroup(victimJobId);
    }

    return victimJobId;
  }

  /**
   * Destroy all active cgroups. Called on shutdown.
   */
  destroyAll(): void {
    for (const jobId of this.activeCgroups) {
      this.destroyCgroup(jobId);
    }
  }

  // ─── PSI (Pressure Stall Information) ───────────────────────────

  /**
   * Read memory pressure from /proc/pressure/memory.
   *
   * PSI is more accurate than MemAvailable for WSL2 because it measures
   * actual stall time — how much work is blocked waiting for memory.
   * MemAvailable in WSL2 reflects the VM's allocation, not real pressure.
   */
  static readPSI(): PressureStallInfo | null {
    try {
      const content = readFileSync('/proc/pressure/memory', 'utf-8');
      const someLine = content.match(/some avg10=(\d+\.\d+).*total=(\d+)/);
      const fullLine = content.match(/full avg10=(\d+\.\d+).*total=(\d+)/);

      if (!someLine || !fullLine) return null;

      return {
        someAvg10: parseFloat(someLine[1]),
        fullAvg10: parseFloat(fullLine[1]),
        someTotalUs: parseInt(someLine[2], 10),
        fullTotalUs: parseInt(fullLine[2], 10),
      };
    } catch {
      return null;
    }
  }

  // ─── Internals ──────────────────────────────────────────────────

  /**
   * Detect a usable cgroup scope and set up the hierarchy.
   *
   * Strategy:
   * 1. Find our cgroup path from /proc/self/cgroup
   * 2. Verify it's user-owned (delegated by systemd)
   * 3. Self-migrate to a `main/` leaf cgroup
   * 4. Enable memory+cpu controllers on the scope
   *
   * Returns { path, reason } — path is '' if unavailable.
   */
  private detectAndSetup(): { path: string; reason: string } {
    // cgroup v2 must be mounted
    if (!existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      return { path: '', reason: 'cgroup v2 not mounted' };
    }

    try {
      const cgroupSelf = readFileSync('/proc/self/cgroup', 'utf-8').trim();
      const match = cgroupSelf.match(/^0::(.+)/m);
      if (!match) return { path: '', reason: 'cannot parse /proc/self/cgroup' };

      const scopePath = join('/sys/fs/cgroup', match[1]);

      // Must be owned by our user (systemd delegation), not root
      const stat = statSync(scopePath);
      const uid = process.getuid?.();
      if (stat.uid !== uid) {
        return {
          path: '',
          reason: `cgroup ${match[1]} owned by uid ${stat.uid}, not ${uid} — run via 'forge' (tmux) or systemd-run`,
        };
      }

      // Verify memory controller is available
      const controllers = readFileSync(
        join(scopePath, 'cgroup.controllers'),
        'utf-8',
      ).trim();
      if (!controllers.includes('memory')) {
        return { path: '', reason: `memory controller not available (has: ${controllers})` };
      }

      // Self-migrate: create a leaf cgroup for forge's own process,
      // freeing the scope for subtree_control (cgroup v2 "no internal
      // processes" rule — a cgroup can't have both direct processes
      // AND controller-enabled children).
      const mainLeaf = join(scopePath, 'main');
      try {
        if (!existsSync(mainLeaf)) {
          mkdirSync(mainLeaf, { recursive: true });
        }
        // Verify the kernel populated cgroup.procs before writing
        const procsPath = join(mainLeaf, 'cgroup.procs');
        if (!existsSync(procsPath)) {
          return { path: '', reason: `cgroup.procs missing in ${mainLeaf} — kernel may not have populated it` };
        }
        writeFileSync(procsPath, String(process.pid));
      } catch (migErr) {
        return { path: '', reason: `self-migration to main/ failed: ${(migErr as Error).message}` };
      }

      // Enable memory+cpu controllers for child cgroups
      try {
        const subtreeControlPath = join(scopePath, 'cgroup.subtree_control');
        if (!existsSync(subtreeControlPath)) {
          return { path: '', reason: `subtree_control missing in ${scopePath}` };
        }
        const subtreeControl = readFileSync(subtreeControlPath, 'utf-8').trim();
        if (!subtreeControl.includes('memory')) {
          writeFileSync(subtreeControlPath, '+memory +cpu');
        }
      } catch (ctrlErr) {
        return { path: '', reason: `enabling controllers failed: ${(ctrlErr as Error).message}` };
      }

      return { path: scopePath, reason: '' };
    } catch (err) {
      return { path: '', reason: `detection failed: ${(err as Error).message}` };
    }
  }
}

/** Sanitize a job ID for use as a cgroup directory name. */
function sanitizeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
