/**
 * PR summary generation — collates raw data, then feeds it to an agent
 * for a concise handoff narrative.
 *
 * WHY agent-generated:
 * The raw data (work items, review findings, file stats) is machine-readable
 * but not human-friendly. A single agent call synthesizes a 1-3 paragraph
 * narrative that explains what the PR does, why, and what the review found.
 * The data collection itself needs no agent — it's deterministic lookups.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadReviewFindings, type ReviewReport, type ReviewFinding } from './review-findings.js';
import type { WorkItem } from '../types.js';

/** Raw data collected from multiple sources for a single PR. */
export interface PRRawData {
  readonly prNumber: number;
  readonly url: string;
  readonly title: string;
  readonly branch: string;
  /** Work items that contributed to this PR (matched by branch). */
  readonly workItems: readonly WorkItem[];
  /** File change details from GitHub. */
  readonly files: readonly FileChange[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
  /** Test file stats. */
  readonly testFileCount: number;
  readonly testAdditions: number;
  /** Merge status from GitHub. */
  readonly mergeable: string;
  /** Automated review report (null if review hasn't completed). */
  readonly reviewReport: ReviewReport | null;
  /** Whether file stats represent only this PR's unique delta (vs accumulated from main). */
  readonly isUniqueDelta: boolean;
  /** Parent branches used for unique delta computation (empty when not applicable). */
  readonly parentBranches: readonly string[];
}

export interface FileChange {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Rich PR presentation for the interactive review session. */
export interface PRPresentation {
  readonly prNumber: number;
  readonly url: string;
  readonly title: string;
  /** Agent-generated narrative summary (1-3 paragraphs). */
  readonly handoffSummary: string;
  /** Summary of automated review findings. */
  readonly findingsSummary: string;
  /** Number of blockers found. */
  readonly blockerCount: number;
  /** Number of concerns found. */
  readonly concernCount: number;
  /** Whether the PR is mergeable. */
  readonly mergeable: string;
  /** The automated review verdict. */
  readonly verdict: ReviewReport['verdict'] | 'pending';
  /** Concern-level findings needing human judgement. */
  readonly concerns: readonly ReviewFinding[];
}

/**
 * Compute unique file changes for a stacked PR by diffing against its
 * parent branch instead of main.
 *
 * WHY: When PR B is stacked on PR A (both target main), `gh pr view`
 * returns B's accumulated diff since main, including all of A's changes.
 * This computes only B's unique contribution via:
 *   git diff --numstat origin/<parent>...origin/<this>
 */
function computeUniqueDelta(
  branch: string,
  parentBranches: readonly string[],
  cwd: string,
): { files: FileChange[]; totalAdditions: number; totalDeletions: number;
     testFileCount: number; testAdditions: number } | null {
  // Use the first parent branch (closest dependency)
  const parent = parentBranches[0];
  if (!parent) return null;

  try {
    const raw = execSync(
      `git diff --numstat origin/${parent}...origin/${branch}`,
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!raw) return { files: [], totalAdditions: 0, totalDeletions: 0, testFileCount: 0, testAdditions: 0 };

    const files: FileChange[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;
    let testFileCount = 0;
    let testAdditions = 0;

    for (const line of raw.split('\n')) {
      // numstat format: additions\tdeletions\tpath (binary files show - - path)
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const adds = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
      const dels = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
      const path = parts.slice(2).join('\t'); // Handle paths with tabs (rare)

      files.push({ path, additions: adds, deletions: dels });
      totalAdditions += adds;
      totalDeletions += dels;

      if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(path) || path.includes('/tests/') || path.includes('/__tests__/')) {
        testFileCount++;
        testAdditions += adds;
      }
    }

    return { files, totalAdditions, totalDeletions, testFileCount, testAdditions };
  } catch {
    // Parent branch may have been deleted after merge — fall back to null
    return null;
  }
}

/**
 * Collect raw data for a PR from all available sources.
 *
 * Deterministic — no agent calls. Correlates:
 * - Work items (intent) by branch name
 * - GitHub PR metadata (files, stats, mergeable)
 * - Automated review findings (from .forge/review-findings/)
 *
 * When parentBranches is provided (stacked PRs), computes file stats
 * from the unique delta against the parent branch instead of the
 * accumulated diff against main.
 */
export function collectPRRawData(
  prNumber: number,
  url: string,
  title: string,
  branch: string,
  repo: string,
  project: string,
  workspaceRoot: string,
  projectsDir: string,
  forgeRoot: string,
  workItems: readonly WorkItem[],
  parentBranches?: readonly string[],
): PRRawData {
  // 1. Find all work items that share this branch
  const matchingItems = workItems.filter((wi) => wi.branch === branch);

  // 2. Fetch file changes
  const projectPath = resolve(workspaceRoot, projectsDir, project);
  let files: FileChange[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  let testFileCount = 0;
  let testAdditions = 0;
  let mergeable = '';
  let isUniqueDelta = false;

  // Try unique delta computation for stacked PRs
  const resolvedParents = parentBranches ?? [];
  if (resolvedParents.length > 0) {
    const delta = computeUniqueDelta(branch, resolvedParents, projectPath);
    if (delta) {
      files = delta.files;
      totalAdditions = delta.totalAdditions;
      totalDeletions = delta.totalDeletions;
      testFileCount = delta.testFileCount;
      testAdditions = delta.testAdditions;
      isUniqueDelta = true;
    }
  }

  // Fetch mergeable status (always needed), and file stats if not using unique delta
  try {
    const jsonFields = isUniqueDelta ? 'mergeable' : 'files,additions,deletions,mergeable';
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json ${jsonFields}`,
      { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(raw) as {
      files?: Array<{ path: string; additions: number; deletions: number }>;
      additions?: number;
      deletions?: number;
      mergeable?: string;
    };

    mergeable = parsed.mergeable ?? '';

    // Only use gh file stats if we don't have unique delta stats
    if (!isUniqueDelta && parsed.files) {
      totalAdditions = parsed.additions ?? 0;
      totalDeletions = parsed.deletions ?? 0;
      files = parsed.files.map((f) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
      }));

      for (const f of parsed.files) {
        if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/.test(f.path) || f.path.includes('/tests/') || f.path.includes('/__tests__/')) {
          testFileCount++;
          testAdditions += f.additions;
        }
      }
    }
  } catch { /* gh not available or PR not found */ }

  // 3. Load review findings
  const reviewReport = loadReviewFindings(forgeRoot, project, prNumber);

  return {
    prNumber,
    url,
    title,
    branch,
    workItems: matchingItems,
    files,
    totalAdditions,
    totalDeletions,
    testFileCount,
    testAdditions,
    mergeable,
    reviewReport,
    isUniqueDelta,
    parentBranches: resolvedParents,
  };
}

/**
 * Build the prompt for the agent that generates the handoff narrative.
 *
 * Includes all raw data so the agent can synthesize a concise summary.
 */
export function buildHandoffPrompt(rawData: PRRawData): string {
  const workItemSection = rawData.workItems.length > 0
    ? rawData.workItems.map((wi) => {
      const deps = wi.dependsOn.length > 0 ? `\n  Dependencies: ${wi.dependsOn.join(', ')}` : '';
      const stages = Object.entries(wi.stageOutputs)
        .map(([stage, output]) => `  ${stage}: ${output.summary.slice(0, 200)}`)
        .join('\n');
      return `- **${wi.title}** (${wi.id})\n  ${wi.description}${deps}\n${stages}`;
    }).join('\n\n')
    : '(No matching work items found for this branch)';

  const fileSection = rawData.files.length > 0
    ? [...rawData.files]
      .sort((a: FileChange, b: FileChange) => (b.additions + b.deletions) - (a.additions + a.deletions))
      .slice(0, 15)
      .map((f: FileChange) => `  ${f.path} (+${f.additions} -${f.deletions})`)
      .join('\n')
    : '(Could not fetch file changes)';

  const findingsSection = rawData.reviewReport
    ? rawData.reviewReport.findings.length > 0
      ? rawData.reviewReport.findings.map((f) => {
        const file = f.file ? ` (${f.file})` : '';
        return `  [${f.severity}]${file} ${f.description}`;
      }).join('\n')
      : 'Clean — no issues found'
    : 'Review not yet completed';

  const verdictLine = rawData.reviewReport
    ? `Verdict: ${rawData.reviewReport.verdict}`
    : 'Verdict: pending';

  return `Generate a concise handoff summary for a pull request. The summary is for the project owner reviewing completed work.

## PR #${rawData.prNumber}: ${rawData.title}
URL: ${rawData.url}
Branch: ${rawData.branch}

## Work Items (Intent)

${workItemSection}

## Implementation (Files Changed${rawData.isUniqueDelta ? ` — unique delta, excluding parent branch${rawData.parentBranches.length > 1 ? 'es' : ''}` : ''})

${rawData.files.length} file(s), +${rawData.totalAdditions} -${rawData.totalDeletions}
Test files: ${rawData.testFileCount} file(s), +${rawData.testAdditions} lines

${fileSection}

## Automated Review Findings

${verdictLine}
${findingsSection}

## Instructions

Write a handoff summary for the project owner. Requirements:
- 1-3 paragraphs depending on the size/complexity of the change
- First paragraph: What this PR does and why (from the work items)
- Second paragraph (if needed): How it's implemented — key architectural decisions, notable patterns
- Third paragraph (if needed): Review status — what the automated review found, any concerns the owner should weigh in on
- Be specific and concrete — mention actual file names, function names, patterns used
- Do NOT include headers, bullet points, or formatting — just flowing prose paragraphs
- Do NOT include the PR number, URL, or branch name — the caller already displays those
- Write in present tense ("This PR adds..." not "This PR added...")

Output ONLY the summary paragraphs, nothing else.`;
}

/**
 * Build a PRPresentation from raw data and an agent-generated summary.
 *
 * Called after the agent generates the handoff narrative.
 */
export function buildPresentation(
  rawData: PRRawData,
  handoffSummary: string,
): PRPresentation {
  const report = rawData.reviewReport;
  let findingsSummary = '';
  let blockerCount = 0;
  let concernCount = 0;
  let verdict: PRPresentation['verdict'] = 'pending';
  let concerns: ReviewFinding[] = [];

  if (report) {
    blockerCount = report.findings.filter((f) => f.severity === 'blocker').length;
    concernCount = report.findings.filter((f) => f.severity === 'concern').length;
    const nitCount = report.findings.filter((f) => f.severity === 'nit').length;
    verdict = report.verdict;
    concerns = report.findings.filter((f) => f.severity === 'concern');

    const parts: string[] = [];
    if (blockerCount > 0) parts.push(`${blockerCount} blocker(s)`);
    if (concernCount > 0) parts.push(`${concernCount} concern(s)`);
    if (nitCount > 0) parts.push(`${nitCount} nit(s)`);

    findingsSummary = parts.length > 0
      ? `${report.verdict}: ${parts.join(', ')}`
      : `${report.verdict}: clean`;
  } else {
    findingsSummary = 'Review pending';
  }

  return {
    prNumber: rawData.prNumber,
    url: rawData.url,
    title: rawData.title,
    handoffSummary,
    findingsSummary,
    blockerCount,
    concernCount,
    mergeable: rawData.mergeable,
    verdict,
    concerns,
  };
}
