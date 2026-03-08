/**
 * tmux session launcher — creates the 4-pane Forge UI layout.
 *
 * Layout matches the design spec:
 *
 *   ┌────────────────────────┬──────────────────┐
 *   │                        │   Job Queue       │
 *   │  Forge Orchestrator    ├──────────────────┤
 *   │  (interactive session) │   Rolling Actions │
 *   │                        ├──────────────────┤
 *   │                        │   Monitoring      │
 *   └────────────────────────┴──────────────────┘
 *
 * The left pane (60%) is the main interactive CLI (`forge session`).
 * The right column (40%) is split into 3 info panes.
 *
 * `forge` (no args) calls this. There is no separate "forge ui" command —
 * the tmux layout IS the forge experience.
 *
 * WHY tmux: it's already on WSL, gives crash isolation between panes,
 * maps directly to the 4-pane design, and needs zero npm dependencies.
 */

import { execSync, spawn } from 'node:child_process';
import chalk from 'chalk';

const SESSION_NAME = 'forge';

function tmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function sessionExists(): boolean {
  try {
    execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect how the forge CLI is invoked so tmux panes use the same path.
 * Could be `npx forge`, `node dist/cli.js`, or a globally installed `forge`.
 */
function resolveForgeCmd(): string {
  // If running via node directly, use the same entry point
  const scriptPath = process.argv[1];
  if (scriptPath) {
    return `node "${scriptPath}"`;
  }
  return 'npx forge';
}

export function launchUI(): void {
  if (!tmuxAvailable()) {
    console.error(chalk.red('tmux is required for Forge.'));
    console.error(chalk.dim('Install with: sudo apt install tmux'));
    console.error(chalk.dim('Or run individual commands: forge worker, forge fix-all, etc.'));
    process.exit(1);
  }

  // If already inside a tmux forge session, don't nest — just warn
  if (process.env.TMUX && sessionExists()) {
    console.log(chalk.dim('Already inside a forge tmux session.'));
    console.log(chalk.dim('Use forge subcommands directly, or detach with Ctrl+B then D.'));
    return;
  }

  // If session already exists (from another terminal), attach to it
  if (sessionExists()) {
    console.log(chalk.dim('Attaching to existing forge session...'));
    spawn('tmux', ['attach-session', '-t', SESSION_NAME], {
      stdio: 'inherit',
    });
    return;
  }

  const forgeCmd = resolveForgeCmd();

  // Layout designed for 80x24 minimum. Right column splits are sized
  // so actions (the "star") gets the most space, queue and monitor
  // are compact. All panes render bottom-up to minimize height needs.
  //
  //   ┌────────────────────────┬──────────────────┐
  //   │                        │   Queue (~5 rows) │
  //   │  Forge Orchestrator    ├──────────────────┤
  //   │  (interactive session) │   Actions (~13)   │
  //   │                        ├──────────────────┤
  //   │                        │   Monitor (~6)    │
  //   └────────────────────────┴──────────────────┘
  const commands = [
    // Create session with the main orchestrator pane (interactive REPL)
    `tmux new-session -d -s ${SESSION_NAME} '${forgeCmd} session'`,

    // Split right column (35% width — gives orchestrator more room)
    `tmux split-window -h -t ${SESSION_NAME} -l 35% '${forgeCmd} watch:queue'`,

    // Split right column: queue keeps top ~5 lines, actions+monitor get rest.
    // 78% of right column goes to actions+monitor, 22% stays as queue.
    `tmux split-window -v -t ${SESSION_NAME}:0.1 -l 78% '${forgeCmd} watch:actions'`,

    // Split bottom of right column: monitor gets ~6 lines (33% of remaining)
    `tmux split-window -v -t ${SESSION_NAME}:0.2 -l 33% '${forgeCmd} watch:monitor'`,

    // Focus the main orchestrator pane
    `tmux select-pane -t ${SESSION_NAME}:0.0`,

    // Minimal pane borders
    `tmux set -t ${SESSION_NAME} pane-border-style 'fg=colour238'`,
    `tmux set -t ${SESSION_NAME} pane-active-border-style 'fg=colour39'`,
  ];

  const setupCommands = commands.join(' && ');

  try {
    execSync(setupCommands, { stdio: 'pipe' });
  } catch (err) {
    console.error(chalk.red('Failed to create tmux session:'), (err as Error).message);
    try { execSync(`tmux kill-session -t ${SESSION_NAME}`, { stdio: 'pipe' }); } catch { /* ignore */ }
    process.exit(1);
  }

  // Attach interactively — this blocks until the session ends
  spawn('tmux', ['attach-session', '-t', SESSION_NAME], {
    stdio: 'inherit',
  });
}
