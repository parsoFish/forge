/**
 * Pipeline — orchestrates the full workflow for a project or work item.
 *
 * The pipeline runs stages sequentially for each work item:
 * design → plan → test → develop → pr → review
 *
 * Design and plan stages operate at the project level.
 * Test through review stages operate per work item.
 */

import chalk from 'chalk';
import type { AgentDefinition, AgentRole } from '../agents/types.js';
import { StateStore } from '../state/store.js';
import type { WorkItem, WorkflowStage } from './types.js';
import { STAGE_AGENT_MAP } from './types.js';
import {
  runDesignStage,
  runPlanStage,
  runTestStage,
  runDevelopStage,
  runPRStage,
  markForReview,
} from './stages/index.js';

export interface PipelineConfig {
  readonly workspaceRoot: string;
  readonly projectPath: string;
  readonly projectName: string;
  readonly agents: Map<AgentRole, AgentDefinition>;
  readonly store: StateStore;
}

/**
 * Run the full pipeline for a project: design → plan → per-item (test → develop → pr → review).
 */
export async function runFullPipeline(config: PipelineConfig): Promise<void> {
  const { projectPath, projectName, agents, store } = config;

  console.log(chalk.bold.blue(`\n▶ Starting pipeline for ${projectName}\n`));

  // Stage 1: Design
  const architect = agents.get(STAGE_AGENT_MAP.design);
  if (!architect) throw new Error('Architect agent not found');

  console.log(chalk.yellow('  ◆ Design stage...'));
  const { brief } = await runDesignStage(architect, projectName, projectPath, store);
  console.log(chalk.green(`  ✓ Design complete: ${brief.features.length} features proposed`));

  if (brief.features.length === 0) {
    console.log(chalk.dim('  ○ No features to implement. Pipeline complete.'));
    return;
  }

  // Stage 2: Plan
  const planner = agents.get(STAGE_AGENT_MAP.plan);
  if (!planner) throw new Error('Planner agent not found');

  console.log(chalk.yellow('  ◆ Planning stage...'));
  const { workItems } = await runPlanStage(planner, brief, projectPath, store);
  console.log(chalk.green(`  ✓ Planning complete: ${workItems.length} work items created`));

  // Stages 3-6: Per work item
  for (const workItem of workItems) {
    await runWorkItemPipeline(workItem, config);
  }

  console.log(chalk.bold.green(`\n✓ Pipeline complete for ${projectName}\n`));
}

/**
 * Run the per-item pipeline: test → develop → pr → review.
 */
export async function runWorkItemPipeline(
  workItem: WorkItem,
  config: PipelineConfig,
): Promise<void> {
  const { projectPath, agents, store } = config;

  console.log(chalk.bold(`\n  ┌─ Work Item: ${workItem.title}`));
  console.log(chalk.dim(`  │  Branch: ${workItem.branch}`));

  // Auto-advance past stages that already have recorded output
  const advancedStage = resolveCurrentStage(workItem);
  if (advancedStage !== workItem.stage) {
    console.log(chalk.dim(`  │  Stage auto-advanced: ${workItem.stage} → ${advancedStage}`));
    workItem.stage = advancedStage;
    workItem.updatedAt = new Date().toISOString();
    store.saveWorkItem(workItem);
  }

  // Test stage
  if (workItem.stage === 'test' && workItem.status === 'pending') {
    const testAgent = agents.get(STAGE_AGENT_MAP.test);
    if (!testAgent) throw new Error('Test engineer agent not found');

    console.log(chalk.yellow('  │  ◆ Writing tests...'));
    workItem.status = 'in-progress';
    store.saveWorkItem(workItem);

    await runTestStage(testAgent, workItem, projectPath, store);
    console.log(chalk.green('  │  ✓ Tests created'));
  }

  // Develop stage
  if (workItem.stage === 'develop' && workItem.status === 'pending') {
    const devAgent = agents.get(STAGE_AGENT_MAP.develop);
    if (!devAgent) throw new Error('Developer agent not found');

    console.log(chalk.yellow('  │  ◆ Implementing...'));
    workItem.status = 'in-progress';
    store.saveWorkItem(workItem);

    await runDevelopStage(devAgent, workItem, projectPath, store);

    // Re-read status after stage mutation (runDevelopStage may set blocked/failed)
    const currentStatus = workItem.status as string;
    if (currentStatus === 'blocked') {
      console.log(chalk.red(`  │  ✗ Blocked: ${workItem.blockReason}`));
      console.log(chalk.dim('  └─ Skipping PR — needs human attention'));
      return;
    }
    console.log(chalk.green('  │  ✓ Implementation complete'));
  }

  // PR stage
  if (workItem.stage === 'pr' && workItem.status === 'pending') {
    const prAgent = agents.get(STAGE_AGENT_MAP.pr);
    if (!prAgent) throw new Error('PR creator agent not found');

    console.log(chalk.yellow('  │  ◆ Creating PR...'));
    workItem.status = 'in-progress';
    store.saveWorkItem(workItem);

    await runPRStage(prAgent, workItem, projectPath, store);
    console.log(chalk.green('  │  ✓ PR created'));
  }

  // Review stage
  if (workItem.stage === 'review') {
    markForReview(workItem, store);
    console.log(chalk.cyan('  │  ⏳ Awaiting human review'));
  }

  console.log(chalk.dim('  └─ Done'));
}

/**
 * Walk pipeline stages and return the first stage without recorded output.
 * Prevents items from getting stuck at already-completed stages after crashes.
 */
function resolveCurrentStage(workItem: WorkItem): WorkflowStage {
  const pipelineStages: readonly WorkflowStage[] = ['test', 'develop', 'pr', 'review'];
  for (const stage of pipelineStages) {
    if (!workItem.stageOutputs[stage]) {
      return stage;
    }
  }
  return 'review';
}

/**
 * Resume a specific work item from its current stage.
 */
export async function resumeWorkItem(
  workItemId: string,
  config: PipelineConfig,
): Promise<void> {
  const workItem = config.store.getWorkItem(workItemId);
  if (!workItem) throw new Error(`Work item ${workItemId} not found`);

  workItem.status = 'pending'; // Reset status to allow re-processing
  config.store.saveWorkItem(workItem);

  await runWorkItemPipeline(workItem, config);
}
