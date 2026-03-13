/**
 * Crash analyzer — diagnoses why a previous forge session crashed.
 *
 * WHY this exists:
 * When forge crashes mid-implement, the worker recovers stuck jobs on restart
 * (resets running → queued). But it doesn't know WHY the crash happened.
 * Without diagnosis, the same issue repeats — a trafficGame build that OOMs
 * will OOM again if nothing changes.
 *
 * The crash analyzer inspects multiple signals to build a diagnosis:
 * 1. System logs (dmesg) for OOM killer entries
 * 2. Event log for last agent activity before the crash
 * 3. Resource profiler data for memory/CPU patterns
 * 4. Worker status file for last known resource state
 *
 * The diagnosis feeds into:
 * - ImplementSession.crashLog (for display to user)
 * - Resource profiler (to adjust future estimates)
 * - Forge learnings (persistent knowledge)
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export interface CrashDiagnosis {
  /** What caused the crash (best guess). */
  readonly cause: 'oom' | 'rate-limit' | 'unknown';
  /** Human-readable summary of the diagnosis. */
  readonly summary: string;
  /** Which project's job was most likely responsible. */
  readonly project?: string;
  /** Which job type was running. */
  readonly jobType?: string;
  /** Peak memory usage at time of crash (MB). */
  readonly peakMemoryMb?: number;
  /** Recommendations for avoiding this in the future. */
  readonly recommendations: readonly string[];
}

/**
 * Analyze why the previous forge session crashed.
 *
 * Checks multiple signals and returns a structured diagnosis.
 * This is called on startup when stuck jobs are detected.
 */
export function analyzeCrash(forgeRoot: string): CrashDiagnosis {
  const signals: string[] = [];
  let cause: CrashDiagnosis['cause'] = 'unknown';
  let project: string | undefined;
  let jobType: string | undefined;
  let peakMemoryMb: number | undefined;
  const recommendations: string[] = [];

  // ── 1. Check dmesg for OOM killer ──────────────────────────────
  const oomInfo = checkOomKiller();
  if (oomInfo) {
    cause = 'oom';
    signals.push(`OOM killer triggered: ${oomInfo}`);
    recommendations.push('Reduce build concurrency or increase memory limits');
  }

  // ── 2. Check worker status file for last known state ───────────
  const statusPath = join(forgeRoot, 'worker-status.json');
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, 'utf-8'));
      const memPercent = status.resources?.memoryUsagePercent;
      const availMb = status.resources?.availableMemoryMb;

      if (memPercent > 0.9) {
        if (cause === 'unknown') cause = 'oom';
        signals.push(`Memory at ${(memPercent * 100).toFixed(0)}% at last status (${availMb}MB free)`);
        peakMemoryMb = Math.round(
          (status.resources?.availableMemoryMb ?? 0) / (1 - memPercent),
        );
        recommendations.push('Lower maxMemoryUsage threshold in forge.config.json');
      }

      if (status.rateLimitResetAt && status.rateLimitResetAt > Date.now() - 3600_000) {
        if (cause === 'unknown') cause = 'rate-limit';
        signals.push('Rate limit was active at time of crash');
      }
    } catch {
      // Status file corrupted or missing — that's fine
    }
  }

  // ── 3. Check event log for last activity ───────────────────────
  const eventsPath = join(forgeRoot, 'events.jsonl');
  if (existsSync(eventsPath)) {
    try {
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.trim().split('\n');
      // Check last 20 events for patterns
      const recent = lines.slice(-20);

      for (const line of recent.reverse()) {
        try {
          const event = JSON.parse(line);

          // Find the last job.start to identify what was running
          if (event.type === 'job.start' && !jobType) {
            jobType = event.summary?.match(/Starting job: (\S+)/)?.[1];
            project = event.project ?? event.summary?.match(/for (\S+)/)?.[1];
          }

          // Check for agent errors near the crash
          if (event.type === 'agent.error') {
            signals.push(`Agent error near crash: ${event.summary?.slice(0, 100)}`);
          }

          // Check for orphaned agents
          if (event.type === 'agent.orphaned') {
            signals.push(`Orphaned agent detected: ${event.summary?.slice(0, 100)}`);
          }
        } catch {
          // Malformed event line — skip
        }
      }
    } catch {
      // Event log unreadable
    }
  }

  // ── 4. Build summary ──────────────────────────────────────────
  let summary: string;
  if (cause === 'oom') {
    summary = `Likely OOM crash${project ? ` during ${jobType} for ${project}` : ''}.`;
    if (peakMemoryMb) summary += ` Peak memory: ~${peakMemoryMb}MB.`;
    summary += ` Signals: ${signals.join('; ')}`;
  } else if (cause === 'rate-limit') {
    summary = `Crash during rate limit recovery. ${signals.join('; ')}`;
    recommendations.push('Check rate limit handling in worker');
  } else {
    summary = signals.length > 0
      ? `Unknown crash cause. Signals: ${signals.join('; ')}`
      : 'No crash signals detected — may have been a clean shutdown or external kill.';
  }

  if (recommendations.length === 0) {
    recommendations.push('Monitor system resources during next run');
  }

  return {
    cause,
    summary,
    project,
    jobType,
    peakMemoryMb,
    recommendations,
  };
}

/**
 * Check dmesg for recent OOM killer activity.
 *
 * Returns a description of the OOM event if found, null otherwise.
 * Only checks last 100 lines of dmesg to keep it fast.
 */
function checkOomKiller(): string | null {
  try {
    // dmesg may require root — try it, fail gracefully
    const output = execSync('dmesg --time-format iso 2>/dev/null | tail -100', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const oomLines = output.split('\n').filter(
      line => line.includes('Out of memory') || line.includes('oom-kill') || line.includes('Killed process'),
    );

    if (oomLines.length > 0) {
      return oomLines[0].trim().slice(0, 200);
    }
  } catch {
    // dmesg not available or no permission — that's fine
  }

  return null;
}
