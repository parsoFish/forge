import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import type { BudgetConfig } from '../budget/budget-tracker.js';
import { DEFAULT_BUDGET } from '../budget/budget-tracker.js';
import type { ResourceSlotConfig } from '../monitor/resource-monitor.js';
import { DEFAULT_RESOURCE_SLOTS } from '../monitor/resource-monitor.js';

/**
 * Adaptive concurrency configuration.
 *
 * Controls how the system scales agent count based on real CPU/memory
 * pressure rather than static limits. The adaptive concurrency module
 * reads these values to decide when to add or remove agents.
 */
export interface ConcurrencyConfig {
  /** Hard maximum concurrent agents. Default: core count / 2, min 2 */
  readonly ceiling: number;
  /** Target CPU load factor (0-1). Scale up below this. Default: 0.65 */
  readonly targetCpuLoad: number;
  /** CPU load above which we MUST scale down immediately. Default: 0.85 */
  readonly criticalCpuLoad: number;
  /** Minimum free memory (MB) per additional agent. Default: 800 */
  readonly memoryPerAgentMb: number;
}

export interface ForgeSettings {
  /** Root workspace directory containing all projects */
  readonly workspaceRoot: string;

  /** Subdirectory containing managed projects (relative to workspace root) */
  readonly projectsDir: string;

  /** Project names (resolved as projectsDir/<name>) */
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

  /**
   * Adaptive concurrency — CPU/memory-driven agent scaling.
   * Replaces static maxConcurrency with dynamic scaling that responds
   * to actual system load. The ceiling is the absolute hard cap.
   */
  readonly concurrency: ConcurrencyConfig;

  /**
   * Cost tracking configuration. Budget is informational only —
   * subscription rate limits are the real cap. These thresholds
   * trigger warnings but don't gate job dispatch.
   */
  readonly costTracking: BudgetConfig;

  /** Named resource slots with capacity limits (build, browser, devServer) */
  readonly resourceSlots: Readonly<Record<string, ResourceSlotConfig>>;

  /** Whether to auto-create PRs or just prepare branches */
  readonly autoCreatePR: boolean;

  /** Research agent interval in hours (0 = disabled) */
  readonly researchIntervalHours: number;
}

const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  ceiling: Math.max(2, Math.floor(cpus().length / 2)),
  targetCpuLoad: 0.65,
  criticalCpuLoad: 0.85,
  memoryPerAgentMb: 800,
};

const DEFAULT_SETTINGS: ForgeSettings = {
  workspaceRoot: process.cwd(),
  projectsDir: 'projects',
  projects: [],             // Auto-discovered from projectsDir if empty
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
  concurrency: DEFAULT_CONCURRENCY,
  costTracking: DEFAULT_BUDGET,
  resourceSlots: DEFAULT_RESOURCE_SLOTS,
  autoCreatePR: true,
  researchIntervalHours: 24,
};

const SETTINGS_FILE = 'forge.config.json';

export function loadSettings(workspaceRoot?: string): ForgeSettings {
  const root = workspaceRoot ?? process.cwd();
  const configPath = resolve(root, SETTINGS_FILE);

  let settings: ForgeSettings;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    // Support both new config shape and legacy fields for backward compat
    const overrides = JSON.parse(raw) as Partial<ForgeSettings> & {
      maxConcurrency?: number;
      budget?: BudgetConfig;
      resourceThresholds?: { minAvailableMemoryMb?: number; resourceSlots?: Record<string, ResourceSlotConfig> };
    };

    // Migrate legacy maxConcurrency → concurrency.ceiling
    const legacyCeiling = overrides.maxConcurrency;

    settings = {
      ...DEFAULT_SETTINGS,
      ...overrides,
      workspaceRoot: root,
      models: {
        ...DEFAULT_SETTINGS.models,
        ...(overrides.models ?? {}),
      },
      concurrency: {
        ...DEFAULT_CONCURRENCY,
        ...(overrides.concurrency ?? {}),
        // Legacy maxConcurrency overrides ceiling if concurrency.ceiling not set
        ...(legacyCeiling && !overrides.concurrency?.ceiling ? { ceiling: legacyCeiling } : {}),
      },
      costTracking: {
        ...DEFAULT_BUDGET,
        ...(overrides.costTracking ?? overrides.budget ?? {}),
      },
      resourceSlots: {
        ...DEFAULT_RESOURCE_SLOTS,
        ...(overrides.resourceSlots ?? overrides.resourceThresholds?.resourceSlots ?? {}),
      },
    };
  } else {
    settings = { ...DEFAULT_SETTINGS, workspaceRoot: root };
  }

  // Auto-discover projects from projectsDir if none specified
  if (settings.projects.length === 0) {
    const projectsPath = resolve(root, settings.projectsDir);
    if (existsSync(projectsPath)) {
      const discovered = readdirSync(projectsPath, { withFileTypes: true })
        .filter((entry: import('node:fs').Dirent) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry: import('node:fs').Dirent) => entry.name);
      settings = { ...settings, projects: discovered };
    }
  }

  return settings;
}

/**
 * Resolve a project name to its full filesystem path.
 * Uses projectsDir to locate projects within the workspace.
 */
export function resolveProjectPath(settings: ForgeSettings, projectName: string): string {
  return resolve(settings.workspaceRoot, settings.projectsDir, projectName);
}
