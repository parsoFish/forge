/**
 * Single source of truth for the forge version — reads from package.json.
 *
 * Semver strategy:
 * - PATCH (0.5.x): any commit, increments freely
 * - MINOR (0.x.0): meaningful feature merges to main (PR close)
 * - MAJOR (x.0.0): breaking changes only
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = loadVersion();
