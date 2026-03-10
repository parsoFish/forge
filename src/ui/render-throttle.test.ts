/**
 * Tests for adaptive render throttle based on memory pressure.
 *
 * The render throttle reads /proc/meminfo to determine memory usage
 * and returns an appropriate render interval:
 *   - Normal (< 75%): 2000ms
 *   - Elevated (75-85%): 4000ms
 *   - High (85-92%): 8000ms
 *   - Critical (> 92%): 15000ms
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAdaptiveIntervalMs, MemoryPressure, PRESSURE_INTERVALS } from './render-throttle.js';

// Mock fs.readFileSync to control /proc/meminfo content
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
const mockReadFileSync = vi.mocked(readFileSync);

function buildMeminfo(availableKb: number, totalKb: number): string {
  return [
    `MemTotal:       ${totalKb} kB`,
    `MemFree:        ${Math.floor(availableKb * 0.3)} kB`,
    `MemAvailable:   ${availableKb} kB`,
    `Buffers:        0 kB`,
    `Cached:         0 kB`,
  ].join('\n');
}

describe('render-throttle', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PRESSURE_INTERVALS', () => {
    it('has correct interval for normal pressure', () => {
      expect(PRESSURE_INTERVALS[MemoryPressure.Normal]).toBe(2_000);
    });

    it('has correct interval for elevated pressure', () => {
      expect(PRESSURE_INTERVALS[MemoryPressure.Elevated]).toBe(4_000);
    });

    it('has correct interval for high pressure', () => {
      expect(PRESSURE_INTERVALS[MemoryPressure.High]).toBe(8_000);
    });

    it('has correct interval for critical pressure', () => {
      expect(PRESSURE_INTERVALS[MemoryPressure.Critical]).toBe(15_000);
    });
  });

  describe('getAdaptiveIntervalMs', () => {
    it('returns 2000ms when memory usage is below 75%', () => {
      // 50% usage: 50000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(50_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(2_000);
    });

    it('returns 4000ms when memory usage is between 75% and 85%', () => {
      // 80% usage: 20000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(20_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(4_000);
    });

    it('returns 8000ms when memory usage is between 85% and 92%', () => {
      // 90% usage: 10000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(10_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(8_000);
    });

    it('returns 15000ms when memory usage exceeds 92%', () => {
      // 95% usage: 5000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(5_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(15_000);
    });

    it('returns 2000ms (default) when /proc/meminfo cannot be read', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(getAdaptiveIntervalMs()).toBe(2_000);
    });

    it('returns 2000ms when /proc/meminfo has unexpected format', () => {
      mockReadFileSync.mockReturnValue('some garbage content');
      expect(getAdaptiveIntervalMs()).toBe(2_000);
    });

    it('returns 4000ms at exactly 75% usage boundary', () => {
      // Exactly 75% usage: 25000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(25_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(4_000);
    });

    it('returns 8000ms at exactly 85% usage boundary', () => {
      // Exactly 85% usage: 15000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(15_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(8_000);
    });

    it('returns 15000ms at exactly 92% usage boundary', () => {
      // Exactly 92% usage: 8000 available out of 100000 total
      mockReadFileSync.mockReturnValue(buildMeminfo(8_000, 100_000));
      expect(getAdaptiveIntervalMs()).toBe(15_000);
    });

    it('handles MemTotal of zero gracefully', () => {
      mockReadFileSync.mockReturnValue(buildMeminfo(0, 0));
      expect(getAdaptiveIntervalMs()).toBe(2_000);
    });
  });
});
