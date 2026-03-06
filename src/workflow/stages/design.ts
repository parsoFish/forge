/**
 * Design stage — the Architect agent analyzes a project and produces a design brief.
 *
 * This is the first stage of the pipeline. The architect examines the codebase,
 * identifies areas for improvement, proposes features, and sets direction.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { DesignBrief, StageOutput } from '../types.js';

export async function runDesignStage(
  agent: AgentDefinition,
  project: string,
  projectPath: string,
  store: StateStore,
): Promise<{ brief: DesignBrief; output: StageOutput }> {
  const prompt = `You are analyzing the project at ${projectPath}.

Your task:
1. Read the project's README, package.json/pyproject.toml, and key source files to understand what it does.
2. Analyze the current state: architecture, code quality, test coverage, documentation.
3. Identify areas for improvement and potential new features.
4. Produce a design brief as a JSON object with this structure:

\`\`\`json
{
  "project": "${project}",
  "direction": "A paragraph describing the overall direction for this project",
  "features": [
    {
      "title": "Feature name",
      "rationale": "Why this feature matters",
      "scope": "small|medium|large",
      "priority": "high|medium|low"
    }
  ],
  "technicalNotes": "Technical considerations, risks, dependencies"
}
\`\`\`

Focus on practical, high-impact improvements. Be opinionated but justified.
Output ONLY the JSON design brief wrapped in a code block.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 15,
  });

  // Parse the design brief from the output
  const jsonMatch = result.output.match(/```json\s*([\s\S]*?)```/);
  let brief: DesignBrief;

  if (jsonMatch?.[1]) {
    try {
      brief = JSON.parse(jsonMatch[1]) as DesignBrief;
    } catch {
      // Fallback: create a minimal brief
      brief = {
        project,
        direction: result.output,
        features: [],
        technicalNotes: 'Failed to parse structured brief — see raw output.',
      };
    }
  } else {
    brief = {
      project,
      direction: result.output,
      features: [],
      technicalNotes: 'Agent did not produce structured JSON — see raw output.',
    };
  }

  store.saveDesignBrief(brief);

  const output: StageOutput = {
    agent: 'architect',
    summary: `Design brief for ${project}: ${brief.features.length} features proposed`,
    filesChanged: result.filesChanged,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  };

  return { brief, output };
}
