/**
 * Slash command registry — maps /commands to orchestrator actions.
 *
 * Each command has a name, description, and handler that receives
 * the orchestrator instance and any arguments.
 */

import chalk from 'chalk';
import type { Orchestrator } from '../orchestrator.js';
import type { Worker } from '../jobs/worker.js';
import type { Session } from './session.js';

export interface SlashCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly handler: (ctx: CommandContext, args: string[]) => Promise<void>;
}

export interface CommandContext {
  readonly orch: Orchestrator;
  readonly worker: Worker | null;
  readonly session: Session;
}

const commands: SlashCommand[] = [
  // --- Phase triggers ---
  {
    name: 'roadmap',
    aliases: ['rm'],
    description: 'Interactive roadmap session — collaborative design conversation',
    usage: '/roadmap <project>',
    handler: async (ctx, args) => {
      let project = args[0];

      // If no project specified, let the user pick
      if (!project) {
        const projects = ctx.orch.getProjectNames();
        if (projects.length === 0) {
          ctx.session.writeDirect(chalk.red('  No projects found.'));
          return;
        }
        ctx.session.writeDirect(chalk.bold('\n  Select a project for roadmapping:\n'));
        for (let i = 0; i < projects.length; i++) {
          ctx.session.writeDirect(`  ${chalk.cyan(`${i + 1}.`)} ${projects[i]}`);
        }
        ctx.session.writeDirect('');

        const choice = await ctx.session.question(chalk.blue('  Project name or number: '));
        const choiceNum = parseInt(choice, 10);
        if (choiceNum >= 1 && choiceNum <= projects.length) {
          project = projects[choiceNum - 1];
        } else if (projects.includes(choice.trim())) {
          project = choice.trim();
        } else {
          ctx.session.writeDirect(chalk.red(`  Unknown project: ${choice}`));
          return;
        }
      }

      // Re-suppress background output. The REPL unsuppresses for all commands,
      // but /roadmap spawns agents that run for minutes — their LiveTracker
      // noise must stay hidden. We use writeDirect for our own output (bypasses
      // suppression) and readline prompts go through process.stdout directly.
      ctx.session.resumeAfterInteraction();
      await ctx.orch.interactiveRoadmap(project, {
        ask: (prompt) => ctx.session.question(prompt),
        print: (text) => ctx.session.writeDirect(text),
        collectMultiLine: (prompt) => ctx.session.collectMultiLine(prompt),
      });
    },
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Queue planning jobs (standalone — /implement includes this)',
    usage: '/plan [project]',
    handler: async (ctx, args) => {
      await ctx.orch.plan(args[0]);
    },
  },
  {
    name: 'implement',
    aliases: ['impl'],
    description: 'Unified pipeline: plan → implement → review (auto-enables worker)',
    usage: '/implement [project]',
    handler: async (ctx, args) => {
      let project = args[0];

      // If no project specified, let the user pick
      if (!project) {
        const projects = ctx.orch.getProjectNames();
        if (projects.length === 0) {
          ctx.session.writeDirect(chalk.red('  No projects found.'));
          return;
        }
        if (projects.length === 1) {
          project = projects[0];
        } else {
          ctx.session.writeDirect(chalk.bold('\n  Select a project:\n'));
          for (let i = 0; i < projects.length; i++) {
            ctx.session.writeDirect(`  ${chalk.cyan(`${i + 1}.`)} ${projects[i]}`);
          }
          ctx.session.writeDirect('');

          const choice = await ctx.session.question(chalk.blue('  Project name or number: '));
          const choiceNum = parseInt(choice, 10);
          if (choiceNum >= 1 && choiceNum <= projects.length) {
            project = projects[choiceNum - 1];
          } else if (projects.includes(choice.trim())) {
            project = choice.trim();
          } else {
            ctx.session.writeDirect(chalk.red(`  Unknown project: ${choice}`));
            return;
          }
        }
      }

      // Run the unified implement session
      const { startImplementSession } = await import('../workflow/stages/implement-session.js');
      const { ImplementSessionStore } = await import('../state/implement-session.js');
      const { resolve } = await import('node:path');

      const forgeRoot = resolve(ctx.orch['settings'].workspaceRoot, '.forge');
      const sessionStore = new ImplementSessionStore(forgeRoot);

      await startImplementSession(project, {
        store: ctx.orch['store'],
        sessionStore,
        queue: ctx.orch['queue'],
        eventLog: ctx.orch['eventLog'],
        enableWorker: () => ctx.session.enableWorker(),
      }, {
        ask: (prompt) => ctx.session.question(prompt),
        print: (text) => ctx.session.writeDirect(text),
      });
    },
  },
  {
    name: 'review',
    aliases: ['rev'],
    description: 'Interactive review — automated reviews first, then user presentation',
    usage: '/review [project]',
    handler: async (ctx, args) => {
      let project = args[0];

      // If no project specified, let the user pick
      if (!project) {
        const projects = ctx.orch.getProjectNames();
        if (projects.length === 0) {
          ctx.session.writeDirect(chalk.red('  No projects found.'));
          return;
        }
        if (projects.length === 1) {
          project = projects[0];
        } else {
          ctx.session.writeDirect(chalk.bold('\n  Select a project for review:\n'));
          for (let i = 0; i < projects.length; i++) {
            ctx.session.writeDirect(`  ${chalk.cyan(`${i + 1}.`)} ${projects[i]}`);
          }
          ctx.session.writeDirect('');

          const choice = await ctx.session.question(chalk.blue('  Project name or number: '));
          const choiceNum = parseInt(choice, 10);
          if (choiceNum >= 1 && choiceNum <= projects.length) {
            project = projects[choiceNum - 1];
          } else if (projects.includes(choice.trim())) {
            project = choice.trim();
          } else {
            ctx.session.writeDirect(chalk.red(`  Unknown project: ${choice}`));
            return;
          }
        }
      }

      // Pause prompt refresh but keep console suppressed — the review
      // spawns agents for handoff summaries whose LiveTracker noise
      // must stay hidden. All user-facing output goes through writeDirect.
      ctx.session.pauseForInteraction(/* keepSuppressed */ true);
      try {
        await ctx.orch.newInteractiveReview(project, {
          ask: (prompt) => ctx.session.question(prompt),
          print: (text) => ctx.session.writeDirect(text),
          collectMultiLine: (prompt) => ctx.session.collectMultiLine(prompt),
        }, {
          enableWorker: () => ctx.session.enableWorker(),
          disableWorker: () => ctx.session.disableWorker(),
          waitForReviewsDrained: (p) => {
            if (!ctx.worker) throw new Error('Worker not available — start with /worker on');
            return ctx.worker.waitForReviewsDrained(p);
          },
          waitForCloseOutsDrained: (p, prNumbers) => {
            if (!ctx.worker) throw new Error('Worker not available — start with /worker on');
            return ctx.worker.waitForCloseOutsDrained(p, prNumbers);
          },
        });
      } finally {
        ctx.session.resumeAfterInteraction();
      }
    },
  },
  {
    name: 'fix',
    aliases: [],
    description: 'Queue a fix job for a PR',
    usage: '/fix <pr-number> <project>',
    handler: async (ctx, args) => {
      const prNumber = parseInt(args[0], 10);
      const project = args[1];
      if (isNaN(prNumber) || !project) {
        console.log(chalk.red('  Usage: /fix <pr-number> <project>'));
        return;
      }
      await ctx.orch.fix(prNumber, project);
    },
  },
  {
    name: 'fix-all',
    aliases: ['fa'],
    description: 'Queue fix jobs for all open PRs',
    usage: '/fix-all [project]',
    handler: async (ctx, args) => {
      await ctx.orch.fixAll(args[0]);
    },
  },
  {
    name: 'reflect',
    aliases: [],
    description: 'Queue a reflection job',
    usage: '/reflect',
    handler: async (ctx) => {
      await ctx.orch.reflect();
    },
  },
  // --- Info commands ---
  {
    name: 'status',
    aliases: ['s'],
    description: 'Show current state',
    usage: '/status',
    handler: async (ctx) => {
      ctx.orch.status();
    },
  },
  {
    name: 'jobs',
    aliases: ['j'],
    description: 'Show job queue',
    usage: '/jobs',
    handler: async (ctx) => {
      ctx.orch.jobs();
    },
  },
  {
    name: 'projects',
    aliases: ['p'],
    description: 'List managed projects',
    usage: '/projects',
    handler: async (ctx) => {
      ctx.orch.listProjects();
    },
  },

  // --- Queue management ---
  {
    name: 'cancel',
    aliases: [],
    description: 'Cancel a job or all queued jobs',
    usage: '/cancel [job-id]',
    handler: async (ctx, args) => {
      ctx.orch.cancelJobs(args[0]);
    },
  },
  {
    name: 'retry',
    aliases: [],
    description: 'Reset failed jobs to queued',
    usage: '/retry',
    handler: async (ctx) => {
      ctx.orch.retryFailed();
    },
  },

  {
    name: 'clean',
    aliases: [],
    description: 'Archive current cycle and reset for a new one',
    usage: '/clean [--keep-roadmaps]',
    handler: async (ctx, args) => {
      const keepRoadmaps = args.includes('--keep-roadmaps');

      console.log(chalk.bold('\n  This will archive:'));
      console.log(chalk.dim('    - All work items'));
      console.log(chalk.dim('    - All jobs'));
      console.log(chalk.dim('    - Design briefs'));
      console.log(chalk.dim('    - Events log'));
      if (!keepRoadmaps) {
        console.log(chalk.dim('    - Roadmaps (use --keep-roadmaps to preserve)'));
      }
      console.log(chalk.dim('    Learnings are always kept.\n'));

      const confirm = await ctx.session.question(chalk.yellow('  Proceed? (y/N): '));
      if (!/^y(es)?$/i.test(confirm.trim())) {
        console.log(chalk.dim('  Cancelled.\n'));
        return;
      }

      ctx.orch.archiveCycle({ keepRoadmaps });
    },
  },

  // --- Session ---
  {
    name: 'worker',
    aliases: ['w'],
    description: 'Toggle worker on/off or show status',
    usage: '/worker [on|off]',
    handler: async (ctx, args) => {
      const sub = args[0]?.toLowerCase();

      if (sub === 'on') {
        ctx.session.enableWorker();
        console.log(chalk.green('  ▶ Worker enabled — processing jobs.'));
        return;
      }

      if (sub === 'off') {
        ctx.session.disableWorker();
        console.log(chalk.yellow('  ⏸ Worker disabled — in-flight jobs will finish.'));
        return;
      }

      // No argument or "status" — show current state
      const desired = ctx.session.workerDesired;
      const paused = ctx.session.workerPaused;
      const active = ctx.session.activeJobs;
      const resetAt = ctx.session.rateLimitResetAt;

      console.log(chalk.bold('\n  Worker Status:\n'));
      console.log(`  Desired:     ${desired ? chalk.green('on') : chalk.dim('off')}`);
      console.log(`  State:       ${paused ? chalk.yellow('paused') : chalk.green('running')}`);
      console.log(`  Active jobs: ${active > 0 ? chalk.yellow(String(active)) : chalk.dim('0')}`);

      if (resetAt > Date.now()) {
        const time = new Date(resetAt).toLocaleTimeString();
        console.log(`  Rate limit:  ${chalk.yellow(`resets at ${time}`)}`);
      } else {
        console.log(`  Rate limit:  ${chalk.dim('none')}`);
      }

      console.log(chalk.dim(`\n  Use /worker on or /worker off to toggle.\n`));
    },
  },
  // /monitor and /activity removed — replaced by dedicated tmux panes.
  {
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the screen',
    usage: '/clear',
    handler: async () => {
      process.stdout.write('\x1b[2J\x1b[1;1H');
    },
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands',
    usage: '/help',
    handler: async () => {
      console.log(chalk.bold('\n  Forge Commands:\n'));
      const maxLen = Math.max(...commands.map(c => c.usage.length));
      for (const cmd of commands) {
        const aliases = cmd.aliases.length > 0 ? chalk.dim(` (${cmd.aliases.map(a => '/' + a).join(', ')})`) : '';
        console.log(`  ${chalk.cyan(cmd.usage.padEnd(maxLen + 2))}${cmd.description}${aliases}`);
      }
      console.log(chalk.bold('\n  Tmux Controls:\n'));
      console.log(chalk.dim('  Ctrl+B then arrow   Switch between panes'));
      console.log(chalk.dim('  Ctrl+B then D       Detach (forge keeps running)'));
      console.log(chalk.dim('  Ctrl+B then Z       Zoom current pane (toggle)'));
      console.log(chalk.dim('  /quit               Exit forge and close all panes'));
      console.log();
    },
  },
  {
    name: 'quit',
    aliases: ['q', 'exit'],
    description: 'Exit forge',
    usage: '/quit',
    handler: async () => {
      // Handled by the session — this is just for help display
      process.exit(0);
    },
  },
];

/** Build a lookup map for fast dispatch (name + all aliases). */
const commandMap = new Map<string, SlashCommand>();
for (const cmd of commands) {
  commandMap.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    commandMap.set(alias, cmd);
  }
}

/**
 * Parse and dispatch a slash command.
 * Returns true if it was a valid command, false if unrecognized.
 */
export async function dispatchCommand(input: string, ctx: CommandContext): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return false;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  const cmd = commandMap.get(name);
  if (!cmd) {
    console.log(chalk.yellow(`  Unknown command: /${name}. Type /help for available commands.`));
    return true; // It was a command attempt, just unrecognized
  }

  try {
    await cmd.handler(ctx, args);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  Error: ${msg}`));
  }

  return true;
}
