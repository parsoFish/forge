/**
 * Workflow type definitions.
 *
 * Orchestrator operates in three mutually exclusive phases:
 *   roadmapping → planning → implementation
 *
 * The per-work-item pipeline flows:
 *   test → develop → pr → review
 *
 * Design + plan stages are now embedded in the roadmapping/planning phases.
 */

import type { AgentRole } from '../agents/types.js';

// === Orchestrator Phases ===

/**
 * Top-level orchestrator phase — mutually exclusive modes.
 *
 * - roadmapping: high-level roadmap generation with human direction
 * - planning: break roadmaps into dependency-ordered work items
 * - implementation: execute work items respecting dependency order
 */
export type OrchestratorPhase = 'roadmapping' | 'planning' | 'implementation';

export const PHASE_ORDER: readonly OrchestratorPhase[] = [
  'roadmapping',
  'planning',
  'implementation',
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
