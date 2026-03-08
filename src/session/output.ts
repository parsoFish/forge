/**
 * Output interceptor — suppresses background worker console output
 * so the interactive session pane stays clean.
 *
 * In the tmux UI model, the main pane is for user interaction only.
 * Worker status flows through .forge/worker-status.json and events.jsonl
 * to the dedicated info panes (monitor, actions, queue).
 *
 * Background output (worker, agents) is silently discarded.
 * Session-owned output (commands, banners) uses unsuppress/suppress
 * bracketing to temporarily restore console during command execution.
 */

export class OutputInterceptor {
  private readonly originalLog = console.log;
  private readonly originalWarn = console.warn;
  private readonly originalError = console.error;
  private suppressed = false;

  /**
   * Begin suppressing background console output.
   * Worker/agent output is silently discarded.
   */
  start(): void {
    this.suppressed = true;
    this.suppress();
  }

  /** Stop suppressing — restore original console methods. */
  stop(): void {
    this.suppressed = false;
    this.restore();
  }

  /**
   * Temporarily restore console for session-owned output
   * (command handlers, banners, etc). Call suppress() after.
   */
  unsuppress(): void {
    this.restore();
  }

  /** Re-suppress after session-owned output is done. */
  suppress(): void {
    if (!this.suppressed) return;
    const noop = () => {};
    console.log = noop;
    console.warn = noop;
    console.error = noop;
  }

  /** Write directly — always works regardless of suppression state. */
  writeDirect(...args: unknown[]): void {
    this.originalLog.apply(console, args);
  }

  private restore(): void {
    console.log = this.originalLog;
    console.warn = this.originalWarn;
    console.error = this.originalError;
  }
}
