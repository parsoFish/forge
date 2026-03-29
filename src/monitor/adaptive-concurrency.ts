/**
 * Adaptive concurrency — dynamically scales agent count based on system load.
 *
 * Instead of a static maxConcurrency, this module calculates how many agents
 * the system can handle RIGHT NOW based on CPU load, memory pressure, and
 * learned resource profiles from past jobs.
 *
 * The algorithm:
 * 1. Start with a floor (1 agent — always allow at least one)
 * 2. Scale up when: CPU < target load AND memory available > per-agent estimate
 * 3. Scale down when: CPU > ceiling OR memory < safety floor
 * 4. Use exponential smoothing to avoid thrashing (don't scale on spikes)
 *
 * The ceiling is always bounded by a hard max (core count or config override)
 * to prevent runaway scaling even on beefy machines.
 *
 * WHY not budget-based: Claude Code subscriptions enforce usage via weekly
 * rolling token windows, not dollar amounts. The subscription IS the hard cap.
 * Forge should maximize throughput within the machine's physical limits.
 */

import { cpus } from 'node:os';
import type { ResourceMonitor, HealthCheck } from './resource-monitor.js';
import type { ResourceProfiler } from './resource-profiler.js';

export interface AdaptiveConcurrencyConfig {
  /** Minimum concurrent agents (always allow at least this many). Default: 1 */
  readonly floor: number;
  /** Maximum concurrent agents (hard ceiling). Default: core count / 2, min 2 */
  readonly ceiling: number;
  /** Target CPU load factor (0-1). Scale up below this, throttle above. Default: 0.65 */
  readonly targetCpuLoad: number;
  /** CPU load factor above which we MUST scale down. Default: 0.85 */
  readonly criticalCpuLoad: number;
  /** Minimum available memory (MB) per additional agent. Default: 800 */
  readonly memoryPerAgentMb: number;
  /** Smoothing factor for load averaging (0-1, higher = more responsive). Default: 0.3 */
  readonly smoothingAlpha: number;
  /** Ticks to wait after a change before scaling UP (let agents impact settle). Default: 6 (~18s) */
  readonly scaleUpCooldownTicks: number;
  /** Ticks to wait after a change before scaling DOWN (shorter — respond faster). Default: 2 (~6s) */
  readonly scaleDownCooldownTicks: number;
}

export interface ConcurrencyDecision {
  /** How many agents can run right now */
  readonly target: number;
  /** Why this target was chosen */
  readonly reason: string;
  /** Current smoothed CPU load */
  readonly smoothedCpuLoad: number;
  /** Available headroom in MB */
  readonly availableMemoryMb: number;
  /** Whether we're in a scale-down state */
  readonly throttled: boolean;
}

const DEFAULT_CONFIG: AdaptiveConcurrencyConfig = {
  floor: 1,
  ceiling: Math.max(2, Math.floor(cpus().length / 2)),
  targetCpuLoad: 0.65,
  criticalCpuLoad: 0.85,
  memoryPerAgentMb: 800,
  smoothingAlpha: 0.3,
  scaleUpCooldownTicks: 6,    // ~18s at 3s poll — let new agents settle before adding more
  scaleDownCooldownTicks: 2,  // ~6s — respond to pressure quickly
};

export class AdaptiveConcurrency {
  private readonly config: AdaptiveConcurrencyConfig;
  private readonly resources: ResourceMonitor;
  private readonly profiler: ResourceProfiler;

  /** Exponentially smoothed CPU load — avoids reacting to spikes. */
  private smoothedCpu = 0;
  /** Last computed target (for stability — don't change every tick). */
  private lastTarget = 1;
  /** Ticks since last change (debounce rapid scaling). */
  private ticksSinceChange = 0;

  constructor(
    resources: ResourceMonitor,
    profiler: ResourceProfiler,
    config?: Partial<AdaptiveConcurrencyConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resources = resources;
    this.profiler = profiler;
  }

  /**
   * Calculate how many agents should be running right now.
   *
   * Called each worker tick. Uses smoothed metrics to avoid thrashing.
   * The worker should compare this to its current active count to decide
   * whether to claim more jobs or stop claiming.
   */
  /**
   * Calculate how many agents should be running right now.
   *
   * Called each worker tick. Uses smoothed metrics to avoid thrashing.
   * The worker should compare this to its current active count to decide
   * whether to claim more jobs or stop claiming.
   *
   * @param effectiveSlotCeiling — when all pending jobs require resource slots
   *   (e.g. build), this caps the target to the slot capacity. Without this,
   *   the scaler thinks it can run `ceiling` agents but only `slotCapacity`
   *   can actually execute, causing burst behavior when slots free up.
   */
  evaluate(
    currentActive: number,
    pendingJobTypes?: Array<{ type: string; project?: string }>,
    effectiveSlotCeiling?: number,
  ): ConcurrencyDecision {
    const health = this.resources.check();
    this.updateSmoothedCpu(health);
    this.ticksSinceChange++;

    // Effective ceiling: the lower of the configured ceiling and the slot
    // constraint. This prevents the scaler from "banking" a high target
    // that it can't actually fill, avoiding burst-then-block behavior.
    const ceiling = effectiveSlotCeiling !== undefined
      ? Math.max(this.config.floor, Math.min(this.config.ceiling, effectiveSlotCeiling))
      : this.config.ceiling;

    const availMb = health.availableMemoryMb;

    // Critical pressure — scale down immediately, no debounce
    if (this.smoothedCpu > this.config.criticalCpuLoad || availMb < this.config.memoryPerAgentMb) {
      const target = Math.max(this.config.floor, currentActive - 1);
      return this.decide(target, health, true,
        this.smoothedCpu > this.config.criticalCpuLoad
          ? `CPU critical (${(this.smoothedCpu * 100).toFixed(0)}%)`
          : `Memory low (${availMb}MB free)`,
      );
    }

    // Asymmetric debounce:
    // - Scale UP requires longer cooldown (let new agents' CPU impact settle)
    // - Scale DOWN responds faster (protect the system)
    const wantingUp = this.smoothedCpu < this.config.targetCpuLoad && currentActive < ceiling;
    const cooldown = wantingUp ? this.config.scaleUpCooldownTicks : this.config.scaleDownCooldownTicks;

    if (this.ticksSinceChange < cooldown) {
      return this.decide(this.lastTarget, health, false,
        `stabilizing (${cooldown - this.ticksSinceChange} ticks remain)`);
    }

    // How many more agents can we fit based on memory?
    const memorySlots = Math.floor(availMb / this.config.memoryPerAgentMb);

    // How much CPU headroom do we have?
    const cpuHeadroom = this.config.targetCpuLoad - this.smoothedCpu;

    // Estimate CPU per agent from profiler data (or fallback)
    const estimatedCpuPerAgent = this.estimateCpuPerAgent(pendingJobTypes);

    // Calculate targets from both dimensions
    const cpuTarget = cpuHeadroom > 0
      ? currentActive + Math.floor(cpuHeadroom / Math.max(estimatedCpuPerAgent, 0.05))
      : Math.max(this.config.floor, currentActive - 1);

    const memTarget = memorySlots + currentActive;

    // Take the minimum of CPU, memory, and slot targets, clamped to [floor, ceiling]
    const rawTarget = Math.min(cpuTarget, memTarget);
    const target = Math.max(this.config.floor, Math.min(ceiling, rawTarget));

    // Only step by ±1 per evaluation to avoid dramatic swings
    const steppedTarget = target > this.lastTarget
      ? this.lastTarget + 1
      : target < this.lastTarget
        ? this.lastTarget - 1
        : this.lastTarget;

    const clampedTarget = Math.max(this.config.floor, Math.min(ceiling, steppedTarget));

    const reason = clampedTarget > currentActive
      ? `scaling up (CPU ${(this.smoothedCpu * 100).toFixed(0)}% < ${(this.config.targetCpuLoad * 100).toFixed(0)}% target, ${availMb}MB free${ceiling < this.config.ceiling ? `, slot-capped ${ceiling}` : ''})`
      : clampedTarget < currentActive
        ? `scaling down (CPU ${(this.smoothedCpu * 100).toFixed(0)}%, mem ${availMb}MB)`
        : `steady (CPU ${(this.smoothedCpu * 100).toFixed(0)}%, ${availMb}MB free${ceiling < this.config.ceiling ? `, slot-capped ${ceiling}` : ''})`;

    return this.decide(clampedTarget, health, false, reason);
  }

  /** Current smoothed CPU for external display. */
  get currentSmoothedCpu(): number {
    return this.smoothedCpu;
  }

  /** Current target for external display. */
  get currentTarget(): number {
    return this.lastTarget;
  }

  /** Hard ceiling for display. */
  get maxCeiling(): number {
    return this.config.ceiling;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private updateSmoothedCpu(health: HealthCheck): void {
    // Exponential moving average
    this.smoothedCpu = this.config.smoothingAlpha * health.cpuLoadFactor
      + (1 - this.config.smoothingAlpha) * this.smoothedCpu;
  }

  /**
   * Estimate how much CPU load a single agent adds, using profiler data.
   * Falls back to a conservative default if no data is available.
   */
  private estimateCpuPerAgent(pendingJobTypes?: Array<{ type: string; project?: string }>): number {
    if (!pendingJobTypes || pendingJobTypes.length === 0) {
      return 0.10; // Conservative default: each agent uses ~10% of system
    }

    // Average the estimates from the profiler for pending job types
    let totalEstimate = 0;
    let count = 0;
    for (const { type, project } of pendingJobTypes) {
      const estimate = this.profiler.estimate(type, project);
      if (estimate) {
        totalEstimate += estimate.cpuLoadFactor;
        count++;
      }
    }

    return count > 0 ? totalEstimate / count : 0.10;
  }

  private decide(
    target: number,
    health: HealthCheck,
    throttled: boolean,
    reason: string,
  ): ConcurrencyDecision {
    if (target !== this.lastTarget) {
      this.ticksSinceChange = 0;
    }
    this.lastTarget = target;

    return {
      target,
      reason,
      smoothedCpuLoad: this.smoothedCpu,
      availableMemoryMb: health.availableMemoryMb,
      throttled,
    };
  }
}
