/**
 * Interactive reflection session — forge introspection conversation.
 *
 * WHY interactive?
 * Autonomous reflection misses the most valuable signal: the user's experience.
 * The user knows what was painful, what required manual intervention, and what
 * forge should do differently. This module runs a multi-phase conversation:
 *
 * 1. Analysis: Agent gathers objective data (work items, git, roadmap, costs)
 * 2. Presentation: Show structured summary of forge's performance
 * 3. Commentary: User provides meta feedback on forge's process
 * 4. Synthesis: Agent produces actionable forge improvement recommendations
 * 5. Approval: User reviews, refines, approves → saved as learning
 *
 * DESIGN PRINCIPLE: Reflect is forge introspection, not project planning.
 * - Reflect asks: "How well did forge perform? What broke? What to fix in forge?"
 * - Reflect does NOT ask: "What should the project do next?"
 * - Project direction belongs in the roadmapping phase.
 *
 * Uses the reflector agent (Opus) for analysis and synthesis.
 * I/O flows through the session's readline — no separate terminal needed.
 */

import chalk from 'chalk';
import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { EventLog } from '../../events/event-log.js';

export interface ReflectSessionIO {
  /** Ask a single-line question and get the response. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Print text to the user. */
  readonly print: (text: string) => void;
  /** Collect multi-line input (until empty line). */
  readonly collectMultiLine: (prompt: string) => Promise<string>;
}

/**
 * Structured summary of a cycle's objective outcomes.
 * Built from work items, events, and roadmap data — no agent required.
 */
interface CycleSummary {
  readonly project: string;
  readonly workItemStats: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly blocked: number;
    readonly pending: number;
  };
  readonly roadmapAlignment: ReadonlyArray<{
    readonly milestone: string;
    readonly priority: string;
    readonly delivered: boolean;
    readonly workItemCount: number;
  }>;
  /** Weighted alignment score: delivered milestones / total, weighted by priority (high=3, medium=2, low=1). */
  readonly alignmentScore: {
    readonly delivered: number;
    readonly total: number;
    readonly weightedScore: number; // 0-100
    readonly grade: string; // A/B/C/D/F
  };
  readonly costSummary: ReadonlyArray<{
    readonly role: string;
    readonly cost: number;
    readonly turns: number;
  }>;
  readonly errorPatterns: ReadonlyArray<{
    readonly type: string;
    readonly count: number;
    readonly example: string;
  }>;
}

/**
 * Run an interactive reflection session for a project.
 *
 * Returns the approved reflection report, or null if cancelled.
 */
export async function runInteractiveReflect(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
  eventLog: EventLog,
  io: ReflectSessionIO,
): Promise<string | null> {
  const roadmap = store.getRoadmap(project);
  const workItems = store.getWorkItemsByProject(project);
  const previousLearning = store.getLatestLearning();
  const recentEvents = eventLog.forProject(project, 300);

  io.print(chalk.bold.blue(`\n  Reflection Session: ${project}\n`));
  io.print(chalk.dim('  Gathering cycle data and analyzing forge performance...\n'));

  // ── Phase 1: Analysis ──────────────────────────────────────────
  // Build objective cycle summary from stored data.

  const summary = buildCycleSummary(project, workItems, roadmap, recentEvents);

  // Agent analyzes the project's git state, test health, and code changes
  // to build an objective picture of what forge actually produced.
  const analysisResult = await runAgent({
    agent,
    prompt: buildAnalysisPrompt(project, projectPath, summary, previousLearning),
    cwd: projectPath,
    maxTurns: 15,
  });

  // ── Phase 2: Presentation ──────────────────────────────────────
  // Show the user a structured summary combining data + agent analysis.

  io.print(chalk.bold.blue('\n  Cycle Performance Summary\n'));
  io.print(formatCycleSummary(summary));
  io.print('\n' + analysisResult.output + '\n');

  // ── Phase 3: Commentary ────────────────────────────────────────
  // User provides meta feedback on forge's process.

  const commentary = await io.collectMultiLine(
    chalk.blue('\n  Your commentary') +
      chalk.dim(' (what worked, what was painful, what forge should change — end with empty line):\n'),
  );

  if (isCancelInput(commentary)) {
    io.print(chalk.dim('\n  Reflection session cancelled.\n'));
    return null;
  }

  const additionalContext = await io.collectMultiLine(
    chalk.blue('\n  Anything else?') +
      chalk.dim(' (specific issues, corrections, context — Enter to skip):\n'),
  );

  // ── Phase 4: Synthesis ─────────────────────────────────────────
  // Agent synthesizes user commentary + objective data into recommendations.

  io.print(chalk.dim('\n  Synthesizing recommendations...\n'));

  const synthesisResult = await runAgent({
    agent,
    prompt: buildSynthesisPrompt(
      project, projectPath, summary,
      analysisResult.output, commentary, additionalContext,
      previousLearning,
    ),
    cwd: projectPath,
    maxTurns: 20,
  });

  let report = parseReportFromOutput(synthesisResult.output);
  io.print(formatReportForReview(report));

  // ── Phase 5: Approval loop ────────────────────────────────────
  // User reviews and iterates until satisfied.

  while (true) {
    const feedback = await io.collectMultiLine(
      chalk.blue('\n  Feedback?') +
        chalk.dim(' ("approve" to save, "cancel" to discard):\n'),
    );

    if (isApprovalInput(feedback)) {
      store.saveLearning(report);
      io.print(chalk.green(`\n  Reflection saved for ${project}.\n`));
      io.print(chalk.dim('  This will inform the next roadmap session.\n'));
      return report;
    }

    if (isCancelInput(feedback)) {
      io.print(chalk.dim('\n  Reflection session cancelled.\n'));
      return null;
    }

    io.print(chalk.dim('\n  Refining recommendations...\n'));

    const refineResult = await runAgent({
      agent,
      prompt: buildRefinePrompt(project, report, feedback),
      cwd: projectPath,
      maxTurns: 15,
    });

    report = parseReportFromOutput(refineResult.output);
    io.print(formatReportForReview(report));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Cycle summary builder (data-driven, no agent needed)
// ═══════════════════════════════════════════════════════════════════

function buildCycleSummary(
  project: string,
  workItems: ReadonlyArray<{ readonly status: string; readonly title: string }>,
  roadmap: { readonly milestones: ReadonlyArray<{ readonly title: string; readonly priority: string }> } | null,
  events: ReadonlyArray<{
    readonly type: string;
    readonly data?: Record<string, unknown>;
    readonly agentRole?: string;
    readonly summary: string;
  }>,
): CycleSummary {
  const completed = workItems.filter((i) => i.status === 'completed');
  const failed = workItems.filter((i) => i.status === 'failed');
  const blocked = workItems.filter((i) => i.status === 'blocked');
  const pending = workItems.filter((i) => i.status === 'pending');

  // Roadmap alignment: match milestones to work items by keyword overlap.
  // Uses significant keywords (3+ chars, lowercase) from milestone titles and
  // checks how many appear in each work item's title. A work item is "related"
  // if it shares at least 2 keywords with the milestone (or 1 for short titles).
  const roadmapAlignment = (roadmap?.milestones ?? []).map((m) => {
    const milestoneKeywords = extractKeywords(m.title);
    const minOverlap = milestoneKeywords.length <= 2 ? 1 : 2;

    const related = workItems.filter((wi) => {
      const itemKeywords = extractKeywords(wi.title);
      const overlap = milestoneKeywords.filter((k) => itemKeywords.includes(k)).length;
      return overlap >= minOverlap;
    });

    const delivered = related.length > 0 && related.every((wi) => wi.status === 'completed');
    return {
      milestone: m.title,
      priority: m.priority,
      delivered,
      workItemCount: related.length,
    };
  });

  // Weighted alignment score: high=3, medium=2, low=1
  const priorityWeight = (p: string): number =>
    p === 'high' ? 3 : p === 'medium' ? 2 : 1;
  const totalWeight = roadmapAlignment.reduce((sum, m) => sum + priorityWeight(m.priority), 0);
  const deliveredWeight = roadmapAlignment
    .filter((m) => m.delivered)
    .reduce((sum, m) => sum + priorityWeight(m.priority), 0);
  const weightedScore = totalWeight > 0 ? Math.round((deliveredWeight / totalWeight) * 100) : 0;
  const grade = weightedScore >= 90 ? 'A' : weightedScore >= 75 ? 'B' : weightedScore >= 60 ? 'C' : weightedScore >= 40 ? 'D' : 'F';
  const alignmentScore = {
    delivered: roadmapAlignment.filter((m) => m.delivered).length,
    total: roadmapAlignment.length,
    weightedScore,
    grade,
  };

  // Cost aggregation by role
  const costByRole = new Map<string, { cost: number; turns: number }>();
  for (const event of events) {
    if (event.type === 'agent.cost' && event.agentRole) {
      const existing = costByRole.get(event.agentRole) ?? { cost: 0, turns: 0 };
      costByRole.set(event.agentRole, {
        cost: existing.cost + Number(event.data?.totalCostUsd ?? 0),
        turns: existing.turns + Number(event.data?.numTurns ?? 0),
      });
    }
  }
  const costSummary = Array.from(costByRole.entries()).map(([role, data]) => ({
    role,
    cost: data.cost,
    turns: data.turns,
  }));

  // Error pattern aggregation
  const errorCounts = new Map<string, { count: number; example: string }>();
  for (const event of events) {
    if (event.type.includes('error')) {
      const existing = errorCounts.get(event.type);
      if (existing) {
        existing.count += 1;
      } else {
        errorCounts.set(event.type, { count: 1, example: event.summary });
      }
    }
  }
  const errorPatterns = Array.from(errorCounts.entries()).map(([type, data]) => ({
    type,
    count: data.count,
    example: data.example,
  }));

  return {
    project,
    workItemStats: {
      total: workItems.length,
      completed: completed.length,
      failed: failed.length,
      blocked: blocked.length,
      pending: pending.length,
    },
    roadmapAlignment,
    alignmentScore,
    costSummary,
    errorPatterns,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Prompt builders
// ═══════════════════════════════════════════════════════════════════

function buildAnalysisPrompt(
  project: string,
  projectPath: string,
  summary: CycleSummary,
  previousLearning: string | null,
): string {
  const learningContext = previousLearning
    ? `\n## Previous Reflection\n\n${previousLearning.slice(0, 2000)}`
    : '';

  return `You are analyzing forge's performance during a cycle on "${project}" at ${projectPath}.

## CRITICAL: Scope of Analysis

This reflection is about FORGE'S PROCESS, not about the project itself.
You are evaluating: Did forge's pipeline work correctly? Where did it break?
What changes to forge would improve outcomes?

Do NOT comment on project architecture, feature design, or future direction.
Those belong in roadmapping.

## Cycle Data

${JSON.stringify(summary, null, 2)}
${learningContext}

## Your Task

1. **Check project health.** Run the project's build/test commands to see current state.
2. **Review git history.** Look at recent commits to understand what forge produced vs what
   required manual intervention (commits not from forge agents).
3. **Identify integration issues.** Check for post-merge fix commits, reverts, or cleanups
   that suggest forge's merge process failed.
4. **Assess quality.** Are there test failures, type errors, lint violations?

## Output Format

Write a concise analysis as plain text (NOT JSON, NOT markdown code blocks):

**Forge Pipeline Health:**
[2-3 sentences on whether the pipeline produced correct output]

**Integration Issues Found:**
[List specific problems that required manual intervention, with commit references]

**Quality Gate Status:**
[Current test/type/lint status and whether forge left it clean]

**Cost Efficiency:**
[Whether agent spending was proportionate to outcomes]

## Rules

- Do NOT modify any files. You are read-only.
- Be specific — reference actual commits, files, and numbers.
- Focus on forge's process failures, not project-level concerns.
- If previous reflection recommendations were made, note whether they were addressed.`;
}

function buildSynthesisPrompt(
  project: string,
  projectPath: string,
  summary: CycleSummary,
  analysisOutput: string,
  userCommentary: string,
  additionalContext: string,
  previousLearning: string | null,
): string {
  const learningContext = previousLearning
    ? `\n## Previous Reflection\n\nCheck whether these recommendations were addressed:\n${previousLearning.slice(0, 2000)}`
    : '';

  return `You are synthesizing a forge reflection for "${project}" at ${projectPath}.

## CRITICAL: This is about FORGE, not about ${project}.

Every recommendation must be a change to forge's code, configuration, agent definitions,
or pipeline behavior. Do NOT recommend project-level changes.

## Inputs

### Objective Cycle Data
${JSON.stringify(summary, null, 2)}

### Agent Analysis
${analysisOutput}

### User Commentary
${userCommentary}
${additionalContext ? `\n### Additional Context\n${additionalContext}` : ''}
${learningContext}

## Your Task

Synthesize the objective data and user feedback into a structured reflection report.
The report must contain:

1. **Summary** — 2-3 sentences on forge's cycle performance
2. **What Forge Got Right** — specific things that worked well in forge's process
3. **What Forge Got Wrong** — specific failures in forge's pipeline, merge strategy,
   quality gates, or agent behavior
4. **Root Causes** — why things went wrong (not symptoms, causes)
5. **Forge Improvement Plan** — concrete, actionable changes to forge itself:
   - **Immediate** (implement before next cycle)
   - **Short-term** (implement within 1-2 cycles)
   - **Long-term** (architectural improvements to forge)
6. **Alignment Score** — how well did implemented features match the roadmap?

## Output Format

Produce the report as a markdown document wrapped in a code block:

\`\`\`markdown
# Forge Reflection — ${project} — [Date]

## Summary
[2-3 sentences]

## What Forge Got Right
[Bullet points]

## What Forge Got Wrong
[Bullet points with specific evidence]

## Root Causes
[Analysis of why, not just what]

## Forge Improvement Plan

### Immediate (before next cycle)
- [Specific change to forge code/config/agents]

### Short-term (next 1-2 cycles)
- [Specific change]

### Long-term
- [Architectural improvement]

## Alignment Score
[X/Y milestones delivered, with table if useful]
\`\`\`

## Rules

- Do NOT modify any files. You are read-only.
- Every recommendation must be actionable and specific to forge.
- If the user's commentary contradicts objective data, note the discrepancy.
- Be brutally honest — the goal is continuous improvement.
- Weight user experience heavily — if the user says something was painful, it was.`;
}

function buildRefinePrompt(
  project: string,
  currentReport: string,
  feedback: string,
): string {
  return `You are refining a forge reflection report for "${project}".

## Current Report

${currentReport}

## User Feedback

${feedback}

## Your Task

Refine the report based on the user's feedback. Keep what works, change what they asked for.
Remember: this is about FORGE's process, not about ${project}'s features.

## Output

Produce the updated report as a markdown document wrapped in a code block:

\`\`\`markdown
[Updated report with same structure]
\`\`\`

## Rules

- Apply the feedback precisely — don't drift from what was asked.
- Keep sections the user was happy with.
- Do NOT modify any files.
- Output ONLY the markdown report wrapped in a code block.`;
}

// ═══════════════════════════════════════════════════════════════════
// Parsing & formatting
// ═══════════════════════════════════════════════════════════════════

function parseReportFromOutput(output: string): string {
  const mdMatch = output.match(/```markdown\s*([\s\S]*?)```/);
  return mdMatch?.[1]?.trim() ?? output;
}

function formatCycleSummary(summary: CycleSummary): string {
  const lines: string[] = [];
  const { workItemStats: stats } = summary;

  lines.push(chalk.bold(`  Work Items: ${stats.total} total`));
  lines.push(
    `    ${chalk.green(`${stats.completed} completed`)} · ` +
    `${chalk.red(`${stats.failed} failed`)} · ` +
    `${chalk.yellow(`${stats.blocked} blocked`)} · ` +
    `${chalk.dim(`${stats.pending} pending`)}`,
  );

  if (stats.total > 0) {
    const rate = Math.round((stats.completed / stats.total) * 100);
    lines.push(`    ${chalk.bold(`Completion rate: ${rate}%`)}`);
  }

  if (summary.roadmapAlignment.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Roadmap Alignment:'));
    for (const m of summary.roadmapAlignment) {
      const status = m.delivered ? chalk.green('delivered') : chalk.red('not delivered');
      const priorityColor = m.priority === 'high' ? chalk.red
        : m.priority === 'medium' ? chalk.yellow
        : chalk.dim;
      lines.push(
        `    ${priorityColor(`[${m.priority.toUpperCase()}]`)} ${m.milestone}` +
        ` — ${status} (${m.workItemCount} items)`,
      );
    }
  }

  if (summary.costSummary.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Agent Costs:'));
    const totalCost = summary.costSummary.reduce((sum, c) => sum + c.cost, 0);
    for (const c of summary.costSummary) {
      lines.push(`    ${chalk.cyan(c.role)}: $${c.cost.toFixed(2)} (${c.turns} turns)`);
    }
    lines.push(`    ${chalk.bold(`Total: $${totalCost.toFixed(2)}`)}`);
  }

  // Alignment score
  if (summary.roadmapAlignment.length > 0) {
    const { alignmentScore: score } = summary;
    const gradeColor = score.grade === 'A' ? chalk.green
      : score.grade === 'B' ? chalk.blue
      : score.grade === 'C' ? chalk.yellow
      : chalk.red;
    lines.push('');
    lines.push(chalk.bold('  Alignment Score:'));
    lines.push(
      `    ${gradeColor(`Grade: ${score.grade}`)} — ` +
      `${score.delivered}/${score.total} milestones delivered ` +
      `(${score.weightedScore}% weighted by priority)`,
    );
  }

  if (summary.errorPatterns.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Error Patterns:'));
    for (const e of summary.errorPatterns) {
      lines.push(`    ${chalk.red(e.type)} (${e.count}x): ${chalk.dim(e.example)}`);
    }
  }

  return lines.join('\n');
}

function formatReportForReview(report: string): string {
  const lines: string[] = [];
  lines.push(chalk.bold.blue('\n  Reflection Report\n'));
  // Indent each line of the report for consistent display
  for (const line of report.split('\n')) {
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Text analysis helpers
// ═══════════════════════════════════════════════════════════════════

/** Common stop words that don't carry meaning for keyword matching. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'was',
  'will', 'can', 'has', 'have', 'had', 'been', 'being', 'not', 'but', 'all',
  'add', 'new', 'use', 'set', 'get', 'update', 'implement', 'create', 'make',
]);

/**
 * Extract significant keywords from a title for fuzzy matching.
 * Filters out stop words and short tokens (< 3 chars), returns lowercase.
 */
function extractKeywords(title: string): readonly string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

// ═══════════════════════════════════════════════════════════════════
// Input classification
// ═══════════════════════════════════════════════════════════════════

function isApprovalInput(input: string): boolean {
  return /^(approve|done|ok|lgtm|yes|ship\s*it|looks\s*good|save)\s*$/i.test(input.trim());
}

function isCancelInput(input: string): boolean {
  return /^(cancel|abort|quit|exit|nevermind|never\s*mind)\s*$/i.test(input.trim());
}
