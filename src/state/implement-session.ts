/**
 * Implement session — phase-aware state tracking for the unified /implement command.
 *
 * WHY this exists:
 * Previously, /plan, /implement, and /worker on were separate commands. If the
 * system crashed mid-implement, restart didn't know which phases completed.
 * Users had to manually figure out where things left off.
 *
 * An ImplementSession tracks the full pipeline:
 *   plan → implement → review
 *
 * It persists to `.forge/sessions/<id>.json` so crash recovery can resume
 * from the exact failure point without redoing completed work.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The phase within an implement session (not the orchestrator phase).
 *
 * /implement stops after 'implementing' (PRs opened). Review/merge is a
 * separate phase owned by /review.
 */
export type SessionPhase = 'planning' | 'implementing' | 'completed';

export interface ImplementSession {
  /** Unique session ID */
  readonly id: string;

  /** Project being implemented */
  readonly project: string;

  /** When the session started */
  readonly startedAt: string;

  /** Current phase within the session */
  phase: SessionPhase;

  /** Whether planning has completed */
  planCompleted: boolean;

  /** Work item IDs created during planning */
  workItemsCreated: readonly string[];

  /** Work item IDs that have completed their full pipeline */
  workItemsCompleted: readonly string[];

  /** Work item IDs that failed (with reasons) */
  workItemsFailed: readonly string[];

  /** If this session was recovered from a crashed previous session */
  recoveredFrom?: string;

  /** Crash diagnosis if this was a recovery */
  crashLog?: string;

  /** When the session last updated */
  updatedAt: string;
}

const SESSIONS_DIR = 'sessions';

/**
 * Persistence layer for implement sessions.
 *
 * Sessions are stored as individual JSON files:
 *   .forge/sessions/<id>.json
 */
export class ImplementSessionStore {
  private readonly sessionsDir: string;

  constructor(forgeRoot: string) {
    this.sessionsDir = join(forgeRoot, SESSIONS_DIR);
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  /**
   * Create a new implement session for a project.
   */
  create(project: string): ImplementSession {
    const id = `${project}-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const session: ImplementSession = {
      id,
      project,
      startedAt: new Date().toISOString(),
      phase: 'planning',
      planCompleted: false,
      workItemsCreated: [],
      workItemsCompleted: [],
      workItemsFailed: [],
      updatedAt: new Date().toISOString(),
    };
    this.save(session);
    return session;
  }

  /**
   * Find the most recent incomplete session for a project.
   * Returns null if no incomplete session exists.
   */
  findIncomplete(project: string): ImplementSession | null {
    const sessions = this.listForProject(project)
      .filter(s => s.phase !== 'completed')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return sessions[0] ?? null;
  }

  /**
   * Load a session by ID.
   */
  load(id: string): ImplementSession | null {
    const path = this.sessionPath(id);
    if (!existsSync(path)) return null;

    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ImplementSession;
    } catch {
      return null;
    }
  }

  /**
   * Save/update a session.
   */
  save(session: ImplementSession): void {
    const updated: ImplementSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      this.sessionPath(session.id),
      JSON.stringify(updated, null, 2) + '\n',
    );
  }

  /**
   * List all sessions for a project, sorted by start time (newest first).
   */
  listForProject(project: string): readonly ImplementSession[] {
    if (!existsSync(this.sessionsDir)) return [];

    return readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.json') && f.startsWith(`${project}-`))
      .map(f => {
        try {
          return JSON.parse(
            readFileSync(join(this.sessionsDir, f), 'utf-8'),
          ) as ImplementSession;
        } catch {
          return null;
        }
      })
      .filter((s): s is ImplementSession => s !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Mark a session as completed.
   */
  complete(session: ImplementSession): void {
    this.save({ ...session, phase: 'completed' });
  }

  /**
   * Create a recovery session that links back to the crashed session.
   */
  recover(crashed: ImplementSession, crashLog: string): ImplementSession {
    const recovered = this.create(crashed.project);
    const withRecovery: ImplementSession = {
      ...recovered,
      recoveredFrom: crashed.id,
      crashLog,
      // Carry forward completed state
      planCompleted: crashed.planCompleted,
      phase: crashed.planCompleted ? 'implementing' : 'planning',
      workItemsCreated: [...crashed.workItemsCreated],
      workItemsCompleted: [...crashed.workItemsCompleted],
      workItemsFailed: [],  // Reset failures — they'll be re-evaluated
    };
    this.save(withRecovery);

    // Mark the crashed session as completed (it's been superseded)
    this.complete(crashed);

    return withRecovery;
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }
}
