/**
 * Plan stage — the Planner agent breaks a roadmap/design brief into concrete work items.
 *
 * Takes the architect's roadmap (or design brief) and produces actionable,
 * dependency-ordered work items that the implementation phase can execute.
 *
 * WHY dependency tracking matters:
 * Without explicit dependencies, the implementation phase runs work items in
 * parallel on separate branches — leading to merge conflicts when PRs are
 * created. By tracking which items depend on others, we can sequence work
 * to minimize conflicts and ensure foundational changes land first.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import chalk from 'chalk';
import type { StateStore } from '../../state/store.js';
import type { DesignBrief, Roadmap, WorkItem, StageOutput } from '../types.js';

/**
 * Try multiple strategies to extract a JSON array from agent output.
 * Agents are inconsistent about code-fence formatting — handle all variants.
 */
function extractJsonArray(output: string): string | null {
  // Strategy 1: ```json ... ```  (standard)
  const fencedJson = output.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]?.trim()) return fencedJson[1].trim();

  // Strategy 2: ``` ... ```  (no language tag)
  const fencedPlain = output.match(/```\s*\n(\s*\[[\s\S]*?\])\s*\n```/);
  if (fencedPlain?.[1]?.trim()) return fencedPlain[1].trim();

  // Strategy 3: Raw JSON array at top level (agent returned bare JSON)
  const rawArray = output.match(/(\[\s*\{[\s\S]*\}\s*\])/);
  if (rawArray?.[1]?.trim()) {
    // Validate it's plausible JSON
    try {
      JSON.parse(rawArray[1]);
      return rawArray[1].trim();
    } catch {
      // Not valid — fall through
    }
  }

  // Strategy 4: JSON array split across the last text block
  // Some agents put commentary before/after the array
  const lastBracket = output.lastIndexOf(']');
  if (lastBracket > 0) {
    // Walk backwards to find matching opening bracket
    let depth = 0;
    for (let i = lastBracket; i >= 0; i--) {
      if (output[i] === ']') depth++;
      if (output[i] === '[') depth--;
      if (depth === 0) {
        const candidate = output.slice(i, lastBracket + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (Array.isArray(parsed) && parsed.length > 0) return candidate;
        } catch {
          // Not valid — fall through
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Recover complete objects from a truncated JSON array.
 *
 * WHY: Claude agents sometimes produce output longer than the response limit,
 * truncating mid-JSON. We salvage as many complete objects as possible by
 * finding the last `},` or `}` that closes a complete array element, then
 * building a valid `[...items]`.
 */
interface PlannedItem {
  title: string;
  description: string;
  branch: string;
  testingApproach?: string;
  dependsOn?: string[];
}

function recoverTruncatedArray(json: string): PlannedItem[] | null {
  // Ensure it starts as an array
  const trimmed = json.trim();
  if (!trimmed.startsWith('[')) return null;

  // Try progressively shorter slices ending at `}` + optional comma/whitespace
  for (let end = trimmed.length; end > 1; end--) {
    if (trimmed[end - 1] === '}' || trimmed[end - 1] === ',') {
      // Slice up to this point and try to close the array
      let candidate = trimmed.slice(0, end).replace(/,\s*$/, '');
      candidate += ']';
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Keep walking backwards
      }
    }
  }

  return null;
}

/** Build WorkItem objects from parsed planner output and persist them. */
function buildWorkItems(
  parsed: PlannedItem[],
  project: string,
  store: StateStore,
  out: WorkItem[],
): void {
  const titleToId = new Map<string, string>();
  let nextSeq = store.nextSeq(project);

  // First pass: assign IDs
  const itemsWithIds = parsed.map((item) => {
    const seq = nextSeq++;
    const slug = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const id = `${project}/${String(seq).padStart(3, '0')}-${slug}`;
    titleToId.set(item.title, id);
    return { ...item, id, seq };
  });

  // Second pass: resolve dependency titles to IDs
  for (const item of itemsWithIds) {
    const resolvedDeps = (item.dependsOn ?? [])
      .map((depTitle) => titleToId.get(depTitle))
      .filter((id): id is string => id !== undefined);

    const workItem: WorkItem = {
      id: item.id,
      project,
      seq: item.seq,
      title: item.title,
      description: item.description + (item.testingApproach ? `\n\nTesting: ${item.testingApproach}` : ''),
      stage: 'test',
      status: 'pending',
      branch: item.branch,
      dependsOn: resolvedDeps,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stageOutputs: {},
      needsHumanReview: false,
    };

    workItem.stageOutputs.plan = {
      agent: 'planner',
      summary: item.title,
      filesChanged: [],
      completedAt: new Date().toISOString(),
      durationMs: 0,
    };

    store.saveWorkItem(workItem);
    out.push(workItem);
  }
}

export async function runPlanStage(
  agent: AgentDefinition,
  briefOrRoadmap: DesignBrief | Roadmap,
  projectPath: string,
  store: StateStore,
): Promise<{ workItems: WorkItem[]; output: StageOutput }> {
  const project = briefOrRoadmap.project;
  const isRoadmap = 'milestones' in briefOrRoadmap;
  const roadmap = isRoadmap ? (briefOrRoadmap as Roadmap) : null;
  const brief = isRoadmap ? null : (briefOrRoadmap as DesignBrief);
  const startTime = Date.now();

  const allWorkItems: WorkItem[] = [];

  if (roadmap && roadmap.milestones.length > 0) {
    // ── Per-milestone planning ─────────────────────────────────────
    // WHY: Generating all work items in one shot produces a huge JSON
    // blob that easily truncates or malforms. By planning one milestone
    // at a time we get small, reliable outputs with natural checkpointing.
    // If one milestone fails, the rest are unaffected.

    for (const milestone of roadmap.milestones) {
      const items = await planSingleMilestone(
        agent, project, projectPath, store, roadmap, milestone, allWorkItems,
      );
      allWorkItems.push(...items);
      console.log(chalk.dim(`    ${milestone.title}: ${items.length} items`));
    }
  } else if (brief) {
    // Design brief fallback — still one call since briefs are simpler
    const items = await planFromBrief(agent, project, projectPath, store, brief);
    allWorkItems.push(...items);
  }

  const stageOutput: StageOutput = {
    agent: 'planner',
    summary: `Planned ${allWorkItems.length} work items for ${project} (${roadmap ? roadmap.milestones.length + ' milestones' : 'brief'})`,
    filesChanged: [],
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  };

  return { workItems: allWorkItems, output: stageOutput };
}

// ═══════════════════════════════════════════════════════════════════
// Per-milestone planning
// ═══════════════════════════════════════════════════════════════════

/**
 * Plan work items for a single roadmap milestone.
 *
 * WHY one-at-a-time: keeps the output small (3-8 items), avoids truncation,
 * and checkpoints progress after each milestone. If output is still truncated,
 * the recovery code can salvage partial items without losing unrelated milestones.
 */
async function planSingleMilestone(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
  roadmap: Roadmap,
  milestone: import('../types.js').RoadmapMilestone,
  previousItems: WorkItem[],
): Promise<WorkItem[]> {
  // Provide context about items already planned (for cross-milestone deps)
  const existingItems = [
    ...store.getWorkItemsByProject(project),
    ...previousItems,
  ];
  const existingContext = existingItems.length > 0
    ? `\n## Already Planned Items (reference for dependencies, do NOT duplicate)\n\n${existingItems.map((i) =>
        `- "${i.title}" [${i.status}]`
      ).join('\n')}`
    : '';

  // Give brief context about the other milestones for ordering awareness
  const otherMilestones = roadmap.milestones
    .filter((m) => m.title !== milestone.title)
    .map((m) => `- ${m.title} (${m.priority})`)
    .join('\n');

  const prompt = `You are planning work items for ONE milestone of "${project}".

## This Milestone

**${milestone.title}** (${milestone.scope} scope, ${milestone.priority} priority)

${milestone.rationale}

**Acceptance Criteria:**
${milestone.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}

**Depends on milestones:** ${milestone.dependsOn.length > 0 ? milestone.dependsOn.join(', ') : 'none'}

## Project Direction

${roadmap.direction}

**Technical Notes:** ${roadmap.technicalNotes}

## Other Milestones (for context only)

${otherMilestones}
${existingContext}

## Your Task

Break THIS milestone into concrete, atomic work items. Each should:
- Be completable in a single focused session
- Have clear acceptance criteria in the description
- Include testing approach (unit, integration, e2e)
- Specify branch name (format: feat/${project}-short-desc or fix/${project}-short-desc)
- Declare dependencies on other items by title (from this list OR the "Already Planned" list above)

Keep descriptions concise — 2-4 sentences max. Focus on WHAT and WHY, not implementation details.

Output ONLY a JSON array:

\`\`\`json
[
  {
    "title": "Short title",
    "description": "What to do and acceptance criteria",
    "branch": "feat/${project}-short-desc",
    "testingApproach": "unit tests for X",
    "dependsOn": []
  }
]
\`\`\``;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 6,
  });

  return parseWorkItems(result.output, project, store);
}

// ═══════════════════════════════════════════════════════════════════
// Brief-based planning (fallback for non-roadmap projects)
// ═══════════════════════════════════════════════════════════════════

async function planFromBrief(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
  brief: DesignBrief,
): Promise<WorkItem[]> {
  const existingItems = store.getWorkItemsByProject(project);
  const existingContext = existingItems.length > 0
    ? `\n## Existing Work Items (do NOT duplicate)\n\n${existingItems.map((i) =>
        `- [${i.status}] ${i.title}`
      ).join('\n')}`
    : '';

  const prompt = `You are planning work items for "${project}".

## Direction

${brief.direction}

## Features

${brief.features.map((f) =>
    `- **${f.title}** (${f.scope}, ${f.priority}): ${f.rationale}`
  ).join('\n')}

**Technical Notes:** ${brief.technicalNotes}
${existingContext}

## Your Task

Break each feature into concrete, atomic work items. Each should:
- Be completable in a single focused session
- Have clear acceptance criteria
- Include testing approach
- Specify branch name (format: feat/${project}-short-desc)
- Declare dependencies by title

Keep descriptions concise — 2-4 sentences max.

Output ONLY a JSON array:

\`\`\`json
[
  {
    "title": "Short title",
    "description": "What to do and acceptance criteria",
    "branch": "feat/${project}-short-desc",
    "testingApproach": "unit tests for X",
    "dependsOn": []
  }
]
\`\`\``;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 8,
  });

  return parseWorkItems(result.output, project, store);
}

// ═══════════════════════════════════════════════════════════════════
// JSON parsing with recovery
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse planner output into WorkItem objects, with truncation recovery.
 */
function parseWorkItems(
  output: string,
  project: string,
  store: StateStore,
): WorkItem[] {
  const rawJson = extractJsonArray(output);
  const workItems: WorkItem[] = [];

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as PlannedItem[];
      buildWorkItems(parsed, project, store, workItems);
    } catch (e) {
      const recovered = recoverTruncatedArray(rawJson);
      if (recovered) {
        console.warn(`Recovered ${recovered.length} items from truncated JSON (${e instanceof Error ? e.message : e})`);
        buildWorkItems(recovered, project, store, workItems);
      } else {
        console.error(`Failed to parse work items JSON: ${e instanceof Error ? e.message : e}`);
        console.error(`Extracted JSON (first 500 chars): ${rawJson.slice(0, 500)}`);
      }
    }
  } else {
    console.error('Could not find JSON array in planner output');
    console.error(`Output length: ${output.length}`);
    console.error(`Output start: ${output.slice(0, 1000)}`);
  }

  return workItems;
}
