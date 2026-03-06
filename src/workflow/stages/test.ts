/**
 * Test stage — the Test Engineer agent creates tests for a work item.
 *
 * Tests are written BEFORE implementation (TDD). The agent designs tests at
 * multiple layers based on the work item's requirements.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { WorkItem, StageOutput } from '../types.js';

export async function runTestStage(
  agent: AgentDefinition,
  workItem: WorkItem,
  projectPath: string,
  store: StateStore,
): Promise<StageOutput> {
  const prompt = `You are writing tests for the following work item BEFORE implementation (TDD).

## Work Item: ${workItem.title}

${workItem.description}

## Your Task

1. Read the existing codebase to understand the project structure, test framework, and conventions.
2. Design tests at appropriate layers:
   - **Unit tests** for isolated logic and pure functions
   - **Integration tests** for component boundaries and contracts
   - **E2E tests** for critical user flows (if applicable)
3. Write the test files following the project's existing test conventions.
4. Tests should FAIL initially (since implementation doesn't exist yet).
5. Tests should validate BEHAVIOR holistically — not just line coverage.

## Guidelines

- Follow the project's existing test framework and patterns
- Test file naming should follow ecosystem conventions
- Tests should be descriptive: test names explain the expected behavior
- Include edge cases and error scenarios
- Don't mock too aggressively — test real behavior at integration boundaries
- If the project has no test setup, create one following ecosystem best practices

## Important

- Create a new git branch: \`${workItem.branch}\`
- Commit the tests with message: \`test: ${workItem.title}\`
- Output a summary of what tests were created and what they verify

First run \`git checkout -b ${workItem.branch}\` to create the feature branch.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 20,
  });

  const output: StageOutput = {
    agent: 'test-engineer',
    summary: result.output.slice(0, 500),
    filesChanged: result.filesChanged,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  };

  // Update work item based on agent result
  if (result.success) {
    workItem.stageOutputs.test = output;
    workItem.stage = 'develop';
    workItem.status = 'pending';
  } else {
    workItem.status = 'failed';
    workItem.blockReason = `Test stage failed: ${result.output.slice(0, 200)}`;
  }
  store.saveWorkItem(workItem);

  return output;
}
