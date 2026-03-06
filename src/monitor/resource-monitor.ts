/**
 * Resource monitor — checks system health before spawning agents.
 *
 * Prevents the orchestrator from overloading the machine by tracking
 * CPU load, memory usage, and active child processes. Agents that spin
 * up apps/services for testing (dev servers, test runners) consume
 * significant resources — this module provides backpressure.
 *
 * The monitor returns a "health" assessment that the orchestrator uses
 * to decide whether to spawn more agents or wait.
 */

import { cpus, freemem, totalmem, loadavg } from 'node:os';

export interface ResourceThresholds {
  /** Max CPU load average (1-min) relative to core count. 0.8 = 80% */
  readonly maxLoadFactor: number;
  /** Max percentage of memory used (0-1). 0.85 = 85% */
  readonly maxMemoryUsage: number;
  /** Cooldown in ms between health checks to avoid thrashing */
  readonly checkIntervalMs: number;
}

export interface HealthCheck {
  readonly healthy: boolean;
  readonly cpuLoadFactor: number;
  readonly memoryUsagePercent: number;
  readonly availableMemoryMb: number;
  readonly coreCount: number;
  readonly reason?: string;
}

export const DEFAULT_THRESHOLDS: ResourceThresholds = {
  maxLoadFactor: 0.80,      // Don't exceed 80% of cores
  maxMemoryUsage: 0.85,     // Leave 15% memory headroom
  checkIntervalMs: 5000,    // Check every 5s at most
};

export class ResourceMonitor {
  private readonly thresholds: ResourceThresholds;
  private lastCheck: HealthCheck | null = null;
  private lastCheckTime = 0;

  constructor(thresholds?: Partial<ResourceThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Check system health. Returns a cached result if called within
   * the check interval to avoid excessive syscalls.
   */
  check(): HealthCheck {
    const now = Date.now();
    if (this.lastCheck && (now - this.lastCheckTime) < this.thresholds.checkIntervalMs) {
      return this.lastCheck;
    }

    const coreCount = cpus().length;
    const load1min = loadavg()[0];
    const cpuLoadFactor = load1min / coreCount;

    const totalMem = totalmem();
    const freeMem = freemem();
    const usedMem = totalMem - freeMem;
    const memoryUsagePercent = usedMem / totalMem;
    const availableMemoryMb = Math.round(freeMem / (1024 * 1024));

    let healthy = true;
    let reason: string | undefined;

    if (cpuLoadFactor > this.thresholds.maxLoadFactor) {
      healthy = false;
      reason = `CPU load too high: ${(cpuLoadFactor * 100).toFixed(0)}% of ${coreCount} cores (limit: ${(this.thresholds.maxLoadFactor * 100).toFixed(0)}%)`;
    }

    if (memoryUsagePercent > this.thresholds.maxMemoryUsage) {
      healthy = false;
      const memReason = `Memory usage too high: ${(memoryUsagePercent * 100).toFixed(0)}% (${availableMemoryMb}MB free, limit: ${(this.thresholds.maxMemoryUsage * 100).toFixed(0)}%)`;
      reason = reason ? `${reason}; ${memReason}` : memReason;
    }

    this.lastCheck = {
      healthy,
      cpuLoadFactor,
      memoryUsagePercent,
      availableMemoryMb,
      coreCount,
      reason,
    };
    this.lastCheckTime = now;

    return this.lastCheck;
  }

  /**
   * Wait until the system is healthy enough to spawn another agent.
   * Backs off with exponential delay, up to a maximum wait.
   */
  async waitForHealth(maxWaitMs = 120_000): Promise<HealthCheck> {
    const start = Date.now();
    let delay = 2000; // Start at 2s

    while (Date.now() - start < maxWaitMs) {
      // Force a fresh check
      this.lastCheckTime = 0;
      const health = this.check();

      if (health.healthy) return health;

      // Back off, capped at 30s
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 30_000);
    }

    // Timed out — return last check regardless
    this.lastCheckTime = 0;
    return this.check();
  }

  /** Summary string for display. */
  summary(): string {
    const h = this.check();
    const status = h.healthy ? 'healthy' : 'stressed';
    return `System ${status}: CPU ${(h.cpuLoadFactor * 100).toFixed(0)}%/${h.coreCount} cores | Memory ${(h.memoryUsagePercent * 100).toFixed(0)}% (${h.availableMemoryMb}MB free)`;
  }
}
