/**
 * Triage decision persistence — saves accept/skip/feedback decisions
 * to `.forge/triage.json` so future `/review` runs don't re-ask about
 * PRs that were already triaged (unless the PR's intent has changed).
 *
 * WHY persist triage:
 * - The user's `/review` triage is the human input moment. Once given,
 *   it should stick until the PR materially changes.
 * - "Materially changes" = new commits pushed (head SHA differs).
 * - Skipped PRs stay skipped until new commits appear.
 * - Accepted PRs don't need re-acceptance unless new commits appear.
 *
 * Key: `{repo}#{prNumber}` → { action, feedback?, headSha, timestamp }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface TriageRecord {
  readonly action: 'accept' | 'skip' | 'feedback';
  readonly feedback?: string;
  /** HEAD SHA at the time of triage — used to detect material changes. */
  readonly headSha: string;
  readonly timestamp: string;
}

type TriageMap = Record<string, TriageRecord>;

const TRIAGE_FILE = 'triage.json';

function triagePath(forgeRoot: string): string {
  return join(forgeRoot, TRIAGE_FILE);
}

function triageKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Load all triage records from disk. Returns empty map if file doesn't exist. */
export function loadTriageRecords(forgeRoot: string): TriageMap {
  try {
    const raw = readFileSync(triagePath(forgeRoot), 'utf-8');
    return JSON.parse(raw) as TriageMap;
  } catch {
    return {};
  }
}

/** Save triage records to disk. */
export function saveTriageRecords(forgeRoot: string, records: TriageMap): void {
  mkdirSync(forgeRoot, { recursive: true });
  writeFileSync(triagePath(forgeRoot), JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Look up an existing triage decision for a PR.
 *
 * Returns the record only if the PR's current HEAD SHA matches the
 * triage-time SHA (i.e., no new commits since triage). If the PR
 * has new commits, returns undefined — re-triage needed.
 */
export function getTriageDecision(
  forgeRoot: string,
  repo: string,
  prNumber: number,
  currentHeadSha: string,
): TriageRecord | undefined {
  const records = loadTriageRecords(forgeRoot);
  const key = triageKey(repo, prNumber);
  const record = records[key];
  if (!record) return undefined;

  // PR has new commits since triage — decision is stale
  if (record.headSha !== currentHeadSha) return undefined;

  return record;
}

/**
 * Record a triage decision for a PR.
 */
export function setTriageDecision(
  forgeRoot: string,
  repo: string,
  prNumber: number,
  action: 'accept' | 'skip' | 'feedback',
  headSha: string,
  feedback?: string,
): void {
  const records = loadTriageRecords(forgeRoot);
  const key = triageKey(repo, prNumber);
  const record: TriageRecord = {
    action,
    ...(feedback ? { feedback } : {}),
    headSha,
    timestamp: new Date().toISOString(),
  };
  // Immutable update
  const updated = { ...records, [key]: record };
  saveTriageRecords(forgeRoot, updated);
}

/**
 * Remove triage records for PRs that no longer exist (merged/closed).
 * Call periodically to prevent unbounded growth.
 */
export function pruneTriageRecords(
  forgeRoot: string,
  openPRKeys: ReadonlySet<string>,
): void {
  const records = loadTriageRecords(forgeRoot);
  const pruned: TriageMap = {};
  for (const [key, record] of Object.entries(records)) {
    if (openPRKeys.has(key)) {
      pruned[key] = record;
    }
  }
  saveTriageRecords(forgeRoot, pruned);
}
