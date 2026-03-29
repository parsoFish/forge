/**
 * Post-merge health check — verifies project tests pass on main after a PR merges.
 *
 * WHY: Cycle 2 revealed that squash-merging stacked PRs can silently break main.
 * Individual PRs pass tests on their own branches, but after squash merge, source
 * files from parent branches are lost, causing test failures on main.
 *
 * This module provides:
 * - Language-agnostic test command discovery (Node, Python, Go, Rust, Make)
 * - Isolated health checks in a git worktree (no interference with ongoing work)
 * - Merge train halting when health checks fail
 *
 * The health check runs AFTER each merge. If it fails, the merge train halts —
 * dependent PRs are blocked until main is fixed.
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import type { EventLog } from '../../events/event-log.js';
import type { StateStore } from '../../state/store.js';

export interface HealthCheckResult {
  readonly passed: boolean;
  readonly command: string;
  readonly output: string;
  readonly durationMs: number;
}

/**
 * Auto-detect the test command for a project by inspecting build tool config files.
 *
 * Language-agnostic: checks for package.json, Makefile, pyproject.toml, go.mod,
 * Cargo.toml in that order. Returns null if no test command can be discovered.
 */
export function discoverTestCommand(projectPath: string): string | null {
  // Node.js / TypeScript / JavaScript
  const pkgPath = resolve(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.['test:ci']) return 'npm run test:ci';
      if (pkg.scripts?.test) return 'npm test';
    } catch { /* malformed package.json — skip */ }
  }

  // Makefile with test target
  const makePath = resolve(projectPath, 'Makefile');
  if (existsSync(makePath)) {
    try {
      const content = readFileSync(makePath, 'utf-8');
      if (/^test\s*:/m.test(content)) return 'make test';
    } catch { /* unreadable — skip */ }
  }

  // Python (pytest)
  if (existsSync(resolve(projectPath, 'pyproject.toml')) || existsSync(resolve(projectPath, 'setup.py'))) {
    return 'python -m pytest';
  }

  // Go
  if (existsSync(resolve(projectPath, 'go.mod'))) {
    return 'go test ./...';
  }

  // Rust
  if (existsSync(resolve(projectPath, 'Cargo.toml'))) {
    return 'cargo test';
  }

  return null;
}

/**
 * Run a post-merge health check on the project's main branch.
 *
 * Creates an isolated git worktree on main, installs dependencies if needed,
 * runs the project's test command, and cleans up. Returns pass/fail with output.
 *
 * The worktree is placed under `{workspaceRoot}/.forge/worktrees/` alongside
 * the existing PR fix worktrees.
 */
export function runPostMergeHealthCheck(
  projectPath: string,
  project: string,
  prNumber: number,
  workspaceRoot: string,
  eventLog: EventLog,
): HealthCheckResult {
  const testCmd = discoverTestCommand(projectPath);
  if (!testCmd) {
    console.log(chalk.dim(`  Health check: no test command discovered for ${project} — skipping`));
    return { passed: true, command: '(none)', output: 'No test command discovered — skipped', durationMs: 0 };
  }

  const worktreeBase = resolve(workspaceRoot, '.forge', 'worktrees');
  const worktreeName = `health-check-${project}-${prNumber}`;
  const worktreePath = resolve(worktreeBase, worktreeName);
  const start = Date.now();

  console.log(chalk.dim(`  Health check: running ${testCmd} on main for ${project}...`));

  try {
    // Clean up any stale worktree from a previous crash
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* no stale worktree — fine */ }

    // Fetch latest main
    execSync('git fetch origin main', {
      cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create worktree on origin/main (detached — we don't need a local branch)
    mkdirSync(worktreeBase, { recursive: true });
    execSync(`git worktree add "${worktreePath}" origin/main --detach`, {
      cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Install dependencies based on the ecosystem
    installDependencies(worktreePath, testCmd);

    // Run tests
    const output = execSync(testCmd, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 minute timeout
    });

    const durationMs = Date.now() - start;
    console.log(chalk.green(`  ✓ Health check passed for ${project} after PR #${prNumber} (${(durationMs / 1000).toFixed(1)}s)`));

    eventLog.emit({
      type: 'health.check.pass',
      project,
      summary: `Health check passed after PR #${prNumber} merge (${testCmd}, ${(durationMs / 1000).toFixed(1)}s)`,
    });

    return { passed: true, command: testCmd, output: output.slice(-500), durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errOutput = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
    const truncated = errOutput.slice(-1000);

    console.log(chalk.bold.red(`  ✗ Health check FAILED for ${project} after PR #${prNumber}`));
    console.log(chalk.red(`    Command: ${testCmd}`));
    // Show last few lines of output for quick diagnosis
    const lastLines = truncated.split('\n').slice(-5).join('\n    ');
    if (lastLines.trim()) {
      console.log(chalk.dim(`    ${lastLines}`));
    }

    eventLog.emit({
      type: 'health.check.fail',
      project,
      summary: `HEALTH CHECK FAILED after PR #${prNumber} merge (${testCmd}). Merge train halted.`,
    });

    return { passed: false, command: testCmd, output: truncated, durationMs };
  } finally {
    cleanupWorktree(projectPath, worktreePath);
  }
}

/**
 * Halt the merge train for a project after a health check failure.
 *
 * Marks all pending/blocked close-out items in the project as blocked with a
 * clear reason. This prevents further merges until the health issue is resolved.
 *
 * Returns the number of items blocked.
 */
export function haltMergeTrain(
  store: StateStore,
  project: string,
  failedPrNumber: number,
  eventLog: EventLog,
): number {
  const items = store.getWorkItemsByProject(project);
  let blockedCount = 0;

  for (const item of items) {
    if (!item.closeOut) continue;
    if (item.status === 'completed' || item.status === 'failed') continue;
    // Don't re-block the PR that just failed
    if (item.closeOut.prNumber === failedPrNumber) continue;

    item.status = 'blocked';
    item.blockReason = `Merge train halted: health check failed after PR #${failedPrNumber} — fix main before continuing`;
    item.updatedAt = new Date().toISOString();
    store.saveWorkItem(item);
    blockedCount++;
  }

  if (blockedCount > 0) {
    console.log(chalk.bold.yellow(`  ⚠ Merge train halted: ${blockedCount} close-out(s) blocked until main is fixed`));
    eventLog.emit({
      type: 'health.check.fail',
      project,
      summary: `Merge train halted: ${blockedCount} close-outs blocked after PR #${failedPrNumber} health check failure`,
    });
  }

  return blockedCount;
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Install dependencies in the worktree based on the detected ecosystem.
 * Fails silently — if install fails, the test command will report the real error.
 */
function installDependencies(worktreePath: string, testCmd: string): void {
  try {
    if (testCmd.startsWith('npm')) {
      // Prefer ci for reproducible installs, fall back to install
      execSync('npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts', {
        cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000, // 2 minute timeout for install
      });
    } else if (testCmd.startsWith('python') || testCmd.startsWith('pytest')) {
      // Install Python project in editable mode if setup exists
      if (existsSync(resolve(worktreePath, 'pyproject.toml'))) {
        execSync('pip install -e ".[test]" 2>/dev/null || pip install -e . 2>/dev/null', {
          cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
      }
    }
    // Go and Rust handle dependencies automatically during test runs
  } catch { /* install failure — test command will surface the real error */ }
}

/** Clean up a health check worktree. Best-effort — never throws. */
function cleanupWorktree(projectPath: string, worktreePath: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Force cleanup if git worktree remove fails
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
    try {
      execSync('git worktree prune', {
        cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* best effort */ }
  }
}
