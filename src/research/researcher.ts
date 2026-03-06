/**
 * Research agent — periodically investigates the state of the art in agent orchestration.
 *
 * Runs independently of project work. Produces markdown reports with findings
 * and recommendations for improving the orchestrator itself.
 */

import type { AgentDefinition } from '../agents/types.js';
import { runAgent } from '../agents/runner.js';
import type { StateStore } from '../state/store.js';

const RESEARCH_TOPICS = [
  'Claude Code SDK updates and new features for multi-agent orchestration',
  'New MCP server patterns and tools relevant to autonomous coding agents',
  'Improvements in agentic coding workflows — loop patterns, backpressure gates, memory',
  'New testing frameworks or approaches for AI-generated code validation',
  'Community patterns from OpenClaw, Ralph Orchestrator, and similar tools',
];

export async function runResearchAgent(
  agent: AgentDefinition,
  store: StateStore,
  workspaceRoot: string,
): Promise<void> {
  const topic = RESEARCH_TOPICS[Math.floor(Math.random() * RESEARCH_TOPICS.length)];

  const prompt = `You are a research agent investigating the current state of the art.

## Research Topic

${topic}

## Your Task

1. Search for recent developments, blog posts, GitHub repos, and discussions.
2. Focus on practical, actionable findings — things we could adopt.
3. Produce a concise markdown report with:
   - **Summary**: 2-3 sentence overview
   - **Key Findings**: Bullet list of specific discoveries
   - **Recommendations**: What we should consider adopting and why
   - **Sources**: Links or references where possible

Keep the report focused and actionable. We care about practical improvements
to our orchestration setup, not theoretical musings.

Output the full markdown report.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: workspaceRoot,
    maxTurns: 15,
  });

  if (result.success) {
    store.saveResearch(topic.slice(0, 50), result.output);
  }
}
