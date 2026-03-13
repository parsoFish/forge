/**
 * Workflow type definitions.
 *
 * Forge operates a six-phase lifecycle (see ADR-002):
 *   roadmapping → implementation → review → merging → reflect
 *
 * The per-work-item pipeline flows:
 *   test → develop → pr → review
 *
 * Design + plan stages are embedded in the implementation phase.
 */

import type { AgentRole } from '../agents/types.js';

// === Orchestrator Phases ===

/**
 * Top-level orchestrator phase — lifecycle stages.
 *
 * - roadmapping: interactive — user sets direction per project (Opus)
 * - implementation: autonomous — design/plan/test/develop/pr pipeline (Sonnet)
 * - review: interactive — triage and approve PRs (Haiku + Sonnet)
 * - merging: autonomous — fix feedback, CI gates, merge (Sonnet)
 * - reflect: interactive — analyze outcomes, extract learnings (Opus)
 */
export type OrchestratorPhase = 'roadmapping' | 'implementation' | 'review' | 'merging' | 'reflect';

export const PHASE_ORDER: readonly OrchestratorPhase[] = [
  'roadmapping',
  'implementation',
  'review',
  'merging',
  'reflect',
] as const;

/** Persisted state of the current orchestrator phase */
export interface PhaseState {
  /** Current active phase */
  readonly currentPhase: OrchestratorPhase;
  /** When this phase was entered */
  readonly enteredAt: string;
  /** Phase-level notes (e.g. user direction from roadmapping) */
  readonly notes: string;
}

// === Workflow Stages (per work item) ===

export type WorkflowStage = 'design' | 'plan' | 'test' | 'develop' | 'pr' | 'review';

export const STAGE_ORDER: readonly WorkflowStage[] = [
  'design',
  'plan',
  'test',
  'develop',
  'pr',
  'review',
] as const;

/** Maps each workflow stage to its responsible agent role */
export const STAGE_AGENT_MAP: Record<WorkflowStage, AgentRole> = {
  design: 'architect',
  plan: 'planner',
  test: 'test-engineer',
  develop: 'developer',
  pr: 'pr-creator',
  review: 'reviewer',
};

// === Roadmap ===

/**
 * A project roadmap — produced during the roadmapping phase.
 *
 * Higher-level than a DesignBrief: considers cross-project dependencies,
 * user-provided direction, and target state. Feeds into the planning phase.
 */
export interface Roadmap {
  /** Project name */
  readonly project: string;

  /** User-set target state / vision for this project */
  readonly targetState: string;

  /** Overall direction informed by core values + user direction */
  readonly direction: string;

  /** Ordered milestones with dependencies */
  readonly milestones: readonly RoadmapMilestone[];

  /** Cross-project dependencies (e.g. "needs simplarr auth before GitWeave sync") */
  readonly crossProjectDeps: readonly string[];

  /** Technical risks and considerations */
  readonly technicalNotes: string;

  /** When this roadmap was generated */
  readonly createdAt: string;

  /** When last updated */
  updatedAt: string;
}

export interface RoadmapMilestone {
  /** Milestone title */
  readonly title: string;

  /** Why this milestone matters */
  readonly rationale: string;

  /** Acceptance criteria for the milestone */
  readonly acceptanceCriteria: readonly string[];

  /** Rough scope */
  readonly scope: 'small' | 'medium' | 'large';

  /** Priority ranking */
  readonly priority: 'high' | 'medium' | 'low';

  /** Titles of milestones this depends on (within the same project) */
  readonly dependsOn: readonly string[];
}

// === Close-Out Metadata ===

/**
 * Metadata for close-out work items created during the review phase.
 *
 * Close-out items skip test/plan stages — they enter at `develop` stage
 * with the existing PR branch. The worker handles them differently based
 * on the `action` field.
 */
export interface CloseOutMeta {
  /** PR number being closed out. */
  readonly prNumber: number;
  /** Repository in owner/repo format. */
  readonly repo: string;
  /** What to do: merge directly or fix first. */
  readonly action: 'fix-and-merge' | 'merge-only';
  /** User feedback from the interactive review session. */
  readonly userFeedback?: string;
  /** Number of issues found in the initial automated review. */
  readonly initialIssueCount: number;
  /** Merge layer — 0=foundation, higher=must wait for lower layers. Guides merge train ordering. */
  readonly mergeLayer: number;
  /** PR numbers this depends on — must merge before this one. */
  readonly dependsOnPRs: readonly number[];
  /** PR numbers this blocks — merge after this one. */
  readonly blocksPRs: readonly number[];
  /** Branch name for this PR. */
  readonly branch: string;
}

// === Work Items ===

export interface WorkItem {
  /** Unique identifier (human-readable: <project>/<seq>-<slug>) */
  readonly id: string;

  /** Project this work item belongs to */
  readonly project: string;

  /** Sequence number within the project (for ordering/display) */
  readonly seq: number;

  /** Short title */
  readonly title: string;

  /** Detailed description of the work */
  readonly description: string;

  /** Current stage in the pipeline */
  stage: WorkflowStage;

  /** Status within the current stage */
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked';

  /** Branch name for this work item */
  readonly branch: string;

  /**
   * IDs of work items this depends on.
   * Implementation phase will not start this item until all deps are completed.
   */
  readonly dependsOn: readonly string[];

  /** Created timestamp */
  readonly createdAt: string;

  /** Last updated timestamp */
  updatedAt: string;

  /** Stage-specific outputs (accumulated as work progresses) */
  stageOutputs: Partial<Record<WorkflowStage, StageOutput>>;

  /** Whether this item requires human attention */
  needsHumanReview: boolean;

  /** Reason for blocking/escalation */
  blockReason?: string;

  /** Close-out metadata — present when this item was created by the review phase. */
  readonly closeOut?: CloseOutMeta;
}

export interface StageOutput {
  /** The agent that produced this output */
  readonly agent: AgentRole;

  /** Summary of what was done */
  readonly summary: string;

  /** Files created or modified */
  readonly filesChanged: readonly string[];

  /** Timestamp of completion */
  readonly completedAt: string;

  /** Duration in milliseconds */
  readonly durationMs: number;
}

export interface DesignBrief {
  /** Project name */
  readonly project: string;

  /** High-level direction and goals */
  readonly direction: string;

  /** Proposed features with rationale */
  readonly features: readonly FeatureProposal[];

  /** Technical considerations */
  readonly technicalNotes: string;
}

export interface FeatureProposal {
  /** Feature title */
  readonly title: string;

  /** Why this feature matters */
  readonly rationale: string;

  /** Rough scope estimate */
  readonly scope: 'small' | 'medium' | 'large';

  /** Priority */
  readonly priority: 'high' | 'medium' | 'low';
}
