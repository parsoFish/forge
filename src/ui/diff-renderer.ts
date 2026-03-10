/**
 * Differential terminal renderer — writes only changed lines.
 *
 * WHY: Full screen clears (`\x1b[H\x1b[2J`) followed by complete redraws
 * cause visible flicker in tmux, especially under memory pressure when
 * GC pauses delay output. By comparing each frame against the previous
 * one and only writing lines that changed, we reduce both terminal output
 * volume and visual disruption.
 *
 * Falls back to a full redraw when more than 50% of lines changed,
 * since the overhead of many individual cursor-position writes exceeds
 * a single clear+redraw at that point.
 */

/** ANSI escape: move cursor to row,col 1-indexed */
const cursorTo = (row: number): string => `\x1b[${row};1H`;

/** ANSI escape: clear from cursor to end of line */
const CLEAR_EOL = '\x1b[K';

/** ANSI escape: clear entire screen and move cursor to top-left */
const CLEAR_SCREEN = '\x1b[H\x1b[2J';

/** Threshold: if more than this fraction of lines changed, do a full redraw */
const DIFF_THRESHOLD = 0.5;

export class DiffRenderer {
  private cols: number;
  private readonly writer: (data: string) => void;
  private previousFrame: readonly string[] = [];
  private forceFullRedraw = true;

  constructor(_rows: number, cols: number, writer: (data: string) => void) {
    this.cols = cols;
    this.writer = writer;
  }

  /**
   * Update terminal dimensions. Forces a full redraw on the next
   * render call since line wrapping may have changed.
   */
  resize(_rows: number, cols: number): void {
    if (cols !== this.cols) {
      this.cols = cols;
      this.forceFullRedraw = true;
      return;
    }
    // Even if only rows changed, force redraw for safety
    this.forceFullRedraw = true;
  }

  /**
   * Render a frame of lines to the terminal.
   * Computes a diff against the previous frame and writes only
   * changed lines, or falls back to a full redraw if too many changed.
   */
  render(lines: readonly string[]): void {
    const truncated = lines.map((line) => this.truncateLine(line));

    if (this.forceFullRedraw) {
      this.fullRedraw(truncated);
      this.previousFrame = truncated;
      this.forceFullRedraw = false;
      return;
    }

    const maxLen = Math.max(truncated.length, this.previousFrame.length);

    // No lines at all — nothing to do
    if (maxLen === 0) return;

    // Count changed lines (including added/removed)
    let changedCount = 0;
    const changedIndices: number[] = [];

    for (let i = 0; i < maxLen; i++) {
      const prev = i < this.previousFrame.length ? this.previousFrame[i] : undefined;
      const next = i < truncated.length ? truncated[i] : undefined;

      if (prev !== next) {
        changedCount++;
        changedIndices.push(i);
      }
    }

    // No changes — skip entirely
    if (changedCount === 0) {
      return;
    }

    // Too many changes — full redraw is cheaper
    if (changedCount / maxLen > DIFF_THRESHOLD) {
      this.fullRedraw(truncated);
      this.previousFrame = truncated;
      return;
    }

    // Diff render: write only changed lines
    let buf = '';
    for (const idx of changedIndices) {
      const row = idx + 1; // ANSI rows are 1-indexed
      const line = idx < truncated.length ? truncated[idx] : '';
      buf += cursorTo(row) + line + CLEAR_EOL;
    }
    this.writer(buf);
    this.previousFrame = truncated;
  }

  private fullRedraw(lines: readonly string[]): void {
    let buf = CLEAR_SCREEN;
    for (const line of lines) {
      buf += line + '\n';
    }
    this.writer(buf);
  }

  private truncateLine(line: string): string {
    if (line.length <= this.cols) return line;
    return line.slice(0, this.cols);
  }
}
