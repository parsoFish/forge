/**
 * PR Review Stage — scans GitHub for open PRs and reviews each one.
 *
 * WHY a dedicated stage:
 * - PR reviews must take priority over new implementation (priority=5+)
 * - Reviews serve two purposes: quality gate AND human direction extraction
 * - Learning from human comments closes the loop between human oversight and autonomous work
 *
 * Execution model:
 * - `scanOpenPRs` scans repos and returns PR metadata with merge-order analysis
 * - `runPRReviewStage` executes a single PR review (called by worker for each review job)
 *
 * Stacked-branch handling:
 * - Detects when PR branches are stacked on each other by checking if another PR's
 *   HEAD commit appears in the commit log of a later PR.
 * - Assigns mergeLayer (0=foundation, 1=children, 2=grandchildren...) and priority offset.
 * - Agents are told to review only the unique delta of their PR, not shared ancestor commits.
 * - Writes a merge-order plan to .forge/learnings/ so both humans and agents understand the sequence.
 *
 * The review agent is GitHub-aware: it uses `gh` CLI to fetch PR data, comments,
 * and CI status, then posts the review back to GitHub.
 */

import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as readline from 'node:readline';
import chalk from 'chalk';
import type { AgentDefinition } from '../../agents/types.js';
import type { AgentResult } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import { getTriageDecision, setTriageDecision, pruneTriageRecords } from './triage-store.js';

export interface OpenPR {
  number: number;
  title: string;
  url: string;
  branch: string;
  repo: string;       // owner/repo format
  project: string;    // managed project name
  createdAt: string;
  /** Topological merge layer — 0=foundation, higher=must wait for lower layers to merge first. */
  mergeLayer: number;
  /** PR numbers this PR depends on (their commits appear in this branch). */
  dependsOnPRs: number[];
  /** PR numbers that build on top of this one (must merge after this). */
  blocksPRs: number[];
  /**
   * Commit SHA of the unique top commit in this branch (the one that distinguishes
   * this PR from its dependencies). Used to confirm the agent reviews only the delta.
   */
  uniqueHeadSha: string;
  /**
   * Chain consolidation: the PR number at the tip of this PR's chain.
   * The tip already contains all commits from ancestor PRs. Fixes are applied
   * only to the tip; ancestor PRs are closed after the tip merges.
   * Undefined or equal to own number = this PR IS the tip (or standalone).
   */
  chainTipPR?: number;
  /**
   * All PR numbers in this PR's chain (including itself), ordered root→tip.
   * Only populated on the chain tip PR. Empty for standalone PRs.
   */
  chainMembers?: number[];
}

/** File ownership map — which PRs touch which files, and which files overlap. */
export interface FileOwnershipMap {
  /** file path → PR numbers that modify it */
  readonly fileOwners: ReadonlyMap<string, readonly number[]>;
  /** Only files modified by 2+ PRs */
  readonly overlappingFiles: ReadonlyMap<string, readonly number[]>;
  /** PR number → files it modifies */
  readonly prFiles: ReadonlyMap<number, readonly string[]>;
}

/**
 * Build a file ownership map by fetching changed files for each PR.
 *
 * WHY: Cross-PR file overlap is invisible to the commit-graph dependency
 * detector. When multiple PRs independently modify the same files (common
 * in implementation cycles), the reviewer needs to know so it doesn't
 * flag shared files as "unrelated to this PR."
 */
export function buildFileOwnershipMap(prs: readonly OpenPR[], cwd: string): FileOwnershipMap {
  const fileOwners = new Map<string, number[]>();
  const prFiles = new Map<number, string[]>();

  for (const pr of prs) {
    try {
      const raw = execSync(
        `gh pr view ${pr.number} --repo ${pr.repo} --json files --jq '.files[].path'`,
        { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      const files = raw ? raw.split('\n').filter(Boolean) : [];
      prFiles.set(pr.number, files);

      for (const file of files) {
        const owners = fileOwners.get(file) ?? [];
        owners.push(pr.number);
        fileOwners.set(file, owners);
      }
    } catch {
      prFiles.set(pr.number, []);
    }
  }

  // Filter to only overlapping files (touched by 2+ PRs)
  const overlappingFiles = new Map<string, readonly number[]>();
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      overlappingFiles.set(file, [...owners]);
    }
  }

  return {
    fileOwners: new Map([...fileOwners].map(([k, v]) => [k, [...v]])),
    overlappingFiles,
    prFiles: new Map([...prFiles].map(([k, v]) => [k, [...v]])),
  };
}

/**
 * Analyse the git commit graph to detect stacked-branch dependencies between PRs.
 *
 * Algorithm: for each PR pair (A, B), PR B depends on PR A if A's head SHA
 * appears inside B's commit log. This fires when B was branched from A's branch.
 *
 * Returns the same PRs annotated with mergeLayer, dependsOnPRs, blocksPRs, uniqueHeadSha.
 */
function buildMergeOrder(prs: OpenPR[], cwd: string): OpenPR[] {
  // Fetch commits per branch (newest first, SHAs only)
  // Detect default branch dynamically (main, master, etc.)
  let defaultBranch = 'main';
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    defaultBranch = ref.replace('refs/remotes/origin/', '');
  } catch { /* fallback to main */ }

  const commitsBySHA = new Map<number, string[]>(); // pr# → commit SHAs (not in default branch)
  const headBySHA    = new Map<number, string>();    // pr# → tip/head SHA

  for (const pr of prs) {
    try {
      const raw = execSync(
        `git log --pretty=format:%H ${defaultBranch}..origin/${pr.branch}`,
        { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      const commits = raw ? raw.split('\n') : [];
      commitsBySHA.set(pr.number, commits);
      if (commits.length > 0) headBySHA.set(pr.number, commits[0]);
    } catch {
      commitsBySHA.set(pr.number, []);
    }
  }

  // Build dependency graph: B depends on A if A's head SHA is in B's commit list
  const dependsOn = new Map<number, number[]>(); // pr# → pr#[] it depends on
  const blocks     = new Map<number, number[]>(); // pr# → pr#[] it blocks (reverse)

  for (const pr of prs) {
    dependsOn.set(pr.number, []);
    blocks.set(pr.number, []);
  }

  for (const prB of prs) {
    const bCommits = new Set(commitsBySHA.get(prB.number) ?? []);
    for (const prA of prs) {
      if (prA.number === prB.number) continue;
      const aHead = headBySHA.get(prA.number);
      if (aHead && bCommits.has(aHead)) {
        // B depends on A
        dependsOn.get(prB.number)!.push(prA.number);
        blocks.get(prA.number)!.push(prB.number);
      }
    }
  }

  // Assign merge layers via BFS from roots (PRs with no dependencies)
  const layers = new Map<number, number>();
  const queue: number[] = [];

  for (const pr of prs) {
    if ((dependsOn.get(pr.number) ?? []).length === 0) {
      layers.set(pr.number, 0);
      queue.push(pr.number);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layers.get(current) ?? 0;

    for (const child of blocks.get(current) ?? []) {
      // A child's layer = max(its current layer, parent layer + 1)
      const existing = layers.get(child) ?? 0;
      const newLayer = Math.max(existing, currentLayer + 1);
      layers.set(child, newLayer);
      if (!queue.includes(child)) queue.push(child);
    }
  }

  // Determine uniqueHeadSha: the first commit not present in any dependency PR
  function findUniqueHead(prNumber: number): string {
    const myCommits = commitsBySHA.get(prNumber) ?? [];
    const depCommits = new Set<string>();
    for (const depNum of dependsOn.get(prNumber) ?? []) {
      for (const sha of commitsBySHA.get(depNum) ?? []) {
        depCommits.add(sha);
      }
    }
    return myCommits.find((sha) => !depCommits.has(sha)) ?? (myCommits[0] ?? '');
  }

  // Build chain info: walk each linear chain from roots to tips.
  // A "chain" is a linear sequence where each PR has exactly one child.
  // If a PR has multiple children, each child starts a new chain.
  const chainTip = new Map<number, number>();   // pr# → tip of its chain
  const chainMembers = new Map<number, number[]>(); // tip pr# → ordered members

  // Find chain tips: PRs that block nothing (leaf nodes)
  const tips = prs.filter((pr) => (blocks.get(pr.number) ?? []).length === 0);

  for (const tip of tips) {
    // Walk backwards from tip to root following dependsOn
    const chain: number[] = [tip.number];
    let current = tip.number;
    while (true) {
      const deps = dependsOn.get(current) ?? [];
      if (deps.length !== 1) break; // Not a linear chain or reached root
      current = deps[0];
      chain.unshift(current);
    }

    // Only mark as chain if there are multiple members
    if (chain.length > 1) {
      chainMembers.set(tip.number, chain);
      for (const member of chain) {
        chainTip.set(member, tip.number);
      }
    }
  }

  // ── File-overlap fallback ────────────────────────────────────────
  // When commit-graph analysis finds no stacking (all layer 0), use
  // file overlap as a secondary signal for merge ordering. PRs that
  // share files with many others should merge first (foundation) so
  // subsequent merges resolve conflicts against an updated main.
  const allLayerZero = prs.every((pr) => (layers.get(pr.number) ?? 0) === 0);
  if (allLayerZero && prs.length > 1) {
    const fileMap = buildFileOwnershipMap(prs, cwd);

    if (fileMap.overlappingFiles.size > 0) {
      // Score each PR by how many overlapping files it touches
      const overlapScore = new Map<number, number>();
      for (const pr of prs) {
        let score = 0;
        for (const file of fileMap.prFiles.get(pr.number) ?? []) {
          const owners = fileMap.overlappingFiles.get(file);
          if (owners && owners.length > 1) score++;
        }
        overlapScore.set(pr.number, score);
      }

      // Sort by overlap score descending — highest overlap merges first
      const sorted = [...prs].sort((a, b) =>
        (overlapScore.get(b.number) ?? 0) - (overlapScore.get(a.number) ?? 0),
      );

      // Assign layers: highest-overlap PR = layer 0, next batch = layer 1, etc.
      // PRs with zero overlap stay at layer 0 (truly independent).
      let currentLayer = 0;
      let prevScore = overlapScore.get(sorted[0].number) ?? 0;

      for (const pr of sorted) {
        const score = overlapScore.get(pr.number) ?? 0;
        if (score === 0) {
          // No overlapping files — independent, stays layer 0
          layers.set(pr.number, 0);
        } else {
          if (score < prevScore) currentLayer++;
          layers.set(pr.number, currentLayer);
          prevScore = score;
        }
      }

      // Build dependency edges from layer ordering (higher layers depend on lower)
      for (const pr of prs) {
        const prLayer = layers.get(pr.number) ?? 0;
        if (prLayer === 0) continue;

        for (const other of prs) {
          if (other.number === pr.number) continue;
          const otherLayer = layers.get(other.number) ?? 0;
          if (otherLayer < prLayer) {
            // Check if they share files — only depend if there's actual overlap
            const prFileSet = new Set(fileMap.prFiles.get(pr.number) ?? []);
            const otherFiles = fileMap.prFiles.get(other.number) ?? [];
            const hasOverlap = otherFiles.some((f) => prFileSet.has(f));
            if (hasOverlap) {
              const deps = dependsOn.get(pr.number) ?? [];
              if (!deps.includes(other.number)) deps.push(other.number);
              dependsOn.set(pr.number, deps);

              const blk = blocks.get(other.number) ?? [];
              if (!blk.includes(pr.number)) blk.push(pr.number);
              blocks.set(other.number, blk);
            }
          }
        }
      }
    }
  }

  return prs.map((pr) => ({
    ...pr,
    mergeLayer:     layers.get(pr.number) ?? 0,
    dependsOnPRs:   dependsOn.get(pr.number) ?? [],
    blocksPRs:      blocks.get(pr.number) ?? [],
    uniqueHeadSha:  findUniqueHead(pr.number),
    chainTipPR:     chainTip.get(pr.number),
    chainMembers:   chainMembers.get(pr.number),
  }));
}

/**
 * Scan all managed projects for open PRs using gh CLI.
 * Annotates PRs with merge-layer ordering from the commit graph.
 * Writes a human-readable merge order plan to .forge/learnings/.
 *
 * Returns PRs sorted by mergeLayer then creation date.
 */
export function scanOpenPRs(
  projects: readonly string[],
  workspaceRoot: string,
  projectsDir = '.',
): OpenPR[] {
  const forgeRoot = resolve(workspaceRoot, '.forge');
  const learningsDir = join(forgeRoot, 'learnings');
  mkdirSync(learningsDir, { recursive: true });

  const rawPRs: OpenPR[] = [];

  for (const project of projects) {
    const projectPath = resolve(workspaceRoot, projectsDir, project);
    try {
      // Get git remote to derive owner/repo
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const repo = remoteUrl
        .replace('https://github.com/', '')
        .replace('git@github.com:', '')
        .replace('.git', '');

      // Fetch open PRs via gh CLI
      const raw = execSync(
        `gh pr list --state open --limit 50 --json number,title,url,headRefName,createdAt --repo ${repo}`,
        { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const prs = JSON.parse(raw) as Array<{
        number: number;
        title: string;
        url: string;
        headRefName: string;
        createdAt: string;
      }>;

      // Build stub PRs with default layer=0 (will be overwritten by buildMergeOrder)
      const projectPRs: OpenPR[] = prs.map((pr) => ({
        number:        pr.number,
        title:         pr.title,
        url:           pr.url,
        branch:        pr.headRefName,
        repo,
        project,
        createdAt:     pr.createdAt,
        mergeLayer:    0,
        dependsOnPRs:  [],
        blocksPRs:     [],
        uniqueHeadSha: '',
      }));

      // Fetch git history for this project and compute dependency order
      try {
        execSync('git fetch --all --quiet', {
          cwd: projectPath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* fetch failure is non-fatal */ }

      const ordered = buildMergeOrder(projectPRs, projectPath);
      rawPRs.push(...ordered);

      // Write a merge-order plan for this project
      writeMergeOrderPlan(ordered, project, learningsDir);
    } catch {
      // Project may not have a GitHub remote or gh may not be authed — skip silently
    }
  }

  // Sort by merge layer (ascending) then creation date (oldest first)
  return rawPRs.sort((a, b) =>
    a.mergeLayer !== b.mergeLayer
      ? a.mergeLayer - b.mergeLayer
      : a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * Write a human-readable merge plan to .forge/learnings/ so both humans
 * and the reflection agent can understand the intended PR sequence.
 */
function writeMergeOrderPlan(prs: OpenPR[], project: string, learningsDir: string): void {
  if (prs.length === 0) return;

  const date = new Date().toISOString().slice(0, 10);
  const path = join(learningsDir, `pr-merge-order-${project}-${date}.md`);

  const maxLayer = Math.max(...prs.map((p) => p.mergeLayer));
  const layers: string[] = [];

  for (let layer = 0; layer <= maxLayer; layer++) {
    const layerPRs = prs.filter((p) => p.mergeLayer === layer);
    const label = layer === 0 ? ' [FOUNDATION — merge first]' : '';
    layers.push(`### Layer ${layer}${label}`);
    for (const pr of layerPRs) {
      const deps = pr.dependsOnPRs.length > 0
        ? ` (waits for: ${pr.dependsOnPRs.map((n) => `#${n}`).join(', ')})`
        : '';
      const blocks = pr.blocksPRs.length > 0
        ? ` (unblocks: ${pr.blocksPRs.map((n) => `#${n}`).join(', ')})`
        : '';
      layers.push(`- **PR #${pr.number}** ${pr.title}${deps}${blocks}`);
      layers.push(`  Branch: \`${pr.branch}\``);
    }
  }

  const content = `# PR Merge Order — ${project}
Generated: ${date}

These PRs are **stacked branches** (each contains its parent's commits).
Merge in layer order to avoid conflicts. After merging a layer, GitHub
will automatically show the correct delta for dependent PRs.

${layers.join('\n')}

## Merge Command Sequence
${prs.sort((a, b) => a.mergeLayer - b.mergeLayer)
     .map((pr) => `# Layer ${pr.mergeLayer}: PR #${pr.number}\ngh pr merge ${pr.number} --repo ${pr.repo} --squash --delete-branch`)
     .join('\n')}
`;

  writeFileSync(path, content, 'utf-8');
}

/**
 * Run the pr-reviewer agent for a single PR.
 *
 * The agent receives a fully-formed prompt with the PR context and merge order.
 * For stacked branches, it's told to focus ONLY on the unique delta of this PR,
 * not commits that are part of ancestor/dependency PRs.
 */
export async function runPRReviewStage(
  agent: AgentDefinition,
  pr: OpenPR,
  workspaceRoot: string,
  projectsDir = '.',
  fileOwnership?: FileOwnershipMap,
): Promise<AgentResult> {
  const projectPath = resolve(workspaceRoot, projectsDir, pr.project);
  const forgeRoot = resolve(workspaceRoot, '.forge');
  const learningsDir = join(forgeRoot, 'learnings');
  const date = new Date().toISOString().slice(0, 10);
  const learningsPath = join(learningsDir, `${pr.project}-pr-${pr.number}-${date}.md`);

  // Ensure learnings directory exists
  mkdirSync(learningsDir, { recursive: true });

  // Pre-fetch the CLAUDE.md for this project so the agent has project context
  let claudeMd = '';
  try {
    claudeMd = execSync(`cat CLAUDE.md 2>/dev/null || echo ""`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // No CLAUDE.md — agent will review against general principles
  }

  // Build merge-order context block
  const isChainTip = (pr.chainMembers ?? []).length > 1;
  const isStacked = pr.dependsOnPRs.length > 0 || pr.blocksPRs.length > 0;

  // Chain tip PRs get a consolidated review context — they contain ALL the work
  const mergeContextBlock = isChainTip ? `
## Consolidated Chain Review (IMPORTANT)

This PR is the **tip of a ${pr.chainMembers!.length}-PR chain**. Its branch contains
ALL commits from the ancestor PRs listed below. This is a **consolidated review** —
you are reviewing the holistic body of work, not just this PR's unique delta.

- **Chain members (root→tip):** ${pr.chainMembers!.map((n) => `#${n}`).join(' → ')}
- **This PR (#${pr.number}) is the chain tip** — all fixes will be applied here
- **After approval:** this PR will be merged and all ancestor PRs will be closed

Review the FULL diff against main. All changes across the chain are your scope.
Focus on:
1. Does the overall implementation hang together? Are there cross-cutting issues
   that individual PR reviews might miss?
2. Are there conflicts with main that need resolution?
3. Does the combined changeset meet the project's quality standards?

\`gh pr diff ${pr.number} --repo ${pr.repo}\`
` : isStacked ? `
## Stacked Branch Context (IMPORTANT)

This PR is part of a **stacked branch chain**. Its branch contains commits from
ancestor PRs — do NOT review those shared commits, they will be reviewed in their
own PR. Focus ONLY on the unique delta introduced by this PR.

- **Merge layer:** ${pr.mergeLayer} (layer 0 = merge first, higher = merge later)
- **Depends on PRs:** ${pr.dependsOnPRs.length > 0 ? pr.dependsOnPRs.map((n) => `#${n}`).join(', ') : 'none (this is a root PR)'}
- **Blocks PRs:** ${pr.blocksPRs.length > 0 ? pr.blocksPRs.map((n) => `#${n}`).join(', ') : 'none'}
- **Unique head commit:** \`${pr.uniqueHeadSha}\`

To see ONLY the unique changes for this PR (not ancestor commits), run:
\`git diff origin/${pr.dependsOnPRs.length > 0 ? `<parent-branch>` : 'main'}...origin/${pr.branch}\`

NOTE: \`gh pr diff\` shows accumulated diff against main for stacked PRs.
To see only this PR's unique changes, diff against the parent branch, not main.

**Merge recommendation:** ${pr.dependsOnPRs.length > 0
    ? `Wait for PR(s) ${pr.dependsOnPRs.map((n) => `#${n}`).join(', ')} to merge first.`
    : 'This is a foundation PR — safe to merge immediately once approved.'
  }
` : '';

  // Build cross-PR file overlap context when available
  let fileOverlapBlock = '';
  if (fileOwnership && fileOwnership.overlappingFiles.size > 0) {
    const prFileSet = new Set(fileOwnership.prFiles.get(pr.number) ?? []);
    const relevantOverlaps: string[] = [];

    for (const [file, owners] of fileOwnership.overlappingFiles) {
      if (prFileSet.has(file)) {
        const otherPRs = owners.filter((n) => n !== pr.number);
        if (otherPRs.length > 0) {
          relevantOverlaps.push(`- \`${file}\` → also in PR ${otherPRs.map((n) => `#${n}`).join(', ')}`);
        }
      }
    }

    if (relevantOverlaps.length > 0) {
      fileOverlapBlock = `
## Cross-PR File Awareness (IMPORTANT)

These files in this PR are also modified by other PRs in this review batch.
They represent shared work across the implementation cycle — do NOT flag them
as "unrelated to this PR" or "belongs in a separate PR." Instead, review
whether THIS PR's changes to these files are correct and consistent.

${relevantOverlaps.join('\n')}

`;
    }
  }

  const prompt = `You are reviewing PR #${pr.number} in ${pr.repo}.

## PR Details
- Title: ${pr.title}
- URL: ${pr.url}
- Branch: ${pr.branch}
- Repo: ${pr.repo}
- Project: ${pr.project}
${mergeContextBlock}${fileOverlapBlock}## Your Task

Review this PR using the pr-reviewer process. Specifically:

1. Fetch the full PR data:
   - \`gh pr view ${pr.number} --repo ${pr.repo}\`
   - \`gh pr diff ${pr.number} --repo ${pr.repo}\`
   - \`gh pr checks ${pr.number} --repo ${pr.repo}\` (CI status)
   - \`gh api repos/${pr.repo}/pulls/${pr.number}/comments\` (inline review comments)
   - \`gh api repos/${pr.repo}/issues/${pr.number}/comments\` (conversation comments)

2. Identify whether any real human (non-bot) has commented. Bots include:
   github-actions[bot], dependabot[bot], any name ending in [bot].

3. If human comments exist: **Mode 1 — Human-Directed Review**
   - Write learning entry to: ${learningsPath}
   - Post a review responding to the human's direction

4. If no human comments: **Mode 2 — Principles Review**
   - Review against the project's CLAUDE.md and core engineering principles
   - Post the review with your assessment

## Project Context (CLAUDE.md)

${claudeMd || '(No CLAUDE.md found — review against general TypeScript/engineering principles)'}

## Output

When done, output a summary line:
- On success: \`REVIEW POSTED: approved|changes-requested|commented on PR #${pr.number}\`
- If CI still running: \`REVIEW DEFERRED: CI pending on PR #${pr.number}\`
- On error: \`FAILED: <reason>\`
`;

  return runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 20,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Interactive PR Triage
// ═══════════════════════════════════════════════════════════════════════

/** Result of triaging a single PR. */
export interface TriageDecision {
  readonly pr: OpenPR;
  /** 'accept' = queue review as-is, 'skip' = don't review, 'feedback' = include user notes */
  readonly action: 'accept' | 'skip' | 'feedback';
  /** User feedback to include in the review prompt (only when action='feedback'). */
  readonly feedback?: string;
}

/**
 * Fetch a full summary of a PR's intent and changes for display.
 * Uses `gh` to get the PR body, changed files, and comment status.
 */
function fetchPRSummary(pr: OpenPR, projectPath: string): {
  body: string;
  files: string[];
  diffstat: string;
  hasHumanComments: boolean;
  mergeable: string;
} {
  let body = '';
  let files: string[] = [];
  let diffstat = '';
  let hasHumanComments = false;
  let mergeable = '';

  try {
    const prView = execSync(
      `gh pr view ${pr.number} --repo ${pr.repo} --json body,comments,files,additions,deletions,mergeable`,
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(prView) as {
      body?: string;
      comments?: Array<{ author?: { login?: string } }>;
      files?: Array<{ path: string; additions: number; deletions: number }>;
      additions?: number;
      deletions?: number;
      mergeable?: string;
    };
    body = (parsed.body ?? '').trim();
    mergeable = parsed.mergeable ?? '';

    // Build file list with +/- counts
    if (parsed.files) {
      files = parsed.files.map((f) => `${f.path} (+${f.additions} -${f.deletions})`);
    }

    // Build diffstat from totals
    const adds = parsed.additions ?? 0;
    const dels = parsed.deletions ?? 0;
    const fileCount = parsed.files?.length ?? 0;
    diffstat = `${fileCount} file(s), +${adds} -${dels}`;

    // Check for non-bot comments
    const comments = parsed.comments ?? [];
    hasHumanComments = comments.some((c) => {
      const login = c.author?.login ?? '';
      return login.length > 0 && !login.endsWith('[bot]') && !login.includes('github-actions');
    });
  } catch { /* gh not available or PR not found */ }

  return { body, files, diffstat, hasHumanComments, mergeable };
}

/** Function signature for asking the user a question. */
export type AskFn = (prompt: string) => Promise<string>;

/**
 * Create a standalone askFn backed by its own readline.
 * Used when running from the CLI (no session) — the caller must close
 * the returned cleanup function when done.
 */
function createStandaloneAsk(): { ask: AskFn; cleanup: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });
  return {
    ask: (prompt: string) => new Promise((resolve) => rl.question(prompt, resolve)),
    cleanup: () => rl.close(),
  };
}

/**
 * Interactively triage PRs with the user.
 *
 * For each PR, shows: title, full body, file list, human comment status.
 * User can: [a]ccept (queue review), [s]kip, or type feedback.
 *
 * Already-triaged PRs (same HEAD SHA) are auto-included with their previous
 * decision — the user isn't re-asked unless the PR has new commits.
 *
 * @param askFn  Question function — pass the session's question() when running
 *               inside the REPL. If omitted, creates a standalone readline
 *               (safe for CLI-only use where there's no session).
 */
export async function interactiveTriagePRs(
  prs: readonly OpenPR[],
  workspaceRoot: string,
  projectsDir = '.',
  askFn?: AskFn,
): Promise<readonly TriageDecision[]> {
  if (prs.length === 0) return [];

  const forgeRoot = resolve(workspaceRoot, '.forge');

  // Prune stale triage records for PRs no longer in the open set
  const openKeys = new Set(prs.map((pr) => `${pr.repo}#${pr.number}`));
  pruneTriageRecords(forgeRoot, openKeys);

  // Separate PRs into already-triaged (auto-include) vs needs-triage
  const needsTriage: OpenPR[] = [];
  const autoIncluded: TriageDecision[] = [];

  for (const pr of prs) {
    // Get current HEAD SHA to check if PR has changed since last triage
    let currentSha = pr.uniqueHeadSha;
    if (!currentSha) {
      try {
        currentSha = execSync(
          `gh api repos/${pr.repo}/pulls/${pr.number} --jq .head.sha`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
      } catch { currentSha = ''; }
    }

    const existing = getTriageDecision(forgeRoot, pr.repo, pr.number, currentSha);
    if (existing) {
      // Already triaged with same SHA — auto-include with previous decision
      autoIncluded.push({
        pr,
        action: existing.action,
        ...(existing.feedback ? { feedback: existing.feedback } : {}),
      });
    } else {
      needsTriage.push(pr);
    }
  }

  // Show auto-included PRs
  if (autoIncluded.length > 0) {
    console.log(chalk.dim(`\n  ${autoIncluded.length} PR(s) already triaged (no new commits):`));
    for (const d of autoIncluded) {
      const actionLabel = d.action === 'skip' ? chalk.dim('skip') : chalk.green(d.action);
      console.log(chalk.dim(`    PR #${d.pr.number} [${d.pr.project}] — ${actionLabel}`));
    }
    console.log();
  }

  if (needsTriage.length === 0) {
    console.log(chalk.dim('  All PRs already triaged. Re-using previous decisions.\n'));
    return autoIncluded;
  }

  // Use provided askFn (session) or create standalone readline (CLI)
  const standalone = askFn ? null : createStandaloneAsk();
  const ask = askFn ?? standalone!.ask;

  const newDecisions: TriageDecision[] = [];

  console.log(chalk.bold(`\n  PR Review Triage — ${needsTriage.length} PR(s) need triage\n`));
  console.log(chalk.dim('  For each PR: [a]ccept, [s]kip, or type feedback to include in the review.\n'));

  try {
    for (let i = 0; i < needsTriage.length; i++) {
      const pr = needsTriage[i];
      const projectPath = resolve(workspaceRoot, projectsDir, pr.project);
      const { body, files, diffstat, hasHumanComments, mergeable } = fetchPRSummary(pr, projectPath);

      // Header
      const layerLabel = pr.mergeLayer > 0 ? chalk.yellow(` [layer ${pr.mergeLayer}]`) : chalk.green(' [foundation]');
      const chainLabel = pr.chainTipPR && pr.chainTipPR !== pr.number
        ? chalk.cyan(` → chain tip #${pr.chainTipPR}`)
        : pr.chainMembers && pr.chainMembers.length > 1
          ? chalk.bold.cyan(` [chain tip: ${pr.chainMembers.length} PRs]`)
          : '';
      console.log(chalk.bold(`  ── PR #${pr.number}${layerLabel}${chainLabel} ── ${pr.project} ──`));
      console.log(chalk.cyan(`  ${pr.title}`));
      console.log(chalk.dim(`  ${pr.url}`));

      // Merge status
      if (mergeable === 'CONFLICTING') {
        console.log(chalk.red('  ⚠ Has merge conflicts with main — fix will resolve'));
      } else if (mergeable === 'MERGEABLE') {
        console.log(chalk.green('  ✓ Mergeable'));
      }

      // Chain info
      if (pr.chainMembers && pr.chainMembers.length > 1) {
        console.log(chalk.cyan(`  Chain: ${pr.chainMembers.map((n) => `#${n}`).join(' → ')} (this is the tip — merging this lands all)`));
      } else if (pr.chainTipPR && pr.chainTipPR !== pr.number) {
        console.log(chalk.dim(`  Part of chain → fixes will be applied to tip PR #${pr.chainTipPR}`));
      }

      // Full PR body — this is the user's one chance to understand the PR
      if (body) {
        console.log(chalk.dim('  ─── Description ───'));
        // Indent each line for visual alignment
        for (const line of body.split('\n')) {
          console.log(`  ${line}`);
        }
      }

      // Changed files list
      if (files.length > 0) {
        console.log(chalk.dim('  ─── Files Changed ───'));
        for (const file of files) {
          console.log(chalk.dim(`    ${file}`));
        }
        console.log(chalk.dim(`  ${diffstat}`));
      }

      // Human comment status
      if (hasHumanComments) {
        console.log(chalk.yellow('  Has human comments — will extract direction'));
      } else {
        console.log(chalk.dim('  No human comments yet — principles-only review'));
      }

      // Dependencies (only show if not already covered by chain info)
      if (pr.dependsOnPRs.length > 0 && !pr.chainTipPR) {
        console.log(chalk.yellow(`  Depends on: ${pr.dependsOnPRs.map((n) => `#${n}`).join(', ')}`));
      }
      if (pr.blocksPRs.length > 0 && !pr.chainMembers) {
        console.log(chalk.dim(`  Blocks: ${pr.blocksPRs.map((n) => `#${n}`).join(', ')}`));
      }

      console.log();

      const answer = await ask(chalk.blue(`  [${i + 1}/${needsTriage.length}] `) + 'Action ([a]ccept / [s]kip / type feedback): ');
      const trimmed = answer.trim().toLowerCase();

      // Get current HEAD SHA for persistence
      let headSha = pr.uniqueHeadSha;
      if (!headSha) {
        try {
          headSha = execSync(
            `gh api repos/${pr.repo}/pulls/${pr.number} --jq .head.sha`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
        } catch { headSha = ''; }
      }

      if (trimmed === 's' || trimmed === 'skip') {
        newDecisions.push({ pr, action: 'skip' });
        setTriageDecision(forgeRoot, pr.repo, pr.number, 'skip', headSha);
        console.log(chalk.dim('  → Skipped\n'));
      } else if (trimmed === 'a' || trimmed === 'accept' || trimmed === '') {
        newDecisions.push({ pr, action: 'accept' });
        setTriageDecision(forgeRoot, pr.repo, pr.number, 'accept', headSha);
        console.log(chalk.green('  → Accepted\n'));
      } else {
        const feedback = answer.trim();
        newDecisions.push({ pr, action: 'feedback', feedback });
        setTriageDecision(forgeRoot, pr.repo, pr.number, 'feedback', headSha, feedback);
        console.log(chalk.green('  → Accepted with feedback\n'));
      }
    }
  } finally {
    standalone?.cleanup();
  }

  const allDecisions = [...autoIncluded, ...newDecisions];

  // Summary
  const accepted = allDecisions.filter((d) => d.action !== 'skip').length;
  const skipped = allDecisions.filter((d) => d.action === 'skip').length;
  console.log(chalk.bold(`  Triage complete: ${accepted} to review, ${skipped} skipped\n`));

  return allDecisions;
}
