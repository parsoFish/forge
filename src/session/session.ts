/**
 * Interactive session — the main pane in the tmux forge UI.
 *
 * Architecture: The session owns three subsystems:
 * 1. **REPL** — readline-based prompt for slash commands
 * 2. **Worker** — background job executor (defaults to OFF)
 * 3. **OutputInterceptor** — silently discards background worker output
 *
 * The worker runs in the same process. Its console output is suppressed
 * because status flows through .forge/worker-status.json to dedicated
 * UI panes (queue, actions, monitor). The main pane stays clean.
 *
 * Worker lifecycle:
 * - Starts paused (off by default)
 * - User toggles with /worker on|off
 * - Auto-pauses on rate limit or budget exhaustion
 * - Auto-resumes after rate limit cooldown if user had it enabled
 */

import * as readline from 'node:readline';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { Orchestrator } from '../orchestrator.js';
import { Worker } from '../jobs/worker.js';
import { setSessionMode } from '../agents/runner.js';
import { OutputInterceptor } from './output.js';
import { dispatchCommand, type CommandContext } from './commands.js';

/** How long to wait before auto-resuming after a rate limit (buffer on top of reset time). */
const RESUME_BUFFER_MS = 5_000;

export class Session {
  private readonly orch: Orchestrator;
  private worker: Worker | null = null;
  private rl: readline.Interface | null = null;
  private readonly output = new OutputInterceptor();
  private workerPromise: Promise<void> | null = null;
  private _shutdown = false;

  // ── Worker state ──────────────────────────────────────────────────
  /** Whether the user wants the worker running. */
  private _workerDesired = false;
  /** Timer that auto-resumes the worker after a rate limit cooldown. */
  private _resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the rate limit resets (ms epoch), or 0 if not limited. */
  private _rateLimitResetAt = 0;

  constructor(workspaceRoot?: string) {
    this.orch = new Orchestrator(workspaceRoot);
  }

  async start(): Promise<void> {
    // Tell the LiveTracker to use simple line output (no ANSI cursor moves)
    setSessionMode(true);

    this.printBanner();

    // Create the worker but DON'T start processing yet.
    // It sits paused until the user enables it.
    this.worker = new Worker();
    this.worker.pause();
    this.wireWorkerCallbacks();

    // Start the worker loop in the background (it will sit paused)
    this.workerPromise = this.startWorkerBackground();

    // Start the REPL
    await this.startRepl();
  }

  // ══════════════════════════════════════════════════════════════════
  // Worker control — exposed to commands.ts
  // ══════════════════════════════════════════════════════════════════

  /** Enable the worker — start processing jobs. */
  enableWorker(): void {
    this._workerDesired = true;
    this.worker?.resume();
    this.updatePrompt();
  }

  /** Disable the worker — stop processing new jobs (in-flight finish). */
  disableWorker(): void {
    this._workerDesired = false;
    this.cancelResumeTimer();
    this.worker?.pause();
    this.updatePrompt();
  }

  /** Whether the user wants the worker running. */
  get workerDesired(): boolean {
    return this._workerDesired;
  }

  /** Whether the worker is actually paused right now. */
  get workerPaused(): boolean {
    return this.worker?.isPaused ?? true;
  }

  /** Rate limit reset time (for status display). */
  get rateLimitResetAt(): number {
    return this._rateLimitResetAt;
  }

  /** Active jobs count (for status display). */
  get activeJobs(): number {
    return this.worker?.activeJobCount ?? 0;
  }

  /**
   * Pause output suppression so an interactive command (like PR triage)
   * can use the readline directly without conflicts.
   */
  pauseForInteraction(): void {
    this.output.unsuppress();
  }

  /**
   * Resume background output suppression after interactive command completes.
   */
  resumeAfterInteraction(): void {
    this.output.suppress();
  }

  /**
   * Ask a question using the session's existing readline.
   * Used by interactive commands to avoid creating a second readline.
   */
  question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      if (!this.rl) {
        resolve('');
        return;
      }
      this.rl.question(prompt, resolve);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Internal: Banner & Prompt
  // ══════════════════════════════════════════════════════════════════

  private printBanner(): void {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║') + chalk.bold('         Forge Orchestrator v0.5.0        ') + chalk.bold.blue('║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════════╝'));
    console.log();
    console.log(chalk.dim('  Type /help for commands, /quit to exit.'));
    console.log(chalk.dim('  Worker is OFF by default. Use /worker on to start processing.'));
    console.log();
  }

  /**
   * Build the prompt string showing worker state.
   * This is the persistent "status header" — always visible.
   *
   * Examples:
   *   forge [off]>
   *   forge [4 run | 6 queue | build:2/4 | $12.50]>
   *   forge [⏳ 2:30am]>
   */
  private buildPrompt(): string {
    if (!this._workerDesired) {
      return chalk.blue('forge') + chalk.dim(' [off]') + chalk.blue('> ');
    }

    if (this._rateLimitResetAt > Date.now()) {
      const time = new Date(this._rateLimitResetAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return chalk.blue('forge') + chalk.yellow(` [⏳ ${time}]`) + chalk.blue('> ');
    }

    const active = this.worker?.activeJobCount ?? 0;
    if (active > 0) {
      return chalk.blue('forge') + chalk.green(` [${active} running]`) + chalk.blue('> ');
    }

    return chalk.blue('forge') + chalk.green(' [idle]') + chalk.blue('> ');
  }

  /** Refresh the prompt to reflect current state. */
  private updatePrompt(): void {
    if (!this.rl) return;
    this.rl.setPrompt(this.buildPrompt());

    // Redraw with current input preserved
    const rlAny = this.rl as unknown as Record<string, unknown>;
    if (typeof rlAny._refreshLine === 'function') {
      (rlAny._refreshLine as () => void)();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Internal: Worker lifecycle
  // ══════════════════════════════════════════════════════════════════

  /**
   * Wire up the worker's event callbacks so the session can react
   * to rate limits and budget exhaustion.
   */
  private wireWorkerCallbacks(): void {
    if (!this.worker) return;

    this.worker.onRateLimited = (resetAt: number) => {
      this._rateLimitResetAt = resetAt;
      this.worker?.pause();
      this.updatePrompt();

      const resumeTime = new Date(resetAt).toLocaleTimeString();
      this.output.writeDirect(chalk.yellow(`  ⏸ Worker auto-paused (rate limited until ${resumeTime})`));

      // If the user had the worker enabled, schedule auto-resume
      if (this._workerDesired) {
        this.scheduleResume(resetAt);
      }
    };

    this.worker.onBudgetExhausted = () => {
      this._workerDesired = false;
      this.worker?.pause();
      this.cancelResumeTimer();
      this.updatePrompt();
      this.output.writeDirect(chalk.red('  ⏸ Worker disabled — budget exhausted.'));
      this.output.writeDirect(chalk.dim('     Use /worker on after adjusting budget to resume.'));
    };
  }

  /**
   * Schedule the worker to auto-resume after the rate limit resets.
   */
  private scheduleResume(resetAt: number): void {
    this.cancelResumeTimer();

    const delayMs = Math.max(0, resetAt - Date.now()) + RESUME_BUFFER_MS;
    const resumeTime = new Date(resetAt + RESUME_BUFFER_MS).toLocaleTimeString();
    this.output.writeDirect(chalk.dim(`  Auto-resume scheduled for ${resumeTime}`));

    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = null;
      this._rateLimitResetAt = 0;

      if (!this._workerDesired || this._shutdown) return;

      this.output.writeDirect(chalk.green('  ▶ Auto-resuming worker after rate limit cooldown'));
      this.worker?.resume();
      this.updatePrompt();
    }, delayMs);
  }

  private cancelResumeTimer(): void {
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
  }

  private async startWorkerBackground(): Promise<void> {
    try {
      // Worker runs in daemon mode — stays alive waiting for jobs.
      // Output is intercepted by OutputInterceptor so it doesn't
      // stomp on the readline prompt.
      await this.worker!.start(true);
    } catch (error) {
      if (!this._shutdown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.output.writeDirect(chalk.red(`\n  Worker error: ${msg}`));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Internal: REPL
  // ══════════════════════════════════════════════════════════════════

  private async startRepl(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.buildPrompt(),
      terminal: process.stdin.isTTY ?? false,
    });

    // Suppress background worker output — info panes handle visibility
    this.output.start();

    // Periodically update the prompt to reflect worker state changes
    const promptTimer = setInterval(() => this.updatePrompt(), 3_000);

    this.rl.prompt();

    const ctx: CommandContext = {
      orch: this.orch,
      worker: this.worker,
      session: this,
    };

    this.rl.on('line', async (line: string) => {
      if (this._shutdown || !this.rl) return;

      const input = line.trim();

      if (!input) {
        this.rl.prompt();
        return;
      }

      // Check for quit
      if (/^\/(quit|q|exit)\s*$/i.test(input)) {
        clearInterval(promptTimer);
        await this.shutdown();
        return;
      }

      // Unsuppress console for user-initiated output, then re-suppress
      this.output.unsuppress();
      try {
        // Try slash command dispatch
        if (input.startsWith('/')) {
          await dispatchCommand(input, ctx);
          this.rl?.prompt();
          return;
        }

        // Non-slash input — for now, hint about commands
        console.log(chalk.dim('  Use /help to see available commands.'));
        console.log(chalk.dim('  (Orchestrator chat coming in a future update)'));
        this.rl?.prompt();
      } finally {
        this.output.suppress();
      }
    });

    this.rl.on('close', async () => {
      clearInterval(promptTimer);
      await this.shutdown();
    });

    // Keep the process alive while the REPL and worker are running
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this._shutdown) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Internal: Shutdown
  // ══════════════════════════════════════════════════════════════════

  private async shutdown(): Promise<void> {
    if (this._shutdown) return;
    this._shutdown = true;

    console.log(chalk.yellow('\n  Shutting down forge...'));

    this.output.stop();

    // Reset session mode
    setSessionMode(false);

    // Cancel any pending resume timer
    this.cancelResumeTimer();

    // Close REPL
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    // Graceful worker shutdown
    if (this.workerPromise) {
      process.emit('SIGINT' as NodeJS.Signals);
      try {
        await Promise.race([
          this.workerPromise,
          new Promise<void>((r) => setTimeout(r, 10_000)),
        ]);
      } catch { /* worker may have already stopped */ }
    }

    // If running inside a forge tmux session, kill the whole session
    // so all panes (queue, actions, monitor) close together.
    try {
      const tmuxSession = process.env.TMUX;
      if (tmuxSession) {
        execSync('tmux kill-session -t forge 2>/dev/null', { stdio: 'pipe' });
      }
    } catch { /* not in tmux or session already gone */ }

    console.log(chalk.dim('  Goodbye.\n'));
    process.exit(0);
  }
}
