/**
 * Roadmap stage — generates project roadmaps from design analysis + core values.
 *
 * This runs in the "roadmapping" phase. The architect analyzes each project
 * holistically, considering existing specs, docs, and the orchestrator's core
 * values to produce a roadmap with ordered milestones and dependencies.
 *
 * WHY a separate roadmapping phase?
 * Design briefs were too tactical — they jumped straight to features without
 * considering cross-project dependencies, user-defined direction, or milestone
 * ordering. Roadmaps sit between "vision" and "work items": they define WHAT
 * to build and in WHAT ORDER, but leave the HOW to planning + implementation.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { Roadmap, StageOutput } from '../types.js';

export async function runRoadmapStage(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
  userDirection?: string,
): Promise<{ roadmap: Roadmap; output: StageOutput }> {
  // Load existing roadmap and design brief for continuity
  const existingRoadmap = store.getRoadmap(project);
  const existingBrief = store.getDesignBrief(project);
  const latestLearning = store.getLatestLearning();

  const existingContext = existingRoadmap
    ? `\n## Existing Roadmap\n\n${JSON.stringify(existingRoadmap, null, 2)}\n\nReview and update this roadmap. Keep milestones that are still relevant, remove completed or obsolete ones, and add new ones as needed.`
    : existingBrief
    ? `\n## Previous Design Brief\n\n${JSON.stringify(existingBrief, null, 2)}\n\nThis was a previous analysis. Build on it.`
    : '';

  const userContext = userDirection
    ? `\n## User Direction\n\nThe project owner has provided this direction:\n${userDirection}\n\nFactor this into the roadmap priorities.`
    : '';

  const learningContext = latestLearning
    ? `\n## Recent Learnings\n\n${latestLearning.slice(0, 2000)}\n\nConsider these learnings when prioritizing work.`
    : '';

  const prompt = `You are generating a strategic roadmap for the project at ${projectPath}.

## Your Task

1. **Analyze the project deeply.** Read README, config files, source code, tests, docs, specs — understand the full state.
2. **Identify the target state.** Where should this project be heading? What's the next major milestone?
3. **Define ordered milestones.** Each milestone should be a meaningful step toward the target state.
4. **Map dependencies.** Which milestones depend on others? What's the critical path?
5. **Consider cross-project implications.** Note any dependencies on or impacts to other projects.
${existingContext}${userContext}${learningContext}

## Output

Produce a roadmap as a JSON object:

\`\`\`json
{
  "project": "${project}",
  "targetState": "A paragraph describing where this project should be heading",
  "direction": "Strategic direction informed by current state analysis and user goals",
  "milestones": [
    {
      "title": "Milestone title",
      "rationale": "Why this milestone matters and what it enables",
      "acceptanceCriteria": ["Given X, When Y, Then Z", "Criterion 2"],
      "edgeCases": ["What happens on failure or bad input"],
      "nonGoals": ["What this milestone explicitly does NOT do"],
      "scope": "small|medium|large",
      "priority": "high|medium|low",
      "dependsOn": ["Title of milestone this depends on"]
    }
  ],
  "crossProjectDeps": ["Description of any cross-project dependency"],
  "technicalNotes": "Risks, constraints, and technical considerations"
}
\`\`\`

## Rules

- **Be strategic, not tactical.** Milestones are "what to build", not "how to build it".
- **Order by value and dependency.** Highest-impact items that unblock others come first.
- **Keep milestones achievable.** Each should be completable in 1–5 focused work items.
- **Be specific about acceptance criteria.** Use Given-When-Then format. Vague criteria like "improve quality" are never acceptable.
- **Define non-goals.** Every milestone must say what it does NOT do to prevent scope creep.
- **Identify edge cases.** What could go wrong? Boundary conditions? Failure modes?
- Do NOT modify any files. You are read-only in this stage.
- Output ONLY the JSON roadmap wrapped in a code block.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 20,
  });

  // Parse the roadmap from the output
  const jsonMatch = result.output.match(/```json\s*([\s\S]*?)```/);
  let roadmap: Roadmap;

  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Omit<Roadmap, 'createdAt' | 'updatedAt'>;
      roadmap = {
        ...parsed,
        project,
        createdAt: existingRoadmap?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch {
      roadmap = {
        project,
        targetState: result.output,
        direction: 'Failed to parse structured roadmap — see raw output.',
        milestones: [],
        crossProjectDeps: [],
        technicalNotes: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  } else {
    roadmap = {
      project,
      targetState: result.output,
      direction: 'Agent did not produce structured JSON — see raw output.',
      milestones: [],
      crossProjectDeps: [],
      technicalNotes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  store.saveRoadmap(roadmap);

  // Also save as a design brief for backward compatibility with existing stages
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

  const output: StageOutput = {
    agent: 'architect',
    summary: `Roadmap for ${project}: ${roadmap.milestones.length} milestones`,
    filesChanged: result.filesChanged,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  };

  return { roadmap, output };
}
