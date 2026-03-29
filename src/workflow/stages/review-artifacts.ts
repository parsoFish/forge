/**
 * Review artifacts — persisted data from the review phase.
 *
 * WHY artifacts:
 * Information useful across multiple phases should be generated once and
 * carried through as an artifact. The PR dependency order (merge layers,
 * chain info) is computed from git history during the scan phase and
 * persisted here so the interactive session doesn't re-derive it.
 *
 * Storage: `.forge/review-artifacts/<project>/pr-scan.json`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenPR, FileOwnershipMap } from './review-prs.js';

const ARTIFACTS_DIR = 'review-artifacts';

/** Serializable form of the file ownership map (Maps → plain objects). */
interface SerializedFileOwnership {
  readonly overlappingFiles: Record<string, readonly number[]>;
  readonly prFiles: Record<string, readonly string[]>;
}

/** Persisted PR scan result — dependency order and chain info. */
export interface PRScanArtifact {
  /** When the scan was performed. */
  readonly scannedAt: string;
  /** The PRs with their dependency order, merge layers, and chain info. */
  readonly prs: readonly OpenPR[];
  /** File ownership data — which PRs touch which files. */
  readonly fileOwnership?: SerializedFileOwnership;
}

/** Save a PR scan result as an artifact, optionally with file ownership data. */
export function savePRScanArtifact(
  forgeRoot: string,
  project: string,
  prs: readonly OpenPR[],
  fileOwnership?: FileOwnershipMap,
): void {
  const dir = join(forgeRoot, ARTIFACTS_DIR, project);
  mkdirSync(dir, { recursive: true });

  const serializedOwnership: SerializedFileOwnership | undefined = fileOwnership
    ? {
      overlappingFiles: Object.fromEntries(fileOwnership.overlappingFiles),
      prFiles: Object.fromEntries(fileOwnership.prFiles),
    }
    : undefined;

  const artifact: PRScanArtifact = {
    scannedAt: new Date().toISOString(),
    prs,
    fileOwnership: serializedOwnership,
  };
  writeFileSync(join(dir, 'pr-scan.json'), JSON.stringify(artifact, null, 2));
}

/** Load a persisted PR scan artifact. Returns null if not found. */
export function loadPRScanArtifact(forgeRoot: string, project: string): PRScanArtifact | null {
  const path = join(forgeRoot, ARTIFACTS_DIR, project, 'pr-scan.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PRScanArtifact;
  } catch {
    return null;
  }
}

/** Load file ownership map from persisted artifact. Returns null if not available. */
export function loadFileOwnership(forgeRoot: string, project: string): FileOwnershipMap | null {
  const artifact = loadPRScanArtifact(forgeRoot, project);
  if (!artifact?.fileOwnership) return null;

  const { overlappingFiles, prFiles } = artifact.fileOwnership;

  const overlapMap = new Map<string, readonly number[]>();
  for (const [file, owners] of Object.entries(overlappingFiles)) {
    overlapMap.set(file, [...owners]);
  }

  const prFileMap = new Map<number, readonly string[]>();
  for (const [prNum, files] of Object.entries(prFiles)) {
    prFileMap.set(Number(prNum), [...files]);
  }

  return {
    fileOwners: new Map(), // Not persisted — only needed during scan
    overlappingFiles: overlapMap,
    prFiles: prFileMap,
  };
}
