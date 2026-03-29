/**
 * tmux session launcher — creates the 4-pane Forge UI layout.
 *
 * Layout:
 *
 *   ┌────────────────────────┬──────────────────┐
 *   │                        │   Job Queue       │
 *   │  Forge Orchestrator    ├──────────────────┤
 *   │  (interactive session) │   Rolling Actions │
 *   │                        ├──────────────────┤
 *   │                        │   Monitoring      │
 *   └────────────────────────┴──────────────────┘
 *
 * The left pane (65%) is the main interactive CLI (`forge session`).
 * The right column (35%) is split bottom-up:
 *   - Monitor: fixed ~8 rows (slots, budget, CPU/mem)
 *   - Queue & Agents: split 50/50 of the remaining space
 *
 * The session command is wrapped with `systemd-run --user --scope` when
 * available, giving the forge process a delegated cgroup scope for
 * per-agent memory limits. Watch panes are read-only and don't need it.
 *
 * `forge` (no args) calls this. The tmux layout IS the forge experience.
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

function systemdRunAvailable(): boolean {
  try {
    execSync('systemd-run --user --version', { stdio: 'pipe' });
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

/**
 * Wrap a command with systemd-run to get a delegated cgroup scope.
 * Only used for the session pane where agents are spawned.
 */
function wrapWithScope(cmd: string): string {
  if (!systemdRunAvailable()) return cmd;
  // --expand-environment=no suppresses the warning about env vars in args
  return `systemd-run --user --scope --expand-environment=no -p Delegate=yes -- ${cmd}`;
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
  // Wrap session command in systemd scope for cgroup delegation
  const sessionCmd = wrapWithScope(`${forgeCmd} session`);

  // Right column layout (bottom-up):
  //   Monitor: fixed 8 rows (small, dense info)
  //   Queue:   50% of remaining space
  //   Agents:  50% of remaining space
  const commands = [
    // Create session with the main orchestrator pane (interactive REPL)
    `tmux new-session -d -s ${SESSION_NAME} '${sessionCmd}'`,

    // Split right column (35% width — gives orchestrator more room).
    // This pane starts as queue; we split from the bottom up.
    `tmux split-window -h -t ${SESSION_NAME} -l 35% '${forgeCmd} watch:queue'`,

    // Split monitor off the bottom of the right column (small, fixed).
    // ~8 rows is enough for worker state + jobs + CPU/mem + budget.
    `tmux split-window -v -t ${SESSION_NAME}:0.1 -l 8 '${forgeCmd} watch:monitor'`,

    // Split remaining space evenly between queue (top) and agents (bottom).
    `tmux split-window -v -t ${SESSION_NAME}:0.1 -l 50% '${forgeCmd} watch:actions'`,

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
