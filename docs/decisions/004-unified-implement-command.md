# ADR-004: Unified /implement Command

**Status:** Proposed
**Date:** 2026-03-10
**Deciders:** User + Forge

## Context

The current workflow requires multiple manual steps to go from roadmap to running code:

1. `/roadmap <project>` — Interactive, works well
2. `/plan <project>` — Posts planning jobs
3. `/worker on` — Enables the worker
4. `/implement <project>` — Posts implementation jobs
5. Worker processes jobs autonomously
6. If crash → manual `/retry`, figure out what phase we were in, re-run

This creates friction and brittleness:
- User must remember the sequence
- If the system crashes mid-implement, restart doesn't know to skip plan (already done)
- No structured framework for how jobs layer on each other
- Worker resource self-awareness is minimal (doesn't consider its own overhead)

### Problem Statement

1. **Too many commands** for what should be a single "go build this" action
2. **No phase memory** — crash recovery doesn't know which phases completed
3. **No job layering awareness** — worker treats all jobs equally, no understanding of dependency chains
4. **Worker overhead not accounted for** — the worker itself consumes memory but doesn't budget for it

## Decision

Replace `/design`, `/plan`, `/implement` + manual `/worker on` with a single **`/implement`** command that orchestrates the full pipeline with phase-aware state tracking and crash recovery.

### Design

#### 1. Implementation Session State

```typescript
interface ImplementSession {
  id: string;                          // Unique session ID
  project: string;
  startedAt: string;
  phase: 'planning' | 'implementing' | 'testing' | 'reviewing';
  planCompleted: boolean;
  workItemsCreated: string[];          // IDs of work items spawned
  workItemsCompleted: string[];        // IDs completed
  workItemsFailed: string[];           // IDs failed (with reasons)
  recoveredFrom?: string;             // Previous session ID if this is a recovery
  crashLog?: string;                  // What went wrong if recovered
}
```

Persisted to `.forge/sessions/<id>.json`. On crash recovery, the newest incomplete session is loaded and resumed from its last known phase.

#### 2. Command Flow

```
/implement <project>
  │
  ├─ Check for incomplete session → RESUME if found
  │    └─ "Found incomplete session from 2h ago (phase: implementing, 12/20 items done). Resume? [Y/n]"
  │
  ├─ Check for existing roadmap → REQUIRE if missing
  │    └─ "No roadmap found for trafficGame. Run /roadmap first."
  │
  ├─ Phase 1: PLAN (if not already done)
  │    ├─ Post plan job, auto-enable worker
  │    ├─ Wait for plan to complete
  │    ├─ Mark session.planCompleted = true
  │    └─ Print summary: "Created 15 work items for trafficGame"
  │
  ├─ Phase 2: IMPLEMENT (auto-starts)
  │    ├─ Post work-item jobs with resource requests
  │    ├─ Respect dependency ordering (dependsOn chains)
  │    ├─ Worker processes autonomously
  │    ├─ Session tracks completion in real-time
  │    └─ On all items done → open PRs for each
  │
  └─ DONE
       └─ Print summary: "All features implemented and PRs opened. Run /review to triage."
```

**Important phase boundary:** `/implement` stops after opening PRs. It does NOT review, fix, or merge them. That's the responsibility of `/review`, which is a separate phase with its own goal: closing PRs in dependency order, gathering human direction, and driving the autonomous review→fix loop. This separation is intentional:

- **`/implement` goal:** Complete and test all features, open PRs for each
- **`/review` goal:** Close PRs in dependency order with human oversight

The review phase will be redesigned in a future iteration to replace `/fix` and `/fix-all` with a structured PR-closing pipeline that presents PRs to the user in dependency order and autonomously works to merge them.
```

#### 3. Worker Auto-Management

`/implement` automatically enables the worker. No separate `/worker on` step.
The worker self-manages:
- Starts when `/implement` is called
- Pauses on rate limit (existing behavior)
- Stops when all jobs for the session are complete
- Budgets its own overhead (~200MB) before scheduling agents

#### 4. Job Layering

Work items have `dependsOn` relationships. The implement session ensures:
- Items with no dependencies are queued first
- Items with dependencies are queued only after their dependencies complete
- Failed dependencies block their dependents (marked `blocked`)
- The session re-evaluates the queue after each completion

```
Layer 0: [Setup ESLint] [Add types]           ← queued immediately
Layer 1: [Build UI component] [Add API]       ← queued after Layer 0 done
Layer 2: [Integration tests] [E2E flow]       ← queued after Layer 1 done
```

#### 5. Crash Recovery

On `/implement <project>` with an existing incomplete session:

1. **Load session state** from `.forge/sessions/<id>.json`
2. **Skip completed phases** — if plan is done, don't re-plan
3. **Identify failure point** — which work item was running when crash occurred?
4. **Analyze failure** — was it OOM? Rate limit? Bug in agent? Log the diagnosis
5. **Re-queue from failure point** — don't restart from scratch
6. **Add learning** — "trafficGame build OOMs at 1.2GB" feeds into resource profiler

#### 6. Self-Priority Awareness

The implement session's orchestration logic runs in the main forge process, not as a job. This means:
- It doesn't compete with agents for resources
- It can observe and react to resource pressure in real-time
- It can pause job dispatch without going through the queue

#### 7. Removed Commands

- `/design` — Absorbed into `/implement` (planning phase includes design analysis)
- `/plan` — Absorbed into `/implement`
- `/worker on|off` — Worker auto-managed by `/implement`. Manual control preserved as `/worker` for debugging but not part of normal flow.

## Consequences

### Positive
- Single command for the full pipeline
- Crash recovery is automatic and phase-aware
- Dependency-aware job layering prevents wasted work
- Worker lifecycle is managed, not manual

### Negative
- More state to track (session files)
- More complex orchestration logic in the main process
- `/plan` as standalone command may still be wanted for dry-runs

### Migration

- Keep `/plan` as a standalone command for dry-run/preview
- `/implement` calls plan internally if needed
- Existing job types unchanged — this is orchestration-level, not agent-level
- Session state is new — no migration needed, just new files

## Implementation Plan

1. Create `ImplementSession` type and persistence in `src/state/`
2. Create `src/workflow/stages/implement-session.ts` — the orchestration loop
3. Update `/implement` command handler to use session-based flow
4. Add crash detection: check for incomplete sessions on startup
5. Add dependency-layer job posting
6. Auto-enable worker within session
7. Add session summary on completion
8. Update help text and remove `/design`
