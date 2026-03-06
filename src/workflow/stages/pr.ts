/**
 * PR stage — the PR Creator agent pushes the branch and creates a pull request.
 *
 * Uses GitHub CLI (gh) for PR creation. This is a lightweight, formulaic agent.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { WorkItem, StageOutput } from '../types.js';

export async function runPRStage(
  agent: AgentDefinition,
  workItem: WorkItem,
  projectPath: string,
  store: StateStore,
): Promise<StageOutput> {
  const devOutput = workItem.stageOutputs.develop;
  const testOutput = workItem.stageOutputs.test;

  const prompt = `You are creating a pull request for a completed work item.

## Work Item: ${workItem.title}

${workItem.description}

## What Was Done

**Tests created:** ${testOutput?.summary ?? 'N/A'}
**Implementation:** ${devOutput?.summary ?? 'N/A'}
**Files changed:** ${devOutput?.filesChanged.join(', ') ?? 'N/A'}

## Your Task

1. Checkout the branch: \`git checkout ${workItem.branch}\`
2. Push the branch: \`git push origin ${workItem.branch}\`
3. Create a pull request using \`gh pr create\` with:
   - A clear title following conventional commits
   - A description that explains:
     - **WHY** this change was made (not what the diff shows)
     - The design decision and alternatives considered
     - Testing approach (which layers, what's covered)
     - Any follow-up work needed
4. Add appropriate labels if the repo supports them.

## PR Description Template

Use this structure:

\`\`\`markdown
## Why

[Explain the motivation and context]

## Approach

[Explain the chosen approach and why it was selected]

## Testing

[Describe the testing strategy — unit/integration/e2e coverage]

## Notes

[Any follow-up work, caveats, or things for reviewers to focus on]
\`\`\`

Output the PR URL when done.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 10,
  });

  const output: StageOutput = {
    agent: 'pr-creator',
    summary: result.output.slice(0, 500),
    filesChanged: [],
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  };

  workItem.stageOutputs.pr = output;
  workItem.stage = 'review';
  workItem.status = 'pending';
  workItem.needsHumanReview = true; // PR always needs human review
  store.saveWorkItem(workItem);

  return output;
}
