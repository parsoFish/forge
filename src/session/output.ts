/**
 * Output interceptor — prevents background worker output from stomping
 * on the interactive readline prompt.
 *
 * WHY: The worker, agents, and LiveTracker all use console.log directly.
 * Refactoring hundreds of call sites to use a logger isn't practical.
 * Instead, we monkey-patch console.log/warn/error at the session level
 * to clear the prompt line before writing and redraw it after.
 *
 * The interceptor also maintains a ring buffer of recent messages so
 * users can review worker activity via the /activity command.
 */

import type * as readline from 'node:readline';

export interface BufferedMessage {
  readonly time: number;
  readonly level: 'log' | 'warn' | 'error';
  readonly text: string;
}

const MAX_BUFFER = 500;

export class OutputInterceptor {
  private rl: readline.Interface | null = null;
  private readonly originalLog = console.log;
  private readonly originalWarn = console.warn;
  private readonly originalError = console.error;
  private readonly buffer: BufferedMessage[] = [];
  private active = false;

  /**
   * Begin intercepting console output. All writes will be coordinated
   * with the readline prompt so the user's input is never stomped.
   */
  start(rl: readline.Interface): void {
    this.rl = rl;
    this.active = true;

    console.log = this.createInterceptor('log', this.originalLog);
    console.warn = this.createInterceptor('warn', this.originalWarn);
    console.error = this.createInterceptor('error', this.originalError);
  }

  /**
   * Stop intercepting — restore original console methods.
   */
  stop(): void {
    this.active = false;
    this.rl = null;
    console.log = this.originalLog;
    console.warn = this.originalWarn;
    console.error = this.originalError;
  }

  /**
   * Get recent buffered messages for the /activity command.
   */
  getRecent(count = 30): readonly BufferedMessage[] {
    return this.buffer.slice(-count);
  }

  /**
   * Write directly to stdout without interception — used for the
   * session's own UI elements (banners, command output).
   */
  writeDirect(...args: unknown[]): void {
    this.originalLog.apply(console, args);
  }

  /**
   * Create an interceptor function for a given console method.
   *
   * The pattern: clear the prompt line → write output → redraw prompt.
   * readline's internal _refreshLine() redraws the prompt string plus
   * whatever the user has typed so far, preserving their cursor position.
   */
  private createInterceptor(
    level: BufferedMessage['level'],
    original: (...args: unknown[]) => void,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      // Buffer the message text (strip ANSI for storage)
      const text = args
        .map((a) => (typeof a === 'string' ? a : String(a)))
        .join(' ');
      this.buffer.push({ time: Date.now(), level, text });
      if (this.buffer.length > MAX_BUFFER) {
        this.buffer.shift();
      }

      if (!this.active || !this.rl) {
        original.apply(console, args);
        return;
      }

      // Clear the current prompt line (move to column 0, erase line)
      process.stdout.write('\r\x1b[K');

      // Write the actual output via the original method
      original.apply(console, args);

      // Redraw the prompt + user's partial input.
      // _refreshLine is readline's internal method that redraws
      // prompt + line + positions cursor. Stable across Node 18+.
      const rlAny = this.rl as unknown as Record<string, unknown>;
      if (typeof rlAny._refreshLine === 'function') {
        (rlAny._refreshLine as () => void)();
      } else {
        // Fallback: just redraw the prompt (loses partial input)
        this.rl.prompt(true);
      }
    };
  }
}
