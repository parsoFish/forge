/**
 * Budget tracker — monitors API spend against a configured limit.
 *
 * Reads cost data from the event log and compares against the user's
 * configured budget. The orchestrator checks this before spawning agents
 * and pauses work when the budget is exhausted.
 *
 * Budget state persists to .forge/budget.json so costs survive restarts.
 *
 * WHY these limits exist:
 * Claude Code subscriptions (Pro, Max 5x, Max 20x) enforce usage via
 * weekly rolling token/request windows — NOT dollar amounts. The SDK
 * reports API-equivalent USD costs, but those don't map directly to
 * the subscription's allowance. We track these API-equivalent costs as
 * a *proxy* for consumption. The limits here are generous guardrails
 * to prevent runaway loops, not precise subscription metering.
 *
 * The weekly window matches how Claude Code reports usage to the user.
 * Per-run limits exist to catch infinite-loop pathologies, not to
 * micro-manage a single orchestration session.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BudgetConfig {
  /** Maximum API-equivalent USD per orchestrator run (0 = unlimited) */
  readonly maxRunBudgetUsd: number;
  /** Maximum API-equivalent USD per rolling 7-day window (0 = unlimited) */
  readonly maxWeeklyBudgetUsd: number;
  /** Warn when this percentage of budget is consumed */
  readonly warnAtPercent: number;
}

interface BudgetState {
  /** Total cost accumulated in the current run */
  currentRunCostUsd: number;
  /** Per-day cost tracking: { "2026-03-03": 1.23, ... } */
  dailyCosts: Record<string, number>;
  /** Timestamp of last update */
  lastUpdated: string;
}

/**
 * Default budget tuned for Claude Max 5x ($100/mo).
 *
 * Max 5x gives ~5x the Pro weekly token allowance. A typical agent
 * invocation costs $0.30–$2.00 in API-equivalent terms. Processing
 * 20 work items through a full pipeline (design → test → develop → PR)
 * might cost ~$40–$80 in API-equivalent USD.
 *
 * - Per-run: $75 — enough for a large batch without hitting the ceiling.
 * - Weekly: $150 — allows multiple full runs across a week while leaving
 *   headroom for manual Claude Code usage.
 *
 * Override in forge.config.json if you're on a different plan.
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  maxRunBudgetUsd: 75.00,
  maxWeeklyBudgetUsd: 150.00,
  warnAtPercent: 80,
};

export class BudgetTracker {
  private state: BudgetState;
  private readonly config: BudgetConfig;
  private readonly statePath: string;
  private readonly today: string;
  private _warned = false;

  constructor(forgeRoot: string, config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET, ...config };
    this.statePath = join(forgeRoot, 'budget.json');
    this.today = new Date().toISOString().slice(0, 10);
    this.state = this.loadState();
  }

  /**
   * Record a cost from an agent run.
   * Returns { allowed: false } if budget is exhausted.
   */
  recordCost(costUsd: number): { allowed: boolean; remaining: number; warning?: string } {
    this.state.currentRunCostUsd += costUsd;
    this.state.dailyCosts[this.today] = (this.state.dailyCosts[this.today] ?? 0) + costUsd;
    this.state.lastUpdated = new Date().toISOString();
    this.saveState();

    const runRemaining = this.config.maxRunBudgetUsd > 0
      ? this.config.maxRunBudgetUsd - this.state.currentRunCostUsd
      : Infinity;

    const weeklyRemaining = this.config.maxWeeklyBudgetUsd > 0
      ? this.config.maxWeeklyBudgetUsd - this.weekCost
      : Infinity;

    const remaining = Math.min(runRemaining, weeklyRemaining);

    // Check if budget exhausted
    if (remaining <= 0) {
      return { allowed: false, remaining: 0 };
    }

    // Check if we should warn
    let warning: string | undefined;
    if (!this._warned) {
      const runPercent = this.config.maxRunBudgetUsd > 0
        ? (this.state.currentRunCostUsd / this.config.maxRunBudgetUsd) * 100
        : 0;
      const weeklyPercent = this.config.maxWeeklyBudgetUsd > 0
        ? (this.weekCost / this.config.maxWeeklyBudgetUsd) * 100
        : 0;

      if (runPercent >= this.config.warnAtPercent || weeklyPercent >= this.config.warnAtPercent) {
        this._warned = true;
        warning = `Budget warning: run $${this.state.currentRunCostUsd.toFixed(2)}/$${this.config.maxRunBudgetUsd.toFixed(2)} | week $${this.weekCost.toFixed(2)}/$${this.config.maxWeeklyBudgetUsd.toFixed(2)}`;
      }
    }

    return { allowed: true, remaining, warning };
  }

  /**
   * Check if budget allows another agent to run (without recording cost).
   */
  canAfford(estimatedCostUsd = 0.50): boolean {
    const runRemaining = this.config.maxRunBudgetUsd > 0
      ? this.config.maxRunBudgetUsd - this.state.currentRunCostUsd
      : Infinity;

    const weeklyRemaining = this.config.maxWeeklyBudgetUsd > 0
      ? this.config.maxWeeklyBudgetUsd - this.weekCost
      : Infinity;

    return Math.min(runRemaining, weeklyRemaining) >= estimatedCostUsd;
  }

  /** Total cost of the current run. */
  get runCost(): number { return this.state.currentRunCostUsd; }

  /** Total cost for today. */
  get todayCost(): number { return this.state.dailyCosts[this.today] ?? 0; }

  /**
   * Rolling 7-day cost — sums dailyCosts for the last 7 calendar days.
   * Matches how Claude Code subscription usage windows work.
   */
  get weekCost(): number {
    let total = 0;
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      total += this.state.dailyCosts[key] ?? 0;
    }
    return total;
  }

  /** Reset the current run counter (for a new run). */
  resetRun(): void {
    this.state.currentRunCostUsd = 0;
    this._warned = false;
    this.saveState();
  }

  /** Summary for display. */
  summary(): string {
    const runLimit = this.config.maxRunBudgetUsd > 0
      ? `$${this.state.currentRunCostUsd.toFixed(2)} / $${this.config.maxRunBudgetUsd.toFixed(2)}`
      : `$${this.state.currentRunCostUsd.toFixed(2)} (no limit)`;

    const weekLimit = this.config.maxWeeklyBudgetUsd > 0
      ? `$${this.weekCost.toFixed(2)} / $${this.config.maxWeeklyBudgetUsd.toFixed(2)}`
      : `$${this.weekCost.toFixed(2)} (no limit)`;

    return `Run: ${runLimit} | Week: ${weekLimit}`;
  }

  // --- Persistence ---

  private loadState(): BudgetState {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf-8')) as Partial<BudgetState>;
        // Defensive defaults — archiveCycle may write a partial budget.json
        return {
          currentRunCostUsd: raw.currentRunCostUsd ?? 0,
          dailyCosts: raw.dailyCosts ?? {},
          lastUpdated: raw.lastUpdated ?? new Date().toISOString(),
        };
      } catch {
        // Corrupted — start fresh
      }
    }
    return {
      currentRunCostUsd: 0,
      dailyCosts: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }
}
