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

/**
 * Resource slot definitions — named finite-capacity locks for heavyweight
 * operations that agents may spawn (browsers, dev servers, builds).
 *
 * The worker checks slot availability alongside CPU/memory before dispatching.
 * Agents acquire slots before launching expensive child processes and release
 * them when done. This prevents 5 concurrent Playwright browsers from
 * melting the machine even when CPU/memory appear fine at dispatch time.
 */
export interface ResourceSlotConfig {
  /** Maximum concurrent holders of this slot */
  readonly capacity: number;
}

export interface ResourceThresholds {
  /** Max CPU load average (1-min) relative to core count. 0.8 = 80% */
  readonly maxLoadFactor: number;
  /** Max percentage of memory used (0-1). 0.85 = 85% */
  readonly maxMemoryUsage: number;
  /** Cooldown in ms between health checks to avoid thrashing */
  readonly checkIntervalMs: number;
  /** Named resource slots with capacity limits */
  readonly resourceSlots: Readonly<Record<string, ResourceSlotConfig>>;
}

export interface HealthCheck {
  readonly healthy: boolean;
  readonly cpuLoadFactor: number;
  readonly memoryUsagePercent: number;
  readonly availableMemoryMb: number;
  readonly coreCount: number;
  readonly reason?: string;
  /** Snapshot of slot usage at check time */
  readonly slots: Readonly<Record<string, { used: number; capacity: number }>>;
}

export const DEFAULT_RESOURCE_SLOTS: Readonly<Record<string, ResourceSlotConfig>> = {
  /** Playwright, Puppeteer, or any headless browser instance */
  browser: { capacity: 2 },
  /** Vite, webpack-dev-server, or similar long-running dev processes */
  devServer: { capacity: 2 },
  /** TypeScript compilation, Rust builds, etc. */
  build: { capacity: 3 },
};

export const DEFAULT_THRESHOLDS: ResourceThresholds = {
  maxLoadFactor: 0.80,      // Don't exceed 80% of cores
  maxMemoryUsage: 0.85,     // Leave 15% memory headroom
  checkIntervalMs: 5000,    // Check every 5s at most
  resourceSlots: DEFAULT_RESOURCE_SLOTS,
};

/** Metrics collected during a worker run for tuning analysis. */
export interface SlotMetrics {
  /** Peak concurrent holders seen during the run */
  readonly peakUsage: number;
  /** Current configured capacity */
  readonly capacity: number;
  /** Number of times a job was blocked waiting for this slot */
  readonly blockCount: number;
  /** Total samples where this slot had at least one holder */
  readonly activeSamples: number;
  /** Total health check samples taken */
  readonly totalSamples: number;
}

export interface TuningRecommendation {
  readonly slot: string;
  readonly currentCapacity: number;
  readonly suggestedCapacity: number;
  readonly reason: string;
}

export interface TuningReport {
  readonly recommendations: readonly TuningRecommendation[];
  readonly peakCpuLoadFactor: number;
  readonly peakMemoryUsagePercent: number;
  readonly healthySamples: number;
  readonly totalSamples: number;
  readonly slotMetrics: Readonly<Record<string, SlotMetrics>>;
}

export class ResourceMonitor {
  private readonly thresholds: ResourceThresholds;
  private lastCheck: HealthCheck | null = null;
  private lastCheckTime = 0;

  /**
   * In-memory slot holders. Key = slot name, value = set of holder IDs.
   * Holder IDs are typically `${jobId}` or `${runId}-${slotName}`.
   */
  private readonly slotHolders = new Map<string, Set<string>>();

  // ─── Metrics counters (reset per worker run via resetMetrics()) ───
  private peakSlotUsage = new Map<string, number>();
  private slotBlockCounts = new Map<string, number>();
  private slotActiveSamples = new Map<string, number>();
  private metricsSampleCount = 0;
  private peakCpuLoadFactor = 0;
  private peakMemoryUsagePercent = 0;
  private healthySampleCount = 0;

  constructor(thresholds?: Partial<ResourceThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

    // Initialise holder sets for configured slots
    for (const name of Object.keys(this.thresholds.resourceSlots)) {
      this.slotHolders.set(name, new Set());
    }
  }

  // ─── Resource Slot API ────────────────────────────────────────────

  /**
   * Try to acquire a named resource slot. Returns true if acquired,
   * false if the slot is at capacity.
   *
   * @param slot  Slot name (e.g. "browser", "devServer", "build")
   * @param holder  Unique ID for the holder (job ID, run ID, etc.)
   */
  acquire(slot: string, holder: string): boolean {
    const config = this.thresholds.resourceSlots[slot];
    if (!config) return true; // Unknown slot — no limit

    let holders = this.slotHolders.get(slot);
    if (!holders) {
      holders = new Set();
      this.slotHolders.set(slot, holders);
    }

    if (holders.has(holder)) return true; // Already held — idempotent
    if (holders.size >= config.capacity) return false;

    holders.add(holder);
    this.invalidateCache();

    // Track peak usage
    const current = holders.size;
    const peak = this.peakSlotUsage.get(slot) ?? 0;
    if (current > peak) this.peakSlotUsage.set(slot, current);

    return true;
  }

  /**
   * Record that a job was blocked waiting for a slot.
   * Called by the worker when it unclaims a job due to slot limits.
   */
  recordBlock(slot: string): void {
    this.slotBlockCounts.set(slot, (this.slotBlockCounts.get(slot) ?? 0) + 1);
  }

  /**
   * Release a previously acquired slot.
   */
  release(slot: string, holder: string): void {
    const holders = this.slotHolders.get(slot);
    if (holders?.delete(holder)) {
      this.invalidateCache();
    }
  }

  /**
   * Release ALL slots held by a given holder (cleanup on job completion).
   */
  releaseAll(holder: string): void {
    for (const holders of this.slotHolders.values()) {
      holders.delete(holder);
    }
    this.invalidateCache();
  }

  /**
   * Check if a slot has capacity available.
   */
  hasCapacity(slot: string): boolean {
    const config = this.thresholds.resourceSlots[slot];
    if (!config) return true;
    const holders = this.slotHolders.get(slot);
    return !holders || holders.size < config.capacity;
  }

  /**
   * Snapshot of all slot usage.
   */
  slotSnapshot(): Readonly<Record<string, { used: number; capacity: number }>> {
    const result: Record<string, { used: number; capacity: number }> = {};
    for (const [name, config] of Object.entries(this.thresholds.resourceSlots)) {
      const holders = this.slotHolders.get(name);
      result[name] = { used: holders?.size ?? 0, capacity: config.capacity };
    }
    return result;
  }

  // ─── Health Check ─────────────────────────────────────────────────

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

    const slots = this.slotSnapshot();

    // ─── Sample metrics for tuning ───
    this.metricsSampleCount++;
    if (cpuLoadFactor > this.peakCpuLoadFactor) this.peakCpuLoadFactor = cpuLoadFactor;
    if (memoryUsagePercent > this.peakMemoryUsagePercent) this.peakMemoryUsagePercent = memoryUsagePercent;
    for (const [name, { used }] of Object.entries(slots)) {
      if (used > 0) {
        this.slotActiveSamples.set(name, (this.slotActiveSamples.get(name) ?? 0) + 1);
      }
      const peak = this.peakSlotUsage.get(name) ?? 0;
      if (used > peak) this.peakSlotUsage.set(name, used);
    }

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

    // Check if any slot is at capacity — flag as unhealthy so the worker
    // knows to inspect slots before blindly dispatching heavy jobs.
    for (const [name, { used, capacity }] of Object.entries(slots)) {
      if (used >= capacity) {
        const slotReason = `Resource slot "${name}" full: ${used}/${capacity}`;
        reason = reason ? `${reason}; ${slotReason}` : slotReason;
        // Don't mark unhealthy — slot saturation is per-job-type, not system-wide.
        // The worker uses hasCapacity() to decide per-job, not the global healthy flag.
      }
    }

    if (healthy) this.healthySampleCount++;

    this.lastCheck = {
      healthy,
      cpuLoadFactor,
      memoryUsagePercent,
      availableMemoryMb,
      coreCount,
      reason,
      slots,
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
      this.invalidateCache();
      const health = this.check();

      if (health.healthy) return health;

      // Back off, capped at 30s
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 30_000);
    }

    // Timed out — return last check regardless
    this.invalidateCache();
    return this.check();
  }

  /** Summary string for display. */
  summary(): string {
    const h = this.check();
    const status = h.healthy ? 'healthy' : 'stressed';
    const slotParts = Object.entries(h.slots)
      .map(([name, { used, capacity }]) => `${name}:${used}/${capacity}`)
      .join(' ');
    return `System ${status}: CPU ${(h.cpuLoadFactor * 100).toFixed(0)}%/${h.coreCount} cores | Memory ${(h.memoryUsagePercent * 100).toFixed(0)}% (${h.availableMemoryMb}MB free) | Slots: ${slotParts}`;
  }

  // ─── Tuning ────────────────────────────────────────────────────────

  /**
   * Analyse the metrics from this run and produce tuning recommendations.
   * Targets ~75% machine utilisation — suggests +1 increments when there's
   * headroom, -1 when the machine was stressed.
   */
  tuningReport(): TuningReport {
    const TARGET_LOAD = 0.75;
    const recommendations: TuningRecommendation[] = [];

    const slotMetrics: Record<string, SlotMetrics> = {};
    for (const [name, config] of Object.entries(this.thresholds.resourceSlots)) {
      const peak = this.peakSlotUsage.get(name) ?? 0;
      const blocks = this.slotBlockCounts.get(name) ?? 0;
      const active = this.slotActiveSamples.get(name) ?? 0;

      slotMetrics[name] = {
        peakUsage: peak,
        capacity: config.capacity,
        blockCount: blocks,
        activeSamples: active,
        totalSamples: this.metricsSampleCount,
      };

      // Suggest increase: jobs were blocked AND system had CPU/memory headroom
      const systemHadRoom = this.peakCpuLoadFactor < TARGET_LOAD && this.peakMemoryUsagePercent < TARGET_LOAD + 0.10;
      if (blocks > 0 && systemHadRoom) {
        recommendations.push({
          slot: name,
          currentCapacity: config.capacity,
          suggestedCapacity: config.capacity + 1,
          reason: `${blocks} job(s) blocked waiting, but peak CPU was ${(this.peakCpuLoadFactor * 100).toFixed(0)}% and memory ${(this.peakMemoryUsagePercent * 100).toFixed(0)}% — room for +1`,
        });
      }

      // Suggest decrease: system was stressed while this slot was heavily used
      const systemStressed = this.peakCpuLoadFactor > this.thresholds.maxLoadFactor || this.peakMemoryUsagePercent > this.thresholds.maxMemoryUsage;
      if (systemStressed && peak >= config.capacity && config.capacity > 1) {
        recommendations.push({
          slot: name,
          currentCapacity: config.capacity,
          suggestedCapacity: config.capacity - 1,
          reason: `System was stressed (CPU ${(this.peakCpuLoadFactor * 100).toFixed(0)}%, mem ${(this.peakMemoryUsagePercent * 100).toFixed(0)}%) while "${name}" was at peak capacity — suggest -1`,
        });
      }
    }

    return {
      recommendations,
      peakCpuLoadFactor: this.peakCpuLoadFactor,
      peakMemoryUsagePercent: this.peakMemoryUsagePercent,
      healthySamples: this.healthySampleCount,
      totalSamples: this.metricsSampleCount,
      slotMetrics,
    };
  }

  /** Reset all metrics counters for a new worker run. */
  resetMetrics(): void {
    this.peakSlotUsage.clear();
    this.slotBlockCounts.clear();
    this.slotActiveSamples.clear();
    this.metricsSampleCount = 0;
    this.peakCpuLoadFactor = 0;
    this.peakMemoryUsagePercent = 0;
    this.healthySampleCount = 0;
  }

  private invalidateCache(): void {
    this.lastCheckTime = 0;
  }
}
