/**
 * Type definitions for the agent system.
 */

export type AgentRole =
  | 'architect'
  | 'planner'
  | 'test-engineer'
  | 'developer'
  | 'pr-creator'
  | 'reviewer'
  | 'pr-reviewer'
  | 'researcher'
  | 'reflector';

export interface AgentDefinition {
  /** Agent role identifier */
  readonly role: AgentRole;

  /** Human-readable name */
  readonly name: string;

  /** When this agent should be invoked */
  readonly description: string;

  /** Model to use (from settings) */
  readonly model: string;

  /** Allowed Claude Code tools */
  readonly allowedTools: readonly string[];

  /** Full system prompt (loaded from markdown body) */
  readonly systemPrompt: string;
}

export interface AgentResult {
  /** Whether the agent completed successfully */
  readonly success: boolean;

  /** Output text from the agent */
  readonly output: string;

  /** Files created or modified */
  readonly filesChanged: readonly string[];

  /** Duration in milliseconds */
  readonly durationMs: number;

  /** Whether the agent wants to escalate to human */
  readonly escalate: boolean;

  /** Escalation reason (if escalate is true) */
  readonly escalateReason?: string;

  /** If the run failed due to rate limiting, the estimated reset time (ms epoch) */
  readonly rateLimitResetAt?: number;
}

export interface AgentInvocation {
  /** The agent definition to run */
  readonly agent: AgentDefinition;

  /** The prompt/task to give the agent */
  readonly prompt: string;

  /** Working directory for the agent */
  readonly cwd: string;

  /** Maximum iterations/turns */
  readonly maxTurns: number;

  /** Additional context to inject */
  readonly context?: string;

  /** Optional cgroup path for process isolation. Set by the worker. */
  readonly cgroupPath?: string;
}
