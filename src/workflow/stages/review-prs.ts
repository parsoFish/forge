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
import type { AgentDefinition } from '../../agents/types.js';
import type { AgentResult } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';

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
  const commitsBySHA = new Map<number, string[]>(); // pr# → commit SHAs (not in master)
  const headBySHA    = new Map<number, string>();    // pr# → tip/head SHA

  for (const pr of prs) {
    try {
      const raw = execSync(
        `git log --pretty=format:%H master..origin/${pr.branch}`,
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

  return prs.map((pr) => ({
    ...pr,
    mergeLayer:     layers.get(pr.number) ?? 0,
    dependsOnPRs:   dependsOn.get(pr.number) ?? [],
    blocksPRs:      blocks.get(pr.number) ?? [],
    uniqueHeadSha:  findUniqueHead(pr.number),
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
): OpenPR[] {
  const forgeRoot = resolve(workspaceRoot, '.forge');
  const learningsDir = join(forgeRoot, 'learnings');
  mkdirSync(learningsDir, { recursive: true });

  const rawPRs: OpenPR[] = [];

  for (const project of projects) {
    const projectPath = resolve(workspaceRoot, project);
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
): Promise<AgentResult> {
  const projectPath = resolve(workspaceRoot, pr.project);
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
  const isStacked = pr.dependsOnPRs.length > 0 || pr.blocksPRs.length > 0;
  const mergeContextBlock = isStacked ? `
## Stacked Branch Context (IMPORTANT)

This PR is part of a **stacked branch chain**. Its branch contains commits from
ancestor PRs — do NOT review those shared commits, they will be reviewed in their
own PR. Focus ONLY on the unique delta introduced by this PR.

- **Merge layer:** ${pr.mergeLayer} (layer 0 = merge first, higher = merge later)
- **Depends on PRs:** ${pr.dependsOnPRs.length > 0 ? pr.dependsOnPRs.map((n) => `#${n}`).join(', ') : 'none (this is a root PR)'}
- **Blocks PRs:** ${pr.blocksPRs.length > 0 ? pr.blocksPRs.map((n) => `#${n}`).join(', ') : 'none'}
- **Unique head commit:** \`${pr.uniqueHeadSha}\`

To see ONLY the unique changes for this PR (not ancestor commits), run:
\`gh pr diff ${pr.number} --repo ${pr.repo}\`

GitHub's diff view already does this automatically — it shows only the delta
above the merge-base. Trust the diff output, not the raw git log.

**Merge recommendation:** ${pr.dependsOnPRs.length > 0
    ? `Wait for PR(s) ${pr.dependsOnPRs.map((n) => `#${n}`).join(', ')} to merge first.`
    : 'This is a foundation PR — safe to merge immediately once approved.'
  }
` : '';

  const prompt = `You are reviewing PR #${pr.number} in ${pr.repo}.

## PR Details
- Title: ${pr.title}
- URL: ${pr.url}
- Branch: ${pr.branch}
- Repo: ${pr.repo}
- Project: ${pr.project}
${mergeContextBlock}
## Your Task

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
