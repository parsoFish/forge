/**
 * Git workflow automation — deterministic operations that don't need inference.
 *
 * WHY this exists:
 * Previously, agents ran raw git commands via inference, leading to:
 * - Inconsistent branch naming
 * - 450+ clone operations in a few days (agents re-cloning instead of reusing)
 * - Orphaned branches after PR merges
 * - No guaranteed cleanup
 *
 * This module provides a traditional automation layer for git operations.
 * Agents still write code; this module handles the plumbing around it.
 * Branch naming is deterministic (derived from work item IDs), cleanup is
 * automated, and dependency ordering uses topological sort — not inference.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { resolve } from 'node:path';
import type { WorkItem } from '../workflow/types.js';

export interface GitWorkflowConfig {
  /** Workspace root (parent of projectsDir) */
  readonly workspaceRoot: string;
  /** Subdirectory containing projects */
  readonly projectsDir: string;
}

/** Result of a git operation — always captures stdout for logging. */
interface GitResult {
  readonly success: boolean;
  readonly output: string;
  readonly error?: string;
}

/**
 * Generate a deterministic branch name from a work item.
 *
 * Format: feat/<project>-<seq>-<slug>
 * The slug is derived from the work item title, keeping it short and readable.
 * This replaces agent-generated branch names that varied between runs.
 */
export function branchName(workItem: WorkItem): string {
  const slug = workItem.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  return `feat/${workItem.project}-${String(workItem.seq).padStart(3, '0')}-${slug}`;
}

/**
 * Deterministic git workflow operations for forge-managed projects.
 *
 * All operations work on the local checkout — no cloning. Projects must
 * already exist in the projectsDir. Operations are idempotent where possible.
 */
export class GitWorkflow {
  private readonly config: GitWorkflowConfig;

  constructor(config: GitWorkflowConfig) {
    this.config = config;
  }

  /** Resolve a project name to its filesystem path. */
  projectPath(project: string): string {
    return resolve(this.config.workspaceRoot, this.config.projectsDir, project);
  }

  // ─── Branch Management ──────────────────────────────────────────

  /**
   * Create a feature branch for a work item, starting from latest main.
   *
   * Idempotent: if the branch already exists, checks it out without error.
   * Always fetches latest main first to minimize merge conflicts.
   */
  createFeatureBranch(project: string, workItem: WorkItem): GitResult {
    const cwd = this.projectPath(project);
    const branch = workItem.branch || branchName(workItem);
    const mainBranch = this.detectMainBranch(cwd);

    // Fetch latest from remote (non-blocking if offline)
    this.git(cwd, `fetch origin ${mainBranch} --quiet`);

    // Check if branch already exists
    const existing = this.git(cwd, `branch --list ${branch}`);
    if (existing.output.trim()) {
      // Branch exists — check it out
      return this.git(cwd, `checkout ${branch}`);
    }

    // Create branch from latest main
    return this.git(cwd, `checkout -b ${branch} origin/${mainBranch}`);
  }

  /**
   * Checkout an existing branch.
   */
  checkoutBranch(project: string, branch: string): GitResult {
    return this.git(this.projectPath(project), `checkout ${branch}`);
  }

  /**
   * Ensure the branch is up to date with main by rebasing.
   * Used before pushing to reduce merge conflicts.
   */
  rebaseOnMain(project: string, branch: string): GitResult {
    const cwd = this.projectPath(project);
    const mainBranch = this.detectMainBranch(cwd);

    this.git(cwd, `fetch origin ${mainBranch} --quiet`);
    const result = this.git(cwd, `rebase origin/${mainBranch} ${branch}`);

    if (!result.success) {
      // Abort failed rebase to keep clean state
      this.git(cwd, 'rebase --abort');
    }

    return result;
  }

  // ─── PR Lifecycle ───────────────────────────────────────────────

  /**
   * Push branch and create a PR.
   *
   * Returns the PR number on success. Uses gh CLI for PR creation.
   * If a PR already exists for this branch, returns its number instead.
   */
  createPR(
    project: string,
    branch: string,
    title: string,
    body: string,
  ): { prNumber: number } & GitResult {
    const cwd = this.projectPath(project);

    // Push with -u to set upstream
    const push = this.git(cwd, `push -u origin ${branch}`);
    if (!push.success) {
      return { ...push, prNumber: 0 };
    }

    // Check if PR already exists for this branch
    const existing = this.git(cwd, `gh pr view ${branch} --json number --jq .number`);
    if (existing.success && existing.output.trim()) {
      const prNumber = parseInt(existing.output.trim(), 10);
      if (!isNaN(prNumber)) {
        return { success: true, output: `PR #${prNumber} already exists`, prNumber };
      }
    }

    // Create PR via gh
    const result = this.git(
      cwd,
      `gh pr create --head ${branch} --title "${escapeShell(title)}" --body "${escapeShell(body)}"`,
    );

    if (!result.success) {
      return { ...result, prNumber: 0 };
    }

    // Extract PR number from gh output (URL or number)
    const prMatch = result.output.match(/\/pull\/(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : 0;

    return { ...result, prNumber };
  }

  /**
   * Merge a PR using squash strategy (default for forge).
   */
  mergePR(project: string, prNumber: number, strategy: 'squash' | 'merge' | 'rebase' = 'squash'): GitResult {
    const cwd = this.projectPath(project);
    return this.git(cwd, `gh pr merge ${prNumber} --${strategy} --delete-branch`);
  }

  // ─── Cleanup ────────────────────────────────────────────────────

  /**
   * Clean up after a PR is merged.
   *
   * 1. Switch to main
   * 2. Pull the squash commit
   * 3. Delete local feature branch
   * 4. Prune remote tracking branches
   */
  cleanupAfterMerge(project: string, branch: string): GitResult {
    const cwd = this.projectPath(project);
    const mainBranch = this.detectMainBranch(cwd);

    // Switch to main
    const checkout = this.git(cwd, `checkout ${mainBranch}`);
    if (!checkout.success) return checkout;

    // Pull squash commit
    const pull = this.git(cwd, `pull origin ${mainBranch}`);
    if (!pull.success) return pull;

    // Delete local branch (ignore errors — may already be deleted)
    this.git(cwd, `branch -D ${branch}`);

    // Prune stale remote tracking branches
    return this.git(cwd, 'remote prune origin');
  }

  /**
   * Sync main branch with remote.
   * Used at the start of a cycle to ensure we're up to date.
   */
  syncMain(project: string): GitResult {
    const cwd = this.projectPath(project);
    const mainBranch = this.detectMainBranch(cwd);

    this.git(cwd, `checkout ${mainBranch}`);
    const pull = this.git(cwd, `pull origin ${mainBranch}`);
    this.git(cwd, 'remote prune origin');

    return pull;
  }

  /**
   * Delete all local branches that have been merged to main.
   * Useful for post-cycle cleanup.
   */
  pruneLocalBranches(project: string): GitResult {
    const cwd = this.projectPath(project);
    const mainBranch = this.detectMainBranch(cwd);

    // List merged branches (excluding main and current)
    const merged = this.git(cwd, `branch --merged ${mainBranch}`);
    if (!merged.success) return merged;

    const branches = merged.output
      .split('\n')
      .map(b => b.trim().replace(/^\*\s*/, ''))
      .filter(b => b && b !== mainBranch && b !== 'main' && b !== 'master');

    for (const branch of branches) {
      this.git(cwd, `branch -d ${branch}`);
    }

    return { success: true, output: `Pruned ${branches.length} merged branch(es)` };
  }

  // ─── Dependency Ordering ────────────────────────────────────────

  /**
   * Topological sort of work items by dependsOn.
   *
   * Returns items grouped into layers:
   * - Layer 0: items with no dependencies (can run in parallel)
   * - Layer 1: items that depend only on layer 0 items
   * - Layer 2: items that depend on layer 0 or 1 items
   * - etc.
   *
   * This is a deterministic algorithm — no inference needed.
   */
  static dependencyLayers(workItems: readonly WorkItem[]): readonly WorkItem[][] {
    const itemById = new Map(workItems.map(i => [i.id, i]));
    const layers: WorkItem[][] = [];
    const assigned = new Set<string>();

    // Repeat until all items are assigned to a layer
    let remaining = [...workItems];
    while (remaining.length > 0) {
      const layer: WorkItem[] = [];

      for (const item of remaining) {
        const depsResolved = item.dependsOn.every(
          depId => assigned.has(depId) || !itemById.has(depId),
        );
        if (depsResolved) {
          layer.push(item);
        }
      }

      // Cycle detection: if no items could be assigned, break the cycle
      if (layer.length === 0) {
        // Force-assign remaining items (broken deps)
        layers.push(remaining);
        break;
      }

      for (const item of layer) {
        assigned.add(item.id);
      }

      layers.push(layer);
      remaining = remaining.filter(i => !assigned.has(i.id));
    }

    return layers;
  }

  // ─── Query ──────────────────────────────────────────────────────

  /**
   * Get the current branch name for a project.
   */
  currentBranch(project: string): string {
    const result = this.git(this.projectPath(project), 'rev-parse --abbrev-ref HEAD');
    return result.output.trim();
  }

  /**
   * Check if there are uncommitted changes in the project.
   */
  isDirty(project: string): boolean {
    const result = this.git(this.projectPath(project), 'status --porcelain');
    return result.output.trim().length > 0;
  }

  /**
   * Get the HEAD SHA for the current branch.
   */
  headSha(project: string): string {
    const result = this.git(this.projectPath(project), 'rev-parse HEAD');
    return result.output.trim();
  }

  // ─── Internals ──────────────────────────────────────────────────

  /**
   * Detect whether the repo uses 'main' or 'master' as its default branch.
   */
  private detectMainBranch(cwd: string): string {
    const result = this.git(cwd, 'symbolic-ref refs/remotes/origin/HEAD');
    if (result.success) {
      const ref = result.output.trim();
      return ref.replace('refs/remotes/origin/', '');
    }
    // Fallback: check if 'main' exists
    const mainExists = this.git(cwd, 'show-ref --verify refs/heads/main');
    return mainExists.success ? 'main' : 'master';
  }

  /** Run a git command, capturing output. Never throws. */
  private git(cwd: string, command: string): GitResult {
    const opts: ExecSyncOptions = {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    };

    try {
      const output = execSync(`git ${command}`, opts) as string;
      return { success: true, output: output ?? '' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Extract stderr if available
      const stderr = (err as { stderr?: string })?.stderr ?? '';
      return { success: false, output: stderr, error };
    }
  }
}

/** Escape a string for safe shell interpolation (double-quote context). */
function escapeShell(s: string): string {
  return s.replace(/["\\$`!]/g, '\\$&');
}
