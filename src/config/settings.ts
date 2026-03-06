import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BudgetConfig } from '../budget/budget-tracker.js';
import { DEFAULT_BUDGET } from '../budget/budget-tracker.js';
import type { ResourceThresholds } from '../monitor/resource-monitor.js';
import { DEFAULT_THRESHOLDS, DEFAULT_RESOURCE_SLOTS } from '../monitor/resource-monitor.js';

/**
 * Per-phase concurrency limits.
 *
 * Design/plan are lightweight (mostly reading) — allow more.
 * Test is moderate (may spin up test runners).
 * Develop is heavy (may spin up servers, run full test suites).
 * PR/review are lightweight but we serialize to avoid git conflicts.
 */
export interface PhaseConcurrency {
  /** Design + plan agents (lightweight, read-heavy) */
  readonly designPlan: number;
  /** Test-engineer agents (moderate, may start test runners) */
  readonly test: number;
  /** Developer agents (heavy, may start services) */
  readonly develop: number;
  /** PR + review agents (lightweight but serialize for git safety) */
  readonly prReview: number;
}

export interface ForgeSettings {
  /** Root workspace directory containing all projects */
  readonly workspaceRoot: string;

  /** Directories to treat as managed projects (relative to workspace root) */
  readonly projects: readonly string[];

  /** Default Claude model for each agent role */
  readonly models: {
    readonly architect: string;
    readonly planner: string;
    readonly testEngineer: string;
    readonly developer: string;
    readonly prCreator: string;
    readonly reviewer: string;
    readonly prReviewer: string;
    readonly researcher: string;
    readonly reflector: string;
  };

  /** Maximum iterations per agent invocation (Ralph-style loop cap) */
  readonly maxIterations: number;

  /** Overall max concurrent agent subprocesses (hard ceiling) */
  readonly maxConcurrency: number;

  /**
   * Per-phase concurrency limits.
   * The orchestrator uses these to decide how many agents of each type
   * can run simultaneously. The actual concurrency is
   * min(phaseConcurrency[phase], maxConcurrency - activeOtherPhases).
   */
  readonly phaseConcurrency: PhaseConcurrency;

  /** Budget configuration (cost limits per run and per day) */
  readonly budget: BudgetConfig;

  /** System resource thresholds for health checking */
  readonly resourceThresholds: ResourceThresholds;

  /** Whether to auto-create PRs or just prepare branches */
  readonly autoCreatePR: boolean;

  /** Research agent interval in hours (0 = disabled) */
  readonly researchIntervalHours: number;
}

const DEFAULT_PHASE_CONCURRENCY: PhaseConcurrency = {
  designPlan: 2,   // Lightweight — can run a couple
  test: 1,         // Conservative — one test agent at a time
  develop: 1,      // Conservative — one dev agent at a time
  prReview: 1,     // Serialize — avoid git branch conflicts
};

const DEFAULT_SETTINGS: ForgeSettings = {
  workspaceRoot: '/home/parso/sideProjects',
  projects: ['trafficGame', 'simplarr', 'env-optimiser', 'GitWeave'],
  models: {
    architect: 'sonnet',      // Design needs strong reasoning
    planner: 'sonnet',        // Planning needs structure
    testEngineer: 'sonnet',   // Test design needs precision
    developer: 'sonnet',      // Implementation workhorse
    prCreator: 'haiku',       // PR creation is formulaic
    reviewer: 'sonnet',       // Review needs judgment
    prReviewer: 'sonnet',     // GitHub PR review — Sonnet for speed + quality
    researcher: 'haiku',      // Research is high-volume, lower stakes
    reflector: 'sonnet',      // Reflection needs analytical depth
  },
  maxIterations: 10,
  maxConcurrency: 2,
  phaseConcurrency: DEFAULT_PHASE_CONCURRENCY,
  budget: DEFAULT_BUDGET,
  resourceThresholds: DEFAULT_THRESHOLDS,
  autoCreatePR: true,
  researchIntervalHours: 24,
};

const SETTINGS_FILE = 'forge.config.json';

export function loadSettings(workspaceRoot?: string): ForgeSettings {
  const root = workspaceRoot ?? DEFAULT_SETTINGS.workspaceRoot;
  const configPath = resolve(root, SETTINGS_FILE);

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const overrides = JSON.parse(raw) as Partial<ForgeSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...overrides,
      workspaceRoot: root,
      models: {
        ...DEFAULT_SETTINGS.models,
        ...(overrides.models ?? {}),
      },
      phaseConcurrency: {
        ...DEFAULT_PHASE_CONCURRENCY,
        ...(overrides.phaseConcurrency ?? {}),
      },
      budget: {
        ...DEFAULT_BUDGET,
        ...(overrides.budget ?? {}),
      },
      resourceThresholds: {
        ...DEFAULT_THRESHOLDS,
        ...(overrides.resourceThresholds ?? {}),
        resourceSlots: {
          ...DEFAULT_RESOURCE_SLOTS,
          ...((overrides.resourceThresholds as Partial<ResourceThresholds> | undefined)?.resourceSlots ?? {}),
        },
      },
    };
  }

  return { ...DEFAULT_SETTINGS, workspaceRoot: root };
}
