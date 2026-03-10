/**
 * Tests for DiffRenderer — differential terminal rendering.
 *
 * Instead of clearing the screen and redrawing everything, DiffRenderer
 * compares the new frame against the previous one and only writes
 * lines that changed. Uses ANSI cursor positioning for targeted updates.
 * Falls back to full redraw if more than 50% of lines changed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DiffRenderer } from './diff-renderer.js';

describe('DiffRenderer', () => {
  let output: string;
  let writer: (data: string) => void;

  beforeEach(() => {
    output = '';
    writer = (data: string) => { output += data; };
  });

  describe('first render', () => {
    it('performs a full redraw on the first call', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1', 'Line 2', 'Line 3']);

      // First render should clear screen and write all lines
      expect(output).toContain('\x1b[H\x1b[2J');
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 2');
      expect(output).toContain('Line 3');
    });
  });

  describe('differential updates', () => {
    it('only writes changed lines on subsequent renders', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1', 'Line 2', 'Line 3']);

      // Reset output to capture only the second render
      output = '';
      renderer.render(['Line 1', 'CHANGED', 'Line 3']);

      // Should NOT contain full clear
      expect(output).not.toContain('\x1b[H\x1b[2J');
      // Should position cursor at row 2 and write the changed line
      expect(output).toContain('\x1b[2;1H');
      expect(output).toContain('CHANGED');
      // Should NOT re-write unchanged lines
      expect(output).not.toContain('Line 1');
      expect(output).not.toContain('Line 3');
    });

    it('does not write anything when frame is identical', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1', 'Line 2']);

      output = '';
      renderer.render(['Line 1', 'Line 2']);

      expect(output).toBe('');
    });

    it('handles new lines added beyond previous frame', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1']);

      output = '';
      renderer.render(['Line 1', 'Line 2', 'Line 3']);

      // Line 1 unchanged, but lines 2 and 3 are new (2 out of 3 = 67% > 50%)
      // Should fall back to full redraw
      expect(output).toContain('\x1b[H\x1b[2J');
    });

    it('handles lines removed from previous frame', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1', 'Line 2', 'Line 3']);

      output = '';
      renderer.render(['Line 1']);

      // Shrinking from 3 to 1 line — counts as 2 changed out of 3 (67% > 50%)
      // Should fall back to full redraw
      expect(output).toContain('\x1b[H\x1b[2J');
    });
  });

  describe('full redraw fallback', () => {
    it('falls back to full redraw when more than 50% of lines changed', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['A', 'B', 'C', 'D']);

      output = '';
      // Change 3 out of 4 lines = 75% > 50%
      renderer.render(['X', 'B', 'Y', 'Z']);

      expect(output).toContain('\x1b[H\x1b[2J');
    });

    it('uses diff rendering when exactly 50% of lines changed', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['A', 'B', 'C', 'D']);

      output = '';
      // Change 2 out of 4 lines = exactly 50%
      renderer.render(['X', 'B', 'C', 'Y']);

      // 50% is the boundary — should NOT trigger full redraw
      expect(output).not.toContain('\x1b[H\x1b[2J');
      expect(output).toContain('\x1b[1;1H');
      expect(output).toContain('\x1b[4;1H');
    });
  });

  describe('line clearing', () => {
    it('clears the rest of the line after writing to prevent artifacts', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      // Use enough unchanged lines so the diff path is taken (1 out of 4 = 25%)
      renderer.render(['Long line here', 'stable', 'stable2', 'stable3']);

      output = '';
      renderer.render(['Short', 'stable', 'stable2', 'stable3']);

      // When writing a shorter line via diff, should clear to end of line
      expect(output).toContain('\x1b[K');
    });
  });

  describe('resize handling', () => {
    it('forces full redraw after resize', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render(['Line 1', 'Line 2']);

      output = '';
      renderer.resize(30, 100);
      renderer.render(['Line 1', 'Line 2']);

      // Even though content is the same, resize should trigger full redraw
      expect(output).toContain('\x1b[H\x1b[2J');
    });
  });

  describe('edge cases', () => {
    it('handles empty lines array', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render([]);
      // Should still clear screen on first render
      expect(output).toContain('\x1b[H\x1b[2J');
    });

    it('handles rendering after empty frame', () => {
      const renderer = new DiffRenderer(24, 80, writer);
      renderer.render([]);

      output = '';
      renderer.render(['Line 1']);

      // Previous was empty, now has 1 line — 1 changed out of 1 = 100% > 50%
      // Full redraw
      expect(output).toContain('\x1b[H\x1b[2J');
    });

    it('truncates lines longer than terminal width', () => {
      const renderer = new DiffRenderer(24, 10, writer);
      renderer.render(['This is a very long line that exceeds width']);

      // The stored/compared line should be truncated to terminal width
      output = '';
      renderer.render(['This is a very long line that exceeds width']);

      // Same content — should produce no output
      expect(output).toBe('');
    });
  });
});
