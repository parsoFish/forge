/**
 * Review stage — waits for human review.
 *
 * This is a terminal state in the automated pipeline.
 * The orchestrator marks work items as awaiting review and moves on.
 * A separate check can poll for PR merge status.
 */

import type { StateStore } from '../../state/store.js';
import type { WorkItem, StageOutput } from '../types.js';

export function markForReview(
  workItem: WorkItem,
  store: StateStore,
): StageOutput {
  workItem.status = 'completed';
  workItem.needsHumanReview = true;

  const output: StageOutput = {
    agent: 'reviewer',
    summary: `Work item "${workItem.title}" is ready for human review. PR has been created.`,
    filesChanged: [],
    completedAt: new Date().toISOString(),
    durationMs: 0,
  };

  workItem.stageOutputs.review = output;
  store.saveWorkItem(workItem);

  return output;
}
