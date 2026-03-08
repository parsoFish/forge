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
    description: 'Queue roadmap generation for a project',
    usage: '/roadmap [project] [-d direction]',
    handler: async (ctx, args) => {
      const project = args.find(a => !a.startsWith('-'));
      const dirIdx = args.indexOf('-d');
      const direction = dirIdx >= 0 ? args.slice(dirIdx + 1).join(' ') : undefined;
      await ctx.orch.roadmap(project, direction);
    },
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Queue planning jobs',
    usage: '/plan [project]',
    handler: async (ctx, args) => {
      await ctx.orch.plan(args[0]);
    },
  },
  {
    name: 'implement',
    aliases: ['impl'],
    description: 'Queue implementation jobs',
    usage: '/implement [project]',
    handler: async (ctx, args) => {
      await ctx.orch.implement(args[0]);
    },
  },
  {
    name: 'review',
    aliases: ['rev'],
    description: 'Interactive PR triage and review',
    usage: '/review [project]',
    handler: async (ctx, args) => {
      // Pause interceptor + status bar so the interactive triage
      // can use the session's readline directly without cursor conflicts.
      ctx.session.pauseForInteraction();
      try {
        await ctx.orch.interactiveReview(
          args[0],
          (prompt) => ctx.session.question(prompt),
        );
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
  {
    name: 'run',
    aliases: [],
    description: 'Queue full pipeline for a project',
    usage: '/run <project>',
    handler: async (ctx, args) => {
      if (!args[0]) {
        console.log(chalk.red('  Usage: /run <project>'));
        return;
      }
      await ctx.orch.runProject(args[0]);
    },
  },
  {
    name: 'run-all',
    aliases: ['ra'],
    description: 'Queue full pipeline for all projects',
    usage: '/run-all',
    handler: async (ctx) => {
      await ctx.orch.runAll();
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
