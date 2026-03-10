/**
 * Adaptive render throttle — adjusts UI refresh interval based on
 * system memory pressure.
 *
 * WHY: Under memory pressure, GC pauses and terminal output contention
 * cause the three right-side tmux panes to flicker and corrupt. Slowing
 * the render rate reduces both memory allocation churn and stdout
 * contention when the system is already stressed.
 *
 * Reads /proc/meminfo (same approach as resource-monitor.ts) to
 * determine MemAvailable vs MemTotal, then maps usage percentage
 * to a render interval tier.
 */

import { readFileSync } from 'node:fs';

export enum MemoryPressure {
  Normal = 'normal',
  Elevated = 'elevated',
  High = 'high',
  Critical = 'critical',
}

/** Render interval in ms for each pressure level. */
export const PRESSURE_INTERVALS: Readonly<Record<MemoryPressure, number>> = {
  [MemoryPressure.Normal]: 2_000,
  [MemoryPressure.Elevated]: 4_000,
  [MemoryPressure.High]: 8_000,
  [MemoryPressure.Critical]: 15_000,
};

/** Thresholds (memory usage percent) for each pressure level. */
const THRESHOLDS = {
  elevated: 0.75,
  high: 0.85,
  critical: 0.92,
} as const;

/**
 * Read memory usage from /proc/meminfo and return the appropriate
 * render interval in milliseconds.
 *
 * Falls back to the normal (2s) interval if /proc/meminfo cannot
 * be read or parsed (e.g. non-Linux systems).
 */
export function getAdaptiveIntervalMs(): number {
  const pressure = getMemoryPressure();
  return PRESSURE_INTERVALS[pressure];
}

/**
 * Determine the current memory pressure level.
 * Exported for testing and for panes that want to display pressure info.
 */
export function getMemoryPressure(): MemoryPressure {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');

    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)\s+kB/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);

    if (!totalMatch || !availMatch) return MemoryPressure.Normal;

    const totalKb = parseInt(totalMatch[1], 10);
    const availKb = parseInt(availMatch[1], 10);

    if (totalKb === 0) return MemoryPressure.Normal;

    const usagePercent = (totalKb - availKb) / totalKb;

    if (usagePercent >= THRESHOLDS.critical) return MemoryPressure.Critical;
    if (usagePercent >= THRESHOLDS.high) return MemoryPressure.High;
    if (usagePercent >= THRESHOLDS.elevated) return MemoryPressure.Elevated;
    return MemoryPressure.Normal;
  } catch {
    return MemoryPressure.Normal;
  }
}
