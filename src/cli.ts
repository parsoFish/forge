#!/usr/bin/env node

/**
 * Forge CLI — command-line interface for the orchestrator.
 *
 * Job-posting commands (fast, non-blocking):
 *   forge roadmap [project]   Queue roadmap generation jobs
 *   forge plan [project]      Queue work item planning jobs
 *   forge implement [project] Queue implementation jobs
 *   forge reflect             Queue a reflection/learning job
 *   forge run <project>       Queue full pipeline (roadmap + plan + implement)
 *   forge run-all             Queue full pipeline for all projects
 *
 * Worker (long-running):
 *   forge worker              Start the job worker (processes queued jobs)
 *   forge worker --daemon     Start in keep-alive mode (waits for new jobs)
 *
 * Queue management:
 *   forge jobs                Show job queue status
 *   forge cancel [job-id]     Cancel queued jobs
 *
 * Info:
 *   forge status              Show current state
 *   forge phase [phase]       Show or switch orchestrator phase
 *   forge projects            List managed projects
 *   forge events [project]    Show recent events
 *
 * Still blocking (interactive):
 *   forge research            Run the research agent
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { Worker } from './jobs/index.js';
import { EventLog } from './events/index.js';
import { Session } from './session/index.js';
import { launchUI, startMonitorPane, startQueuePane, startActionsPane } from './ui/index.js';
import { VERSION } from './version.js';

const program = new Command();

program
  .name('forge')
  .description('Autonomous multi-agent orchestrator — a lead engineer for your codebase')
  .version(VERSION)
  .action(() => {
    // No subcommand → launch the full tmux UI
    launchUI();
  });

// ═══════════════════════════════════════════════════════════════════
// Job-posting commands (non-blocking)
// ═══════════════════════════════════════════════════════════════════

program
  .command('roadmap [project]')
  .description('Queue roadmap generation jobs (exits immediately)')
  .option('-d, --direction <text>', 'User direction/priorities for the roadmap')
  .action(async (project?: string, opts?: { direction?: string }) => {
    try {
      const orch = new Orchestrator();
      await orch.roadmap(project, opts?.direction);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('plan [project]')
  .description('Queue work item planning jobs (exits immediately)')
  .action(async (project?: string) => {
    try {
      const orch = new Orchestrator();
      await orch.plan(project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('implement [project]')
  .description('Queue implementation jobs (exits immediately)')
  .action(async (project?: string) => {
    try {
      const orch = new Orchestrator();
      await orch.implement(project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });


program
  .command('review [project]')
  .description('Queue PR review jobs — scans GitHub for open PRs and reviews each one (priority: highest)')
  .action(async (project?: string) => {
    try {
      const orch = new Orchestrator();
      await orch.review(project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('fix <pr-number>')
  .description('Queue a fix job for a PR — starts the autonomous review/fix loop')
  .requiredOption('-p, --project <name>', 'Project the PR belongs to')
  .action(async (prNumberStr: string, opts: { project: string }) => {
    try {
      const prNumber = parseInt(prNumberStr, 10);
      if (isNaN(prNumber)) {
        console.error(chalk.red(`Invalid PR number: ${prNumberStr}`));
        process.exit(1);
      }
      const orch = new Orchestrator();
      await orch.fix(prNumber, opts.project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('fix-all [project]')
  .description('Queue fix jobs for ALL open PRs — starts the autonomous review/fix loop for each')
  .action(async (project?: string) => {
    try {
      const orch = new Orchestrator();
      await orch.fixAll(project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('reflect')
  .description('Queue a reflection/learning job (exits immediately)')
  .action(async () => {
    try {
      const orch = new Orchestrator();
      await orch.reflect();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('run <project>')
  .description('Queue full pipeline (roadmap + plan + implement) for a project')
  .action(async (project: string) => {
    try {
      const orch = new Orchestrator();
      await orch.runProject(project);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('run-all')
  .description('Queue full pipeline for all managed projects')
  .action(async () => {
    try {
      const orch = new Orchestrator();
      await orch.runAll();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════════
// Worker (long-running job executor)
// ═══════════════════════════════════════════════════════════════════

program
  .command('worker')
  .description('Start the job worker — processes queued jobs until done')
  .option('--daemon', 'Keep alive: wait for new jobs instead of exiting when empty')
  .action(async (opts: { daemon?: boolean }) => {
    try {
      const worker = new Worker();
      await worker.start(opts.daemon ?? false);
    } catch (error) {
      console.error(chalk.red('Worker error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════════
// Queue management
// ═══════════════════════════════════════════════════════════════════

program
  .command('jobs')
  .description('Show job queue status')
  .action(() => {
    const orch = new Orchestrator();
    orch.jobs();
  });

program
  .command('cancel [job-id]')
  .description('Cancel a specific job or all queued jobs')
  .action((jobId?: string) => {
    const orch = new Orchestrator();
    orch.cancelJobs(jobId);
  });

program
  .command('retry')
  .description('Reset all failed jobs back to queued for retry')
  .action(() => {
    const orch = new Orchestrator();
    orch.retryFailed();
  });

program
  .command('resume [project-or-id]')
  .description('Queue jobs to resume work based on current phase')
  .action(async (id?: string) => {
    try {
      const orch = new Orchestrator();
      await orch.resume(id);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ═══════════════════════════════════════════════════════════════════
// Info commands
// ═══════════════════════════════════════════════════════════════════

program
  .command('status')
  .description('Show current state of all work items, phase, budget, jobs, and roadmaps')
  .action(() => {
    const orch = new Orchestrator();
    orch.status();
  });

program
  .command('phase [phase]')
  .description('Show or switch the orchestrator phase (roadmapping, implementation, review, merging, reflect)')
  .option('-n, --notes <text>', 'Optional notes for the phase switch')
  .action((phase?: string, opts?: { notes?: string }) => {
    const orch = new Orchestrator();
    if (!phase) {
      const current = orch.getCurrentPhase();
      console.log(chalk.bold(`\n  Current phase: ${current}\n`));
      return;
    }
    const validPhases = ['roadmapping', 'implementation', 'review', 'merging', 'reflect'] as const;
    if (!validPhases.includes(phase as typeof validPhases[number])) {
      console.error(chalk.red(`Invalid phase: "${phase}". Valid: ${validPhases.join(', ')}`));
      process.exit(1);
    }
    orch.setPhase(phase as typeof validPhases[number], opts?.notes);
  });

program
  .command('projects')
  .description('List managed projects')
  .action(() => {
    const orch = new Orchestrator();
    orch.listProjects();
  });

program
  .command('research')
  .description('Run the research agent (blocking — stays in this process)')
  .action(async () => {
    try {
      const orch = new Orchestrator();
      await orch.research();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('events [project]')
  .description('Show recent events from the event log')
  .option('-n, --count <n>', 'Number of events to show', '30')
  .action((project?: string, opts?: { count: string }) => {
    const eventLog = new EventLog(resolve(process.cwd(), '.forge'));
    const count = parseInt(opts?.count ?? '30', 10);

    const events = project
      ? eventLog.forProject(project, count)
      : eventLog.recent(count);

    if (events.length === 0) {
      console.log(chalk.dim('\n  No events recorded yet.\n'));
      return;
    }

    console.log(chalk.bold(`\n  Recent Events${project ? ` (${project})` : ''}:\n`));
    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const role = event.agentRole ? chalk.cyan(`[${event.agentRole}]`) : '';
      const typeColor = event.type.includes('error') ? chalk.red
        : event.type.includes('complete') ? chalk.green
        : chalk.dim;
      console.log(`  ${chalk.dim(time)} ${typeColor(event.type)} ${role} ${event.summary}`);
    }
    console.log();
  });

// ═══════════════════════════════════════════════════════════════════
// UI — multi-pane tmux interface
// ═══════════════════════════════════════════════════════════════════

// Internal: the interactive REPL session that runs inside the tmux main pane.
// Not intended for direct use — `forge` (no args) launches the full UI.
program
  .command('session', { hidden: true })
  .action(async () => {
    try {
      const session = new Session();
      await session.start();
    } catch (error) {
      console.error(chalk.red('Session error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('watch:monitor')
  .description('Live monitoring pane (worker status, CPU/mem, slots, budget)')
  .action(() => {
    startMonitorPane();
  });

program
  .command('watch:queue')
  .description('Live job queue pane (priority view, ↑↓ to select, +/- to bump priority)')
  .action(() => {
    startQueuePane();
  });

program
  .command('watch:actions')
  .description('Live agent actions pane (one line per running agent, completed summaries)')
  .action(() => {
    startActionsPane();
  });

program.parse();
