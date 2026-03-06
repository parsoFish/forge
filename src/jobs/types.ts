/**
 * Job queue types.
 *
 * WHY a job queue:
 * The orchestrator's role is to POST work, not EXECUTE it. CLI commands
 * like `forge roadmap` should return instantly after writing job files.
 * A separate worker process picks up and executes jobs within concurrency,
 * budget, and resource constraints.
 *
 * This decoupling means:
 * - Orchestrator commands never block
 * - Parallelism settings only affect the worker, not the orchestrator
 * - If WSL crashes, queued jobs persist on disk and resume
 * - The worker can be run in tmux/screen independently
 */

import type { OrchestratorPhase } from '../workflow/types.js';

/** Phase for job context — extends OrchestratorPhase with 'reflection' */
export type JobPhase = OrchestratorPhase | 'reflection' | 'review' | 'pr-fix';

/** The types of jobs the orchestrator can post */
export type JobType =
  | 'roadmap'
  | 'plan'
  | 'implement'
  | 'reflect'
  | 'design'        // legacy: full design stage
  | 'work-item'    // legacy: execute a single work item pipeline
  | 'review'       // GitHub PR review — highest priority, runs before implementation
  | 'pr-fix';      // Fix a PR branch in response to reviewer changes-requested

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A persisted job — written to `.forge/jobs/<id>.json`.
 *
 * The orchestrator creates these; the worker consumes them.
 */
export interface Job {
  /** Unique identifier (timestamp + random suffix for ordering) */
  readonly id: string;

  /** What the job does */
  readonly type: JobType;

  /** Which orchestrator phase this job belongs to */
  readonly phase: JobPhase;

  /** Target project (null for cross-project jobs like reflect) */
  readonly project: string | null;

  /** Current status */
  status: JobStatus;

  /** Priority — lower numbers run first. Same priority → FIFO by createdAt. */
  readonly priority: number;

  /** When the job was created */
  readonly createdAt: string;

  /** When the worker picked it up */
  startedAt?: string;

  /** When the job finished (success or failure) */
  completedAt?: string;

  /** Error message if failed */
  error?: string;

  /** Arbitrary metadata for the job executor */
  readonly metadata: Record<string, unknown>;
}

/** Default priorities by job type — lower runs first */
export const JOB_PRIORITY: Record<JobType, number> = {
  review: 5,       // Initial review — runs before everything
  'pr-fix': 12,    // Fix PR branch in response to review — stays in the 5-15 bounce band
  roadmap: 20,     // Bumped up to 20 to keep the full bounce cycle (5-15) above roadmap
  plan: 30,
  implement: 40,
  design: 25,
  'work-item': 45,
  reflect: 60,
};
