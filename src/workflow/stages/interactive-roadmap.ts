/**
 * Interactive roadmap session — collaborative design conversation.
 *
 * WHY interactive?
 * Fire-and-forget roadmap generation misses the point. Roadmapping is a
 * design activity — the user has context, priorities, and vision that can't
 * be extracted from code analysis alone. This module runs a multi-phase
 * conversation:
 *
 * 1. Discovery: Agent analyzes project, generates context-aware questions
 * 2. Direction: User provides goals, priorities, constraints
 * 3. Draft: Agent generates a roadmap based on accumulated context
 * 4. Refinement: User reviews, provides feedback, agent refines
 * 5. Approval: User approves, roadmap is saved
 *
 * Uses the architect agent (Opus) for analysis and generation.
 * I/O flows through the session's readline — no separate terminal needed.
 */

import chalk from 'chalk';
import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { Roadmap } from '../types.js';

export interface RoadmapSessionIO {
  /** Ask a single-line question and get the response. */
  readonly ask: (prompt: string) => Promise<string>;
  /** Print text to the user. */
  readonly print: (text: string) => void;
  /** Collect multi-line input (until empty line). */
  readonly collectMultiLine: (prompt: string) => Promise<string>;
}

/**
 * Run an interactive roadmap session for a project.
 *
 * Returns the approved roadmap, or null if cancelled.
 */
export async function runInteractiveRoadmap(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
  io: RoadmapSessionIO,
): Promise<Roadmap | null> {
  const existingRoadmap = store.getRoadmap(project);
  const latestLearning = store.getLatestLearning();

  io.print(chalk.bold.blue(`\n  Roadmap Session: ${project}\n`));
  io.print(chalk.dim('  Analyzing project and preparing questions...\n'));

  // ── Phase 1: Discovery ──────────────────────────────────────────
  // Agent reads the project and generates a summary + smart questions.

  const discoveryResult = await runAgent({
    agent,
    prompt: buildDiscoveryPrompt(project, projectPath, existingRoadmap, latestLearning),
    cwd: projectPath,
    maxTurns: 15,
  });

  io.print('\n' + discoveryResult.output + '\n');

  // ── Phase 2: Direction ──────────────────────────────────────────
  // User provides goals, priorities, constraints.

  const direction = await io.collectMultiLine(
    chalk.blue('\n  Your direction') + chalk.dim(' (goals, priorities — end with empty line):\n'),
  );

  if (isCancelInput(direction)) {
    io.print(chalk.dim('\n  Roadmap session cancelled.\n'));
    return null;
  }

  const constraints = await io.collectMultiLine(
    chalk.blue('\n  Constraints?') + chalk.dim(' (limitations, things to avoid — Enter to skip):\n'),
  );

  // ── Phase 3: Draft ──────────────────────────────────────────────
  // Agent generates a roadmap from project analysis + user direction.

  io.print(chalk.dim('\n  Generating roadmap draft...\n'));

  const draftResult = await runAgent({
    agent,
    prompt: buildDraftPrompt(
      project, projectPath, existingRoadmap,
      direction, constraints, discoveryResult.output,
    ),
    cwd: projectPath,
    maxTurns: 20,
  });

  let roadmap = parseRoadmapFromOutput(draftResult.output, project, existingRoadmap);
  io.print(formatRoadmapForReview(roadmap));

  // ── Phase 4: Refinement loop ────────────────────────────────────
  // User reviews and iterates until satisfied.

  while (true) {
    const feedback = await io.collectMultiLine(
      chalk.blue('\n  Feedback?') + chalk.dim(' ("approve" to finalize, "cancel" to abort):\n'),
    );

    if (isApprovalInput(feedback)) {
      store.saveRoadmap(roadmap);
      store.saveDesignBrief({
        project,
        direction: roadmap.direction,
        features: roadmap.milestones.map((m) => ({
          title: m.title,
          rationale: m.rationale,
          scope: m.scope,
          priority: m.priority,
        })),
        technicalNotes: roadmap.technicalNotes,
      });
      io.print(chalk.green(`\n  Roadmap saved for ${project} (${roadmap.milestones.length} milestones)\n`));
      return roadmap;
    }

    if (isCancelInput(feedback)) {
      io.print(chalk.dim('\n  Roadmap session cancelled.\n'));
      return null;
    }

    io.print(chalk.dim('\n  Refining roadmap...\n'));

    const refineResult = await runAgent({
      agent,
      prompt: buildRefinePrompt(project, projectPath, roadmap, feedback),
      cwd: projectPath,
      maxTurns: 15,
    });

    roadmap = parseRoadmapFromOutput(refineResult.output, project, existingRoadmap);
    io.print(formatRoadmapForReview(roadmap));
  }
}

// ═══════════════════════════════════════════════════════════════════
// Prompt builders
// ═══════════════════════════════════════════════════════════════════

function buildDiscoveryPrompt(
  project: string,
  projectPath: string,
  existingRoadmap: Roadmap | null,
  latestLearning: string | null,
): string {
  const existingContext = existingRoadmap
    ? `\n## Existing Roadmap\n\nThis project has a previous roadmap:\n${JSON.stringify(existingRoadmap, null, 2)}\n\nReference what was planned before — the user may want to continue, pivot, or refine.`
    : '';

  const learningContext = latestLearning
    ? `\n## Recent Learnings\n\n${latestLearning.slice(0, 2000)}`
    : '';

  return `You are conducting a roadmap discovery session for "${project}" at ${projectPath}.

## Your Task

1. **Analyze the project thoroughly.** Read README, config files, source code, tests, docs.
2. **Produce a concise project summary** — where ${project} stands today.
3. **Generate 3-5 thoughtful discovery questions** that will help shape the roadmap.

Your questions should:
- Draw on what you found in the codebase (reference specific things)
- Help clarify the user's priorities and vision
- Suggest interesting directions based on what you see
- Ask about trade-offs that matter for the next phase of work
- Be genuinely useful, not pro-forma
${existingContext}${learningContext}

## Output Format

Write your response as plain text (NOT JSON):

**Project Summary:**
[2-3 paragraphs about current state, strengths, gaps]

**Questions:**
1. [Question referencing something specific you found]
2. [Question about priorities/direction]
3. [Question about scope/constraints]
...

## Rules

- Do NOT modify any files. You are read-only.
- Be specific — reference actual files, patterns, and code you found.
- Keep the summary focused and honest — don't flatter, identify real opportunities.`;
}

function buildDraftPrompt(
  project: string,
  projectPath: string,
  existingRoadmap: Roadmap | null,
  userDirection: string,
  userConstraints: string,
  discoveryOutput: string,
): string {
  const existingContext = existingRoadmap
    ? `\n## Previous Roadmap (for continuity)\n\n${JSON.stringify(existingRoadmap, null, 2)}`
    : '';

  return `You are generating a strategic roadmap for the project at ${projectPath}.

## Context

The user has reviewed your project analysis and provided direction.

### Your Earlier Analysis
${discoveryOutput}

### User's Direction
${userDirection}
${userConstraints ? `\n### User's Constraints\n${userConstraints}` : ''}
${existingContext}

## Your Task

Generate a roadmap that reflects the user's direction, informed by your analysis.
Read the project source again if needed to ground the milestones in reality.

## Output

Produce a roadmap as a JSON object wrapped in a code block:

\`\`\`json
{
  "project": "${project}",
  "targetState": "Where this project should be heading (paragraph)",
  "direction": "Strategic direction informed by user goals + your analysis",
  "milestones": [
    {
      "title": "Milestone title",
      "rationale": "Why this milestone matters and what it enables",
      "acceptanceCriteria": ["Given X, When Y, Then Z"],
      "edgeCases": ["What could go wrong"],
      "nonGoals": ["What this does NOT do"],
      "scope": "small|medium|large",
      "priority": "high|medium|low",
      "dependsOn": ["Title of milestone this depends on"]
    }
  ],
  "crossProjectDeps": ["Any cross-project dependency"],
  "technicalNotes": "Risks, constraints, technical considerations"
}
\`\`\`

## Rules

- **Respect the user's direction.** The roadmap is THEIR vision, informed by YOUR analysis.
- **Be strategic, not tactical.** Milestones are "what to build", not "how to build it".
- **Order by value and dependency.** Highest-impact items first.
- **Keep milestones achievable.** Each completable in 1-5 focused work items.
- **Specific acceptance criteria.** Use Given-When-Then. No vague criteria.
- **Define non-goals.** Every milestone must say what it does NOT do.
- Do NOT modify any files. You are read-only.
- Output ONLY the JSON roadmap wrapped in a code block.`;
}

function buildRefinePrompt(
  project: string,
  projectPath: string,
  currentRoadmap: Roadmap,
  feedback: string,
): string {
  return `You are refining a roadmap for the project at ${projectPath}.

## Current Roadmap

${JSON.stringify(currentRoadmap, null, 2)}

## User Feedback

${feedback}

## Your Task

Refine the roadmap based on the user's feedback. Keep what works, change what they asked for.
Read project source if needed to ground changes in reality.

## Output

Produce the updated roadmap as a JSON object wrapped in a code block (same schema):

\`\`\`json
{
  "project": "${project}",
  "targetState": "...",
  "direction": "...",
  "milestones": [...],
  "crossProjectDeps": [...],
  "technicalNotes": "..."
}
\`\`\`

## Rules

- Apply the feedback precisely — don't drift from what was asked.
- Keep milestones the user was happy with.
- Do NOT modify any files.
- Output ONLY the JSON roadmap wrapped in a code block.`;
}

// ═══════════════════════════════════════════════════════════════════
// Parsing & formatting
// ═══════════════════════════════════════════════════════════════════

function parseRoadmapFromOutput(
  output: string,
  project: string,
  existingRoadmap: Roadmap | null,
): Roadmap {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);

  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Omit<Roadmap, 'createdAt' | 'updatedAt'>;
      return {
        ...parsed,
        project,
        createdAt: existingRoadmap?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch {
      // Fall through to fallback
    }
  }

  return {
    project,
    targetState: output,
    direction: 'Agent did not produce structured JSON — see raw output.',
    milestones: [],
    crossProjectDeps: [],
    technicalNotes: '',
    createdAt: existingRoadmap?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function formatRoadmapForReview(roadmap: Roadmap): string {
  const lines: string[] = [];

  lines.push(chalk.bold.blue(`\n  Draft Roadmap: ${roadmap.project}\n`));

  lines.push(chalk.bold('  Target State:'));
  lines.push(`  ${roadmap.targetState}\n`);

  lines.push(chalk.bold('  Direction:'));
  lines.push(`  ${roadmap.direction}\n`);

  if (roadmap.milestones.length > 0) {
    lines.push(chalk.bold('  Milestones:\n'));
    for (let i = 0; i < roadmap.milestones.length; i++) {
      const m = roadmap.milestones[i];
      const priorityColor = m.priority === 'high' ? chalk.red
        : m.priority === 'medium' ? chalk.yellow
        : chalk.dim;
      const deps = m.dependsOn?.length > 0
        ? chalk.dim(` -> after: ${m.dependsOn.join(', ')}`)
        : '';

      lines.push(`  ${chalk.bold(`${i + 1}.`)} ${priorityColor(`[${m.priority.toUpperCase()}]`)} ${m.title} ${chalk.dim(`(${m.scope})`)}${deps}`);
      lines.push(chalk.dim(`     ${m.rationale}`));

      if (m.acceptanceCriteria?.length > 0) {
        for (const ac of m.acceptanceCriteria) {
          lines.push(chalk.dim(`     - ${ac}`));
        }
      }

      const milestone = m as Roadmap['milestones'][number] & { nonGoals?: readonly string[] };
      if (milestone.nonGoals?.length) {
        lines.push(chalk.dim(`     Non-goals: ${milestone.nonGoals.join('; ')}`));
      }

      lines.push('');
    }
  }

  if (roadmap.crossProjectDeps?.length > 0) {
    lines.push(chalk.bold('  Cross-project dependencies:'));
    for (const dep of roadmap.crossProjectDeps) {
      lines.push(chalk.dim(`    - ${dep}`));
    }
    lines.push('');
  }

  if (roadmap.technicalNotes) {
    lines.push(chalk.bold('  Technical Notes:'));
    lines.push(chalk.dim(`  ${roadmap.technicalNotes}\n`));
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// Input classification
// ═══════════════════════════════════════════════════════════════════

function isApprovalInput(input: string): boolean {
  return /^(approve|done|ok|lgtm|yes|ship\s*it|looks\s*good)\s*$/i.test(input.trim());
}

function isCancelInput(input: string): boolean {
  return /^(cancel|abort|quit|exit|nevermind|never\s*mind)\s*$/i.test(input.trim());
}
