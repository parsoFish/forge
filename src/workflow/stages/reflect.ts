/**
 * Reflection stage — a self-reflective agent that analyzes past work.
 *
 * Reviews event logs, work item outcomes, and agent costs to identify:
 * - Recurring failure patterns (e.g. same test always fails)
 * - Cost inefficiencies (agents burning tokens on unproductive work)
 * - Quality patterns (what produces high-quality output)
 * - Process improvements (better prompts, ordering, dependency handling)
 *
 * Output is saved to .forge/learnings/ and incorporated into future
 * roadmapping and planning phases.
 */

import type { AgentDefinition } from '../../agents/types.js';
import { runAgent } from '../../agents/runner.js';
import type { StateStore } from '../../state/store.js';
import type { EventLog } from '../../events/event-log.js';

export async function runReflectionStage(
  agent: AgentDefinition,
  store: StateStore,
  eventLog: EventLog,
  workspaceRoot: string,
): Promise<{ report: string }> {
  // Gather context for the reflection
  const workItems = store.listWorkItems();
  const recentEvents = eventLog.recent(200);
  const latestLearning = store.getLatestLearning();

  // Summarize work item outcomes
  const completedItems = workItems.filter((i) => i.status === 'completed');
  const failedItems = workItems.filter((i) => i.status === 'failed');
  const blockedItems = workItems.filter((i) => i.status === 'blocked');
  const pendingItems = workItems.filter((i) => i.status === 'pending');

  // Extract cost events
  const costEvents = recentEvents
    .filter((e) => e.type === 'agent.cost')
    .map((e) => ({
      role: e.agentRole,
      cost: e.data?.totalCostUsd,
      turns: e.data?.numTurns,
      duration: e.data?.durationMs,
      summary: e.summary,
    }));

  // Extract error events
  const errorEvents = recentEvents
    .filter((e) => e.type.includes('error'))
    .map((e) => ({
      type: e.type,
      project: e.project,
      summary: e.summary,
    }));

  const workItemSummary = `
## Work Item Outcomes (since last reflection)

- **Completed:** ${completedItems.length}
  ${completedItems.map((i) => `  - ${i.project}/${i.title}`).join('\n')}
- **Failed:** ${failedItems.length}
  ${failedItems.map((i) => `  - ${i.project}/${i.title}: ${i.blockReason ?? 'unknown'}`).join('\n')}
- **Blocked:** ${blockedItems.length}
  ${blockedItems.map((i) => `  - ${i.project}/${i.title}: ${i.blockReason ?? 'unknown'}`).join('\n')}
- **Pending:** ${pendingItems.length}
`.trim();

  const costSummary = `
## Agent Cost Summary

${costEvents.length > 0
    ? costEvents.map((c) => `- [${c.role}] $${Number(c.cost ?? 0).toFixed(2)} / ${c.turns} turns / ${Number(c.duration ?? 0).toFixed(0)}ms`).join('\n')
    : 'No cost data available.'}
`.trim();

  const errorSummary = `
## Errors Encountered

${errorEvents.length > 0
    ? errorEvents.map((e) => `- [${e.type}] ${e.project ?? 'general'}: ${e.summary}`).join('\n')
    : 'No errors recorded.'}
`.trim();

  const previousContext = latestLearning
    ? `\n## Previous Reflection\n\n${latestLearning.slice(0, 3000)}`
    : '';

  const prompt = `You are a reflective agent analyzing the Forge orchestrator's recent work output.

Your purpose: identify patterns, inefficiencies, and opportunities for improvement.

${workItemSummary}

${costSummary}

${errorSummary}
${previousContext}

## Your Task

Analyze the above data and produce a structured reflection report:

1. **Success Patterns:** What went well? Which agent configurations, prompts, or work item structures produced the best outcomes?
2. **Failure Analysis:** What failed and why? Are there recurring patterns in failures? Are specific types of work items more failure-prone?
3. **Cost Optimization:** Are any agents spending disproportionate amounts? Could prompt changes reduce token usage?
4. **Process Improvements:** Specific, actionable recommendations for:
   - Agent prompt improvements
   - Work item structuring
   - Dependency ordering
   - Phase configuration (concurrency, budget allocation)
5. **Technical Debt:** Any patterns suggesting accumulated technical debt in the orchestrator itself?

## Output Format

Produce a markdown report with the following structure:

\`\`\`markdown
# Forge Reflection — [Date]

## Summary
[2-3 sentence overview]

## Success Patterns
[What worked well and why]

## Failure Analysis
[What failed, patterns, root causes]

## Cost Optimization
[Recommendations to reduce wasteful spending]

## Process Improvements
[Specific, actionable changes]

## Recommendations
- **Immediate:** [Changes to make now]
- **Short-term:** [Changes for next sprint]
- **Long-term:** [Architectural improvements]
\`\`\`

Be brutally honest. The goal is continuous improvement, not self-congratulation.`;

  const result = await runAgent({
    agent,
    prompt,
    cwd: workspaceRoot,
    maxTurns: 15,
  });

  // Extract the markdown report
  const mdMatch = result.output.match(/```markdown\s*([\s\S]*?)```/);
  const report = mdMatch?.[1]?.trim() ?? result.output;

  // Save the learning
  store.saveLearning(report);

  return { report };
}
