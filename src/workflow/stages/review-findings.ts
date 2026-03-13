/**
 * Review findings persistence — structured storage for automated review results.
 *
 * WHY structured findings:
 * The review phase runs automated reviews FIRST, then presents results to the
 * user one-by-one. Findings need to survive between the worker (which runs
 * the review agent) and the interactive session (which displays results).
 *
 * Storage: `.forge/review-findings/<project>/pr-<N>.json`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

/** A single finding from a code review. */
export interface ReviewFinding {
  readonly severity: 'blocker' | 'concern' | 'nit';
  readonly description: string;
  readonly file?: string;
  readonly suggestion?: string;
}

/** A complete review report for a PR. */
export interface ReviewReport {
  readonly prNumber: number;
  readonly project: string;
  readonly round: number;
  readonly findings: readonly ReviewFinding[];
  readonly verdict: 'approved' | 'changes-requested' | 'commented' | 'deferred';
  readonly reviewedAt: string;
  readonly sha: string;
  /** Raw summary from the reviewer agent (first 500 chars). */
  readonly summary: string;
}

const FINDINGS_DIR = 'review-findings';

/** Save a review report to disk. */
export function saveReviewFindings(forgeRoot: string, report: ReviewReport): void {
  const dir = join(forgeRoot, FINDINGS_DIR, report.project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `pr-${report.prNumber}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
}

/** Load a review report for a specific PR. Returns null if not found. */
export function loadReviewFindings(
  forgeRoot: string,
  project: string,
  prNumber: number,
): ReviewReport | null {
  const path = join(forgeRoot, FINDINGS_DIR, project, `pr-${prNumber}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ReviewReport;
  } catch {
    return null;
  }
}

/** Load all review reports for a project. */
export function loadAllFindings(forgeRoot: string, project: string): ReviewReport[] {
  const dir = join(forgeRoot, FINDINGS_DIR, project);
  if (!existsSync(dir)) return [];

  const reports: ReviewReport[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      reports.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ReviewReport);
    } catch { /* skip corrupted */ }
  }
  return reports.sort((a, b) => a.prNumber - b.prNumber);
}

/**
 * Parse review findings from agent stdout output.
 *
 * NOTE: The reviewer agent typically posts findings via `gh pr comment`,
 * so its stdout only contains the signal line. Use `parseReviewFromGitHub()`
 * to get actual findings. This function is kept as a fallback for cases
 * where the agent output does contain inline findings.
 */
export function parseReviewOutput(output: string, prNumber: number, project: string, sha: string): ReviewReport {
  const findings = parseFindingsFromText(output);

  // Parse verdict from output signal
  let verdict: ReviewReport['verdict'] = 'commented';
  if (/REVIEW POSTED:\s*approved/i.test(output)) {
    verdict = 'approved';
  } else if (/REVIEW POSTED:\s*changes-requested/i.test(output)) {
    verdict = 'changes-requested';
  } else if (/REVIEW DEFERRED/i.test(output)) {
    verdict = 'deferred';
  }

  return {
    prNumber,
    project,
    round: 0,
    findings,
    verdict,
    reviewedAt: new Date().toISOString(),
    sha,
    summary: output.slice(0, 500),
  };
}

/**
 * Fetch the reviewer's comment from GitHub and parse findings from it.
 *
 * WHY: The reviewer agent posts findings via `gh pr comment` — its stdout
 * only contains the signal line (`REVIEW POSTED: ...`). The actual structured
 * findings (blockers, concerns, nits) are in the GitHub comment body.
 * Parsing stdout found 0 findings every time. This fetches the real comment.
 */
export function parseReviewFromGitHub(
  prNumber: number,
  repo: string,
  project: string,
  sha: string,
  cwd: string,
): ReviewReport {
  let commentBody = '';

  try {
    // Fetch all issue-level comments (where gh pr comment posts)
    const raw = execSync(
      `gh api repos/${repo}/issues/${prNumber}/comments --jq '.[].body'`,
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Find the most recent review comment — starts with **[CHANGES REQUESTED]**,
    // **[APPROVED]**, **[COMMENT]**, or **[APPROVED but waiting]**
    const comments = raw.split('\n\n'); // gh --jq outputs bodies separated by newlines
    // Walk backwards to find the most recent review comment
    for (let i = comments.length - 1; i >= 0; i--) {
      if (/^\*\*\[(CHANGES REQUESTED|APPROVED|COMMENT)/i.test(comments[i].trim())) {
        commentBody = comments[i];
        break;
      }
    }
  } catch { /* gh not available or API error — fall through to empty report */ }

  if (!commentBody) {
    // No review comment found — return empty report with verdict from signal
    return {
      prNumber,
      project,
      round: 0,
      findings: [],
      verdict: 'commented',
      reviewedAt: new Date().toISOString(),
      sha,
      summary: '(No review comment found on GitHub)',
    };
  }

  // Parse findings from the comment body using the existing regex
  const findings = parseFindingsFromText(commentBody);

  // Extract verdict from comment header
  let verdict: ReviewReport['verdict'] = 'commented';
  if (/^\*\*\[APPROVED/i.test(commentBody.trim())) {
    verdict = 'approved';
  } else if (/^\*\*\[CHANGES REQUESTED/i.test(commentBody.trim())) {
    verdict = 'changes-requested';
  }

  return {
    prNumber,
    project,
    round: 0,
    findings,
    verdict,
    reviewedAt: new Date().toISOString(),
    sha,
    summary: commentBody.slice(0, 500),
  };
}

/**
 * Extract structured findings from text (comment body or agent output).
 *
 * Pattern: **[blocker/concern/nit]** `file:line` — description
 *          Suggestion: fix
 */
function parseFindingsFromText(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const findingPattern = /\*\*\[(blocker|concern|nit)\]\*\*\s+`?([^`\n]*)`?\s*[—–-]\s*(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = findingPattern.exec(text)) !== null) {
    const severity = match[1].toLowerCase() as ReviewFinding['severity'];
    const file = match[2]?.trim() || undefined;
    const description = match[3].trim();

    // Look for a suggestion on the next line
    const afterMatch = text.slice(match.index + match[0].length);
    const suggestionMatch = afterMatch.match(/^\s*Suggestion:\s*(.+)/m);
    const suggestion = suggestionMatch?.[1]?.trim();

    findings.push({ severity, description, file, suggestion });
  }

  return findings;
}

/** Check if close-out items already exist for this project (one review per cycle). */
export function hasExistingFindings(forgeRoot: string, project: string): boolean {
  const dir = join(forgeRoot, FINDINGS_DIR, project);
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith('.json'));
}
