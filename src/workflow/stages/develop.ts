/**
 * Develop stage — the Developer agent implements the work item.
 *
 * The developer works on the existing branch (created by test-engineer),
 * implements the feature/fix, and ensures all tests pass.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { WorkItem, StageOutput } from '../types.js';

export async function runDevelopStage(
  agent: AgentDefinition,
  workItem: WorkItem,
  projectPath: string,
  store: StateStore,
): Promise<StageOutput> {
  const testOutput = workItem.stageOutputs.test;
  const testContext = testOutput
    ? `\n## Test Context\nTests were created by the test engineer:\n${testOutput.summary}\nFiles: ${testOutput.filesChanged.join(', ')}`
    : '';

  const prompt = `You are implementing a work item. Tests have already been written (TDD).

## Work Item: ${workItem.title}

${workItem.description}
${testContext}

## Your Task

1. Checkout the branch: \`git checkout ${workItem.branch}\`
2. Read the existing tests to understand the expected behavior.
3. Implement the feature/fix to make all tests pass.
4. Run the test suite and verify ALL tests pass (including pre-existing tests).
5. Run linters/formatters — zero warnings allowed.
6. If you see nearby code that could be improved (broken windows), clean it up.
7. Commit with message: \`feat: ${workItem.title}\` (or \`fix:\` / \`refactor:\` as appropriate)

## Quality Gates (ALL must pass)

- [ ] All tests pass (new and existing)
- [ ] Zero lint warnings
- [ ] Zero type errors
- [ ] Code follows ecosystem conventions
- [ ] No unintended side effects on existing functionality

## If You Get Stuck

If the work item seems ambiguous or requires architectural decisions beyond your scope:
- Output \`ESCALATE: <reason>\` and stop.

## Important

- Do NOT skip running tests. Actually execute the test command.
- Do NOT suppress or delete failing tests.
- If a pre-existing test breaks due to your changes, fix your implementation, not the test.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: projectPath,
    maxTurns: 30, // Development may need more turns
  });

  const output: StageOutput = {
    agent: 'developer',
    summary: result.output.slice(0, 500),
    filesChanged: result.filesChanged,
    completedAt: new Date().toISOString(),
    durationMs: result.durationMs,
  };

  if (result.escalate) {
    workItem.status = 'blocked';
    workItem.needsHumanReview = true;
    workItem.blockReason = result.escalateReason;
  } else if (result.success) {
    workItem.stageOutputs.develop = output;
    workItem.stage = 'pr';
    workItem.status = 'pending';
  } else {
    workItem.status = 'failed';
    workItem.blockReason = 'Development failed — see agent output';
  }

  store.saveWorkItem(workItem);
  return output;
}
