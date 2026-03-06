/**
 * File-based state management for work items, roadmaps, and decisions.
 *
 * Follows Ralph's principle: disk is state, git is memory.
 * State is stored as JSON files in .forge/ — simple, inspectable, diffable.
 *
 * Work items are organized as:
 *   .forge/work-items/<project>/<seq>-<slug>.json
 *
 * This makes it easy to browse at a glance — you can see both the project
 * and a human-readable summary from the filename alone.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import type { WorkItem, DesignBrief, Roadmap, PhaseState, OrchestratorPhase } from '../workflow/types.js';

const FORGE_DIR = '.forge';
const WORK_ITEMS_DIR = 'work-items';
const DESIGNS_DIR = 'designs';
const ROADMAPS_DIR = 'roadmaps';
const DECISIONS_FILE = 'decisions.md';
const RESEARCH_DIR = 'research';
const LEARNINGS_DIR = 'learnings';
const PHASE_FILE = 'phase.json';

export class StateStore {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot, FORGE_DIR);
    this.ensureDirs();
  }

  // --- Phase State ---

  getPhase(): PhaseState {
    const path = join(this.root, PHASE_FILE);
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8')) as PhaseState;
      } catch {
        // Corrupted — default
      }
    }
    return {
      currentPhase: 'roadmapping',
      enteredAt: new Date().toISOString(),
      notes: '',
    };
  }

  setPhase(phase: OrchestratorPhase, notes = ''): PhaseState {
    const state: PhaseState = {
      currentPhase: phase,
      enteredAt: new Date().toISOString(),
      notes,
    };
    writeFileSync(join(this.root, PHASE_FILE), JSON.stringify(state, null, 2));
    return state;
  }

  // --- Work Items ---

  /**
   * List all work items across all projects.
   * Scans .forge/work-items/<project>/ directories.
   */
  listWorkItems(): WorkItem[] {
    const dir = join(this.root, WORK_ITEMS_DIR);
    if (!existsSync(dir)) return [];

    const items: WorkItem[] = [];

    // Support new layout: work-items/<project>/<seq>-<slug>.json
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const projectDir = join(dir, entry.name);
        for (const file of readdirSync(projectDir).filter((f) => f.endsWith('.json'))) {
          try {
            items.push(JSON.parse(readFileSync(join(projectDir, file), 'utf-8')) as WorkItem);
          } catch { /* skip corrupted */ }
        }
      } else if (entry.name.endsWith('.json')) {
        // Legacy flat layout: work-items/<guid>.json — read and migrate
        try {
          const item = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8')) as WorkItem;
          items.push(item);
        } catch { /* skip corrupted */ }
      }
    }

    return items.sort((a, b) => {
      // Sort by project, then by seq (if present), then by createdAt
      if (a.project !== b.project) return a.project.localeCompare(b.project);
      const aSeq = (a as WorkItem).seq ?? 0;
      const bSeq = (b as WorkItem).seq ?? 0;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  getWorkItem(id: string): WorkItem | null {
    // Try new layout: id might be like "trafficGame/003-eslint-prettier"
    // or legacy flat guid like "3e18c71d"
    const items = this.listWorkItems();
    return items.find((item) => item.id === id) ?? null;
  }

  saveWorkItem(item: WorkItem): void {
    const projectDir = join(this.root, WORK_ITEMS_DIR, item.project);
    mkdirSync(projectDir, { recursive: true });

    const slug = this.slugify(item.title);
    const seq = String(item.seq ?? 0).padStart(3, '0');
    const filename = `${seq}-${slug}.json`;
    const path = join(projectDir, filename);

    item.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(item, null, 2));
  }

  getWorkItemsByProject(project: string): WorkItem[] {
    return this.listWorkItems().filter((item) => item.project === project);
  }

  getWorkItemsByStage(stage: string): WorkItem[] {
    return this.listWorkItems().filter((item) => item.stage === stage);
  }

  /**
   * Get the next sequence number for work items in a project.
   */
  nextSeq(project: string): number {
    const items = this.getWorkItemsByProject(project);
    if (items.length === 0) return 1;
    const maxSeq = Math.max(...items.map((i) => i.seq ?? 0));
    return maxSeq + 1;
  }

  /**
   * Migrate legacy flat work items to the new project/<seq>-<slug> layout.
   * Called once on startup; idempotent.
   */
  migrateLegacyWorkItems(): number {
    const dir = join(this.root, WORK_ITEMS_DIR);
    if (!existsSync(dir)) return 0;

    let migrated = 0;
    const seqCounters: Record<string, number> = {};

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      try {
        const oldPath = join(dir, entry.name);
        const item = JSON.parse(readFileSync(oldPath, 'utf-8')) as WorkItem;

        // Assign seq if missing
        if (!item.seq) {
          seqCounters[item.project] = (seqCounters[item.project] ?? 0) + 1;
          (item as { seq: number }).seq = seqCounters[item.project];
        }

        // Save in new location
        this.saveWorkItem(item);

        // Remove the old flat file
        unlinkSync(oldPath);
        migrated++;
      } catch { /* skip corrupted */ }
    }

    return migrated;
  }

  // --- Roadmaps ---

  saveRoadmap(roadmap: Roadmap): void {
    const dir = join(this.root, ROADMAPS_DIR);
    mkdirSync(dir, { recursive: true });
    roadmap.updatedAt = new Date().toISOString();
    writeFileSync(join(dir, `${roadmap.project}.json`), JSON.stringify(roadmap, null, 2));
  }

  getRoadmap(project: string): Roadmap | null {
    const path = join(this.root, ROADMAPS_DIR, `${project}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as Roadmap;
  }

  listRoadmaps(): Roadmap[] {
    const dir = join(this.root, ROADMAPS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Roadmap);
  }

  // --- Design Briefs ---

  saveDesignBrief(brief: DesignBrief): void {
    const dir = join(this.root, DESIGNS_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${brief.project}.json`);
    writeFileSync(path, JSON.stringify(brief, null, 2));
  }

  getDesignBrief(project: string): DesignBrief | null {
    const path = join(this.root, DESIGNS_DIR, `${project}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as DesignBrief;
  }

  // --- Decision Log ---

  logDecision(decision: {
    title: string;
    chosen: string;
    alternatives: string[];
    reasoning: string;
    confidence: number;
  }): void {
    const path = join(this.root, DECISIONS_FILE);
    const timestamp = new Date().toISOString();
    const entry = [
      `## ${decision.title} (${timestamp})`,
      `- **Chosen:** ${decision.chosen}`,
      `- **Confidence:** ${decision.confidence}/100`,
      `- **Alternatives:** ${decision.alternatives.join(', ')}`,
      `- **Reasoning:** ${decision.reasoning}`,
      '',
    ].join('\n');

    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '# Decision Log\n\n';
    writeFileSync(path, existing + entry + '\n');
  }

  // --- Research ---

  saveResearch(topic: string, content: string): void {
    const dir = join(this.root, RESEARCH_DIR);
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `${timestamp}_${this.slugify(topic)}.md`);
    writeFileSync(path, content);
  }

  listResearch(): string[] {
    const dir = join(this.root, RESEARCH_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  }

  // --- Learnings ---

  saveLearning(content: string): void {
    const dir = join(this.root, LEARNINGS_DIR);
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `${timestamp}_reflection.md`);
    writeFileSync(path, content);
  }

  listLearnings(): string[] {
    const dir = join(this.root, LEARNINGS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  }

  getLatestLearning(): string | null {
    const learnings = this.listLearnings();
    if (learnings.length === 0) return null;
    const latest = learnings.sort().pop()!;
    return readFileSync(join(this.root, LEARNINGS_DIR, latest), 'utf-8');
  }

  // --- State Summary ---

  summary(): {
    totalWorkItems: number;
    byStage: Record<string, number>;
    byStatus: Record<string, number>;
    byProject: Record<string, number>;
    pendingReview: number;
  } {
    const items = this.listWorkItems();
    const byStage: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let pendingReview = 0;

    for (const item of items) {
      byStage[item.stage] = (byStage[item.stage] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      byProject[item.project] = (byProject[item.project] ?? 0) + 1;
      if (item.needsHumanReview) pendingReview++;
    }

    return { totalWorkItems: items.length, byStage, byStatus, byProject, pendingReview };
  }

  // --- Internal ---

  private ensureDirs(): void {
    for (const dir of [WORK_ITEMS_DIR, DESIGNS_DIR, ROADMAPS_DIR, RESEARCH_DIR, LEARNINGS_DIR]) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }
  }

  /** Convert a title to a filesystem-safe slug */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }
}
