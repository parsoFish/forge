/**
 * Simple counting semaphore for limiting concurrency.
 *
 * Used by the orchestrator to ensure at most N work item pipelines
 * (each containing multiple sequential agent calls) run at once.
 */

export class Semaphore {
  private current = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /**
   * Acquire a slot. Blocks if at capacity.
   */
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  /**
   * Release a slot, allowing a waiting task to proceed.
   */
  release(): void {
    this.current--;
    const next = this.waiting.shift();
    if (next) next();
  }

  /** Number of active slots. */
  get active(): number { return this.current; }

  /** Number of tasks waiting for a slot. */
  get queued(): number { return this.waiting.length; }
}
