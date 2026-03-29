/**
 * Interactive review session — progressive layer-by-layer review.
 *
 * WHY layer-by-layer:
 * Stacked PRs that all target `main` accumulate ancestor commits in their
 * diff. Reviewing all PRs at once means PR B's summary includes all of PR A's
 * changes. By processing in merge-layer order (review → close-out → merge
 * layer 0, then layer 1, etc.), each subsequent layer's diff against updated
 * main naturally shows only its unique contribution.
 *
 * Flow:
 *   1. Scan PRs, determine dependency order (persist as artifact)
 *   2. Group PRs by merge layer
 *   3. For each layer:
 *      a. Queue automated reviews for this layer's PRs
 *      b. Wait for reviews to complete
 *      c. Generate handoff summaries (with unique delta for stacked PRs)
 *      d. Present PRs to user, collect decisions
 *      e. Create close-out work items
 *      f. If more layers remain: wait for close-outs to merge, then continue
 *   4. Enable worker for final layer's autonomous close-out
 *
 * Single-layer fast path: when all PRs are layer 0, the loop executes once
 * with no inter-layer waiting — identical to the previous flat flow.
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import type { StateStore } from '../../state/store.js';
import type { EventLog } from '../../events/event-log.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { ForgeSettings } from '../../config/index.js';
import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import { scanOpenPRs, buildFileOwnershipMap, type OpenPR } from './review-prs.js';
import { loadReviewFindings, loadAllFindings } from './review-findings.js';
import { collectPRRawData, buildHandoffPrompt, buildPresentation, type PRPresentation } from './pr-summary.js';
import { savePRScanArtifact } from './review-artifacts.js';
import type { WorkItem, CloseOutMeta } from '../types.js';

export interface ReviewSessionIO {
  /** Ask a single-line question and get the response. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Print text to the user. */
  readonly print: (text: string) => void;
  /** Collect multi-line input (until empty line). */
  readonly collectMultiLine: (prompt: string) => Promise<string>;
}

export interface ReviewSessionDeps {
  readonly store: StateStore;
  readonly queue: JobQueue;
  readonly eventLog: EventLog;
  readonly settings: ForgeSettings;
  readonly enableWorker: () => void;
  readonly disableWorker: () => void;
  readonly waitForReviewsDrained: (project: string) => Promise<void>;
  readonly waitForCloseOutsDrained: (project: string, prNumbers: readonly number[]) => Promise<void>;
  /** Agent definition for generating handoff summaries. */
  readonly summaryAgent: AgentDefinition;
}

/** User decision for a single PR. */
interface PRDecision {
  readonly pr: OpenPR;
  readonly presentation: PRPresentation;
  readonly action: 'accept' | 'feedback';
  readonly feedback?: string;
}

/**
 * Run an interactive review session for a project.
 *
 * Processes PRs in merge-layer order. Foundation PRs (layer 0) are reviewed
 * and merged first, then dependent PRs (layer 1+) are reviewed with naturally
 * correct unique deltas.
 */
export async function runInteractiveReview(
  project: string,
  deps: ReviewSessionDeps,
  io: ReviewSessionIO,
): Promise<void> {
  const { store, settings } = deps;
  const forgeRoot = resolve(settings.workspaceRoot, '.forge');

  // ── Guard: one review per cycle ─────────────────────────────────
  const existingCloseOuts = store.getWorkItemsByProject(project)
    .filter((wi) => wi.closeOut !== undefined);
  const activeCloseOuts = existingCloseOuts.filter(
    (wi) => wi.status === 'pending' || wi.status === 'in-progress' || wi.status === 'blocked',
  );
  if (activeCloseOuts.length > 0) {
    io.print(chalk.yellow(`\n  Review in progress for ${project}.`));
    io.print(chalk.dim(`  ${activeCloseOuts.length} close-out item(s) still active. Wait for them to complete or /cancel.\n`));
    return;
  }

  io.print(chalk.bold.blue(`\n  Review Session: ${project}\n`));

  // ── Phase 1: Scan & build context ──────────────────────────────
  io.print(chalk.dim('  Scanning for open PRs...\n'));

  const prs = scanOpenPRs([project], settings.workspaceRoot, settings.projectsDir);

  if (prs.length === 0) {
    io.print(chalk.dim('  No open PRs found.\n'));
    return;
  }

  const projectPath = resolve(settings.workspaceRoot, settings.projectsDir, project);
  const fileOwnership = buildFileOwnershipMap(prs, projectPath);

  if (fileOwnership.overlappingFiles.size > 3) {
    const overlapCount = fileOwnership.overlappingFiles.size;
    io.print(chalk.yellow(`  ⚠ ${overlapCount} files shared across multiple PRs — implementation created cross-contaminated branches.`));
    io.print(chalk.dim('    Consider adding dependency constraints to the roadmap for the next cycle.\n'));
  }

  savePRScanArtifact(forgeRoot, project, prs, fileOwnership);

  // ── Phase 2: Progressive layer-by-layer review ─────────────────
  const maxLayer = Math.max(...prs.map((p) => p.mergeLayer));
  const allCloseOutItems: WorkItem[] = [];

  if (maxLayer > 0) {
    io.print(chalk.bold(`  ${prs.length} PR(s) across ${maxLayer + 1} merge layers. Reviewing layer-by-layer.\n`));
  } else {
    io.print(chalk.dim(`  Found ${prs.length} open PR(s).\n`));
  }

  for (let layer = 0; layer <= maxLayer; layer++) {
    const layerPRs = prs.filter((p) => p.mergeLayer === layer);
    if (layerPRs.length === 0) continue;

    if (layer > 0) {
      io.print(chalk.bold.blue(`\n  ── Layer ${layer} (${layerPRs.length} PR${layerPRs.length > 1 ? 's' : ''}) ──\n`));
    }

    const closeOuts = await processLayer(
      layer, layerPRs, prs, project, deps, io,
      forgeRoot, projectPath, allCloseOutItems,
    );
    allCloseOutItems.push(...closeOuts);

    // Wait for this layer's close-outs before proceeding to next
    if (layer < maxLayer && closeOuts.length > 0) {
      io.print(chalk.dim(`\n  Waiting for layer ${layer} close-outs to complete before reviewing layer ${layer + 1}...`));
      deps.enableWorker();

      const layerPRNumbers = layerPRs.map((p) => p.number);
      await deps.waitForCloseOutsDrained(project, layerPRNumbers);

      deps.disableWorker();
      io.print(chalk.green(`  Layer ${layer} merged. Proceeding to layer ${layer + 1}.\n`));
    }
  }

  // Enable worker for the final layer's close-out processing
  if (allCloseOutItems.length > 0) {
    io.print(chalk.dim('  Enabling worker for autonomous close-out processing.\n'));
    deps.enableWorker();
  }

  io.print(chalk.bold.green(`  Review session complete for ${project}.\n`));
}

// ═══════════════════════════════════════════════════════════════════
// Per-layer processing
// ═══════════════════════════════════════════════════════════════════

/**
 * Process a single merge layer: queue reviews, wait, summarize, present,
 * create close-out items.
 *
 * Returns the close-out work items created for this layer.
 */
async function processLayer(
  layer: number,
  layerPRs: readonly OpenPR[],
  allPRs: readonly OpenPR[],
  project: string,
  deps: ReviewSessionDeps,
  io: ReviewSessionIO,
  forgeRoot: string,
  projectPath: string,
  previousCloseOutItems: readonly WorkItem[],
): Promise<readonly WorkItem[]> {
  const { store, queue, eventLog, settings } = deps;

  // ── Step 1: Queue automated reviews ────────────────────────────
  io.print(chalk.dim(`  Queuing ${layerPRs.length} automated review(s)...`));

  for (const pr of layerPRs) {
    queue.post('review', 'review', pr.project, {
      prNumber:      pr.number,
      prTitle:       pr.title,
      prUrl:         pr.url,
      branch:        pr.branch,
      repo:          pr.repo,
      project:       pr.project,
      prCreatedAt:   pr.createdAt,
      mergeLayer:    pr.mergeLayer,
      dependsOnPRs:  pr.dependsOnPRs,
      blocksPRs:     pr.blocksPRs,
      uniqueHeadSha: pr.uniqueHeadSha,
      preReview:     true,
    }, 5 + pr.mergeLayer);
  }

  eventLog.emit({
    type: 'jobs.queued',
    summary: `Queued ${layerPRs.length} pre-review job(s) for ${project} (layer ${layer})`,
  });

  // ── Step 2: Wait for reviews ───────────────────────────────────
  io.print(chalk.dim('  Running automated reviews...\n'));
  deps.enableWorker();

  const progressInterval = setInterval(() => {
    const allFindings = loadAllFindings(forgeRoot, project);
    const reviewedInLayer = layerPRs.filter(
      (pr) => allFindings.some((f) => f.prNumber === pr.number),
    ).length;
    if (reviewedInLayer > 0 && reviewedInLayer < layerPRs.length) {
      io.print(chalk.dim(`  Progress: ${reviewedInLayer}/${layerPRs.length} reviews complete`));
    }
  }, 5_000);

  try {
    await deps.waitForReviewsDrained(project);
  } finally {
    clearInterval(progressInterval);
  }

  deps.disableWorker();

  const allFindings = loadAllFindings(forgeRoot, project);
  io.print(chalk.green(`  ${layerPRs.length} review(s) complete.\n`));

  // Show findings summary for this layer
  const layerFindings = allFindings.filter((f) => layerPRs.some((pr) => pr.number === f.prNumber));
  const blockers = layerFindings.reduce((sum, r) => sum + r.findings.filter((f) => f.severity === 'blocker').length, 0);
  const concerns = layerFindings.reduce((sum, r) => sum + r.findings.filter((f) => f.severity === 'concern').length, 0);
  if (blockers > 0 || concerns > 0) {
    io.print(chalk.dim(`  Layer ${layer} findings: ${blockers} blocker(s), ${concerns} concern(s)\n`));
  }

  // ── Step 3: Generate handoff summaries ─────────────────────────
  const workItems = store.getWorkItemsByProject(project);
  const decisions: PRDecision[] = [];

  io.print(chalk.bold('  Generating handoff summaries...\n'));

  // Build PR number → branch name map for parent branch resolution
  const prBranchMap = new Map(allPRs.map((p) => [p.number, p.branch]));

  const rawDataByPR = new Map(
    layerPRs.map((pr) => {
      // Resolve parent branch names for unique delta computation
      const parentBranches = pr.dependsOnPRs
        .map((depNum) => prBranchMap.get(depNum))
        .filter((b): b is string => b !== undefined);

      return [
        pr.number,
        collectPRRawData(
          pr.number, pr.url, pr.title, pr.branch, pr.repo,
          project, settings.workspaceRoot, settings.projectsDir,
          forgeRoot, workItems,
          parentBranches.length > 0 ? parentBranches : undefined,
        ),
      ] as const;
    }),
  );

  // Generate handoff narratives via agent
  const presentations = new Map<number, PRPresentation>();

  for (const pr of layerPRs) {
    const rawData = rawDataByPR.get(pr.number)!;
    const prompt = buildHandoffPrompt(rawData);

    io.print(chalk.dim(`  Summarizing PR #${pr.number}...`));

    let handoffSummary: string;
    try {
      const result = await runAgent({
        agent: deps.summaryAgent,
        prompt,
        cwd: projectPath,
        maxTurns: 3,
      });
      handoffSummary = result.output.trim();
    } catch {
      handoffSummary = '';
    }

    if (!handoffSummary) {
      const items = rawData.workItems;
      handoffSummary = items.length > 0
        ? items.map((wi) => `${wi.title}: ${wi.description}`).join('\n\n')
        : `PR #${pr.number}: ${pr.title}`;
    }

    presentations.set(pr.number, buildPresentation(rawData, handoffSummary));
  }

  io.print(chalk.green('  Summaries ready.\n'));

  // ── Step 4: Present PRs to user ────────────────────────────────
  const layerLabel = layerPRs.length > 1
    ? `  Presenting ${layerPRs.length} PRs (layer ${layer}).`
    : `  Presenting 1 PR (layer ${layer}).`;
  io.print(chalk.bold(layerLabel));
  io.print(chalk.dim('  For each: Enter/[a] to accept, or type feedback.\n'));

  for (let i = 0; i < layerPRs.length; i++) {
    const pr = layerPRs[i];
    const presentation = presentations.get(pr.number)!;

    displayPR(io, pr, presentation, i + 1, layerPRs.length);

    if (presentation.concerns.length > 0) {
      io.print(chalk.yellow('\n  Concerns needing your judgement:'));
      for (const finding of presentation.concerns) {
        const fileRef = finding.file ? chalk.dim(` (${finding.file})`) : '';
        io.print(chalk.yellow(`    - ${finding.description}${fileRef}`));
        if (finding.suggestion) {
          io.print(chalk.dim(`      Suggestion: ${finding.suggestion}`));
        }
      }
    }

    io.print('');

    const answer = await io.ask(
      chalk.blue(`  [${i + 1}/${layerPRs.length}] `) + 'Action ([a]ccept / type feedback): ',
    );
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === 'a' || trimmed === 'accept' || trimmed === '') {
      io.print(chalk.green('  → Accepted\n'));
      decisions.push({ pr, presentation, action: 'accept' });
    } else {
      io.print(chalk.green('  → Accepted with feedback\n'));
      decisions.push({
        pr,
        presentation,
        action: 'feedback',
        feedback: answer.trim(),
      });
    }
  }

  // ── Step 5: Create close-out work items ────────────────────────
  io.print(chalk.bold('\n  Creating close-out work items...\n'));

  const closeOutItems: WorkItem[] = [];
  const existingItems = store.getWorkItemsByProject(project);
  const maxSeq = existingItems.reduce((max, wi) => Math.max(max, wi.seq), 0);

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const report = loadReviewFindings(forgeRoot, project, d.pr.number);
    const hasFeedback = d.action === 'feedback';
    const hasBlockers = (report?.findings.filter((f) => f.severity === 'blocker').length ?? 0) > 0;
    const isConflicting = d.presentation.mergeable === 'CONFLICTING';
    const needsFix = hasFeedback || hasBlockers || isConflicting;

    const action: CloseOutMeta['action'] = needsFix ? 'fix-and-merge' : 'merge-only';
    const seq = maxSeq + i + 1;
    const slug = slugify(`close-out-pr-${d.pr.number}`);

    const feedback = d.feedback
      ?? (isConflicting && !hasFeedback && !hasBlockers
        ? 'Resolve merge conflicts with main branch.'
        : undefined);

    const closeOutMeta: CloseOutMeta = {
      prNumber: d.pr.number,
      repo: d.pr.repo,
      action,
      userFeedback: feedback,
      initialIssueCount: report?.findings.length ?? 0,
      mergeLayer: d.pr.mergeLayer,
      dependsOnPRs: d.pr.dependsOnPRs,
      blocksPRs: d.pr.blocksPRs,
      branch: d.pr.branch,
    };

    // Close-out items depend on their parent PR's close-out items
    // (from this layer or previous layers)
    const allPreviousCloseOuts = [...previousCloseOutItems, ...closeOutItems];
    const closeOutDeps = d.pr.dependsOnPRs
      .map((depPrNum) => {
        const depItem = allPreviousCloseOuts.find((ci) => ci.closeOut?.prNumber === depPrNum);
        return depItem?.id;
      })
      .filter((id): id is string => id !== undefined);

    const workItem: WorkItem = {
      id: `${project}/${seq}-${slug}`,
      project,
      seq,
      title: `Close-out: PR #${d.pr.number} — ${d.pr.title}`,
      description: action === 'merge-only'
        ? `Merge PR #${d.pr.number} (approved, no changes needed).`
        : `Fix PR #${d.pr.number} based on review findings${d.feedback ? ` and user feedback: ${d.feedback}` : ''}, then merge.`,
      stage: 'develop',
      status: 'pending',
      branch: d.pr.branch,
      dependsOn: closeOutDeps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stageOutputs: {},
      needsHumanReview: false,
      closeOut: closeOutMeta,
    };

    store.saveWorkItem(workItem);
    closeOutItems.push(workItem);

    const actionLabel = action === 'merge-only' ? chalk.green('merge-only') : chalk.cyan('fix-and-merge');
    io.print(chalk.dim(`  ${actionLabel} PR #${d.pr.number}: ${d.pr.title}`));
  }

  io.print(chalk.bold(`\n  Created ${closeOutItems.length} close-out item(s).\n`));

  // Queue work-item jobs for close-out items
  for (const item of closeOutItems) {
    const itemLayer = item.closeOut?.mergeLayer ?? 0;
    queue.post('work-item', 'review', project, {
      workItemId: item.id,
    }, 8 + itemLayer);
  }

  eventLog.emit({
    type: 'jobs.queued',
    summary: `Created ${closeOutItems.length} close-out items for ${project} (layer ${layer})`,
  });

  return closeOutItems;
}

// ═══════════════════════════════════════════════════════════════════
// Display helpers
// ═══════════════════════════════════════════════════════════════════

function displayPR(
  io: ReviewSessionIO,
  pr: OpenPR,
  presentation: PRPresentation,
  index: number,
  total: number,
): void {
  const layerLabel = pr.mergeLayer > 0 ? chalk.yellow(` [layer ${pr.mergeLayer}]`) : chalk.green(' [foundation]');
  const chainLabel = pr.chainMembers && pr.chainMembers.length > 1
    ? chalk.bold.cyan(` [chain tip: ${pr.chainMembers.length} PRs]`)
    : '';

  io.print(chalk.bold(`\n  ── PR #${pr.number}${layerLabel}${chainLabel} ── [${index}/${total}] ──`));
  io.print(chalk.cyan(`  ${pr.title}`));
  io.print(chalk.dim(`  ${pr.url}`));

  if (presentation.mergeable === 'CONFLICTING') {
    io.print(chalk.red('  Has merge conflicts'));
  } else if (presentation.mergeable === 'MERGEABLE') {
    io.print(chalk.green('  Mergeable'));
  }

  io.print('');
  for (const line of presentation.handoffSummary.split('\n')) {
    io.print(`  ${line}`);
  }

  const verdictColor = presentation.verdict === 'approved' ? chalk.green
    : presentation.verdict === 'changes-requested' ? chalk.red
    : chalk.yellow;
  io.print(chalk.bold('\n  Review:'));
  io.print(`  ${verdictColor(presentation.findingsSummary)}`);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
