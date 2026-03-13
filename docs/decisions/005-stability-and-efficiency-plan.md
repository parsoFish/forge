# Plan: Stability & Efficiency Improvements

**Date:** 2026-03-10
**Context:** Post-Cycle-2 learnings — system crashes, memory leaks, UI instability, git waste

## Work Streams Overview

| WS | Title | Priority | Effort | Dependency |
|----|-------|----------|--------|------------|
| 1 | TrafficGame memory leaks | P0 | Medium | None |
| 2 | Process isolation (cgroups) | P1 | Large | None |
| 3 | tmux UI stability | P2 | Small | Partially WS2 |
| 4 | Git operations automation | P2 | Medium | None |
| 5 | Unified /implement command | P1 | Large | None |
| 6 | Crash recovery improvements | P1 | Medium | WS5 |

---

## WS1: TrafficGame Memory Leaks

**Goal:** Fix the memory issues in trafficGame that contributed to system crashes, AND ensure forge properly elevates such issues when detected.

### Analysis

Found several memory hotspots in trafficGame:

| Issue | Severity | Fix |
|-------|----------|-----|
| A* pathfinding uses `sort()` on every iteration | CRITICAL | Replace with binary heap priority queue |
| `predictedCongestion` Map allocated every frame (60fps) | HIGH | Lazy allocate, reuse/clear |
| `vehiclesByRoad` Map allocated every frame in `updateSpeeds` | HIGH | Reuse Map, `.clear()` between frames |
| Pathfinding helper collections (Maps/Sets) per call | HIGH | Pool pathfinding state objects |
| Global `window.resize` listener never removed | MEDIUM | Clean up in `destroy()` |
| UndoManager deep clones all state per snapshot | MEDIUM | Structural sharing or delta encoding |
| jsdom test environment + parallel forks | MEDIUM | Add afterEach cleanup, consider happy-dom |

### Issue Elevation (Forge-side)

The system didn't elevate the memory issue as a priority work item. Two fixes needed:

1. **Resource profiler should flag project-specific patterns.** If trafficGame builds consistently hit high memory, the profiler should emit a warning event that gets picked up by the planner.

2. **Add a `priority: critical` tier to work items.** Currently work items have `high/medium/low` from roadmap milestones. A `critical` tier should be auto-assigned when:
   - A work item's job was OOM-killed (from cgroup data in WS2)
   - A work item caused a system health check failure
   - A work item failed 2+ times with resource-related errors

### Implementation Order
1. Fix the binary heap (biggest single win)
2. Fix per-frame Map allocations (Game.ts, RoadSegmentMetrics.ts)
3. Fix window.resize listener leak
4. Add critical priority tier to forge work items
5. Add profiler → planner elevation for resource patterns

---

## WS2: Process Isolation — Cgroup-Style Resource Limits

**Full ADR:** [003-process-isolation-resource-limits.md](./003-process-isolation-resource-limits.md)

### Implementation Steps

1. **Detect cgroup v2 availability**
   - Check `/sys/fs/cgroup/cgroup.controllers` exists
   - Check if user has delegated cgroup access
   - Graceful fallback if not available

2. **Create `ProcessIsolation` class** (`src/monitor/process-isolation.ts`)
   - `createCgroup(jobId, limits)` → creates cgroup directory, sets memory.max/high
   - `spawnInCgroup(jobId, command, args)` → wraps child_process.spawn
   - `readMemoryCurrent(jobId)` → reads memory.current for observability
   - `destroyCgroup(jobId)` → cleanup on job completion
   - `killCgroup(jobId)` → emergency kill all processes in cgroup

3. **Integrate into agent runner**
   - `runAgent()` accepts optional `ResourceRequest`
   - Worker passes request based on job type
   - Agent process spawned inside cgroup

4. **Add PSI (Pressure Stall Information) reading**
   - Read `/proc/pressure/memory` for `some` and `full` stall metrics
   - More accurate than MemAvailable for WSL2
   - Factor into health check alongside existing metrics

5. **Graceful shedding**
   - New method on Worker: `shedLoad()`
   - Called when PSI `full` > threshold OR memory < emergency floor
   - Kills biggest-memory cgroup first (build/test slots are expendable)
   - Re-queues the killed job with `OOM_SHED` status

6. **Monitor pane updates**
   - Show per-job memory in the actions pane
   - Show PSI metrics in the monitor pane

### Estimated Scope
- New file: `src/monitor/process-isolation.ts` (~200 lines)
- Modified: `src/agents/runner.ts`, `src/jobs/worker.ts`, `src/monitor/resource-monitor.ts`
- Modified: `src/ui/pane-monitor.ts`, `src/ui/pane-actions.ts`

---

## WS3: tmux UI Stability Under Memory Pressure

**Goal:** Stop the pane flickering and visual corruption observed during high memory usage.

### Root Cause Analysis

The right-side panes (queue, actions, monitor) each run as separate `forge watch:*` processes. Each:
- Runs a full Node.js process
- Reads files every 2 seconds
- Renders ANSI output to the terminal

Under memory pressure:
- Node.js GC pauses cause render stuttering
- Multiple processes fighting for memory fragments the available memory further
- tmux itself can struggle with rapid ANSI output when the terminal is under load

### Fixes

1. **Consolidate watch panes into a single process**
   - Instead of 3 separate Node.js processes, run one `forge watch` process
   - Single process renders all 3 panes via tmux `send-keys` or direct pane writes
   - Reduces Node.js overhead from ~120MB (3×40MB) to ~50MB (1×50MB)

2. **Throttle render rate under pressure**
   - Normal: render every 2s
   - When memory > 80%: render every 5s
   - When memory > 90%: render every 10s (or pause)
   - Reduces both CPU and memory churn during critical periods

3. **Use cursor-addressed updates instead of full redraws**
   - Current: clear screen + redraw everything
   - Better: diff the output, only update changed lines
   - Less ANSI traffic = less tmux rendering work

4. **Add process priority**
   - Set `nice` value on watch processes (lower priority than agents)
   - Agents doing real work should win CPU fights over UI rendering

### Implementation
- New: `src/ui/unified-watcher.ts` (consolidates pane-queue, pane-actions, pane-monitor)
- Modified: `src/ui/tmux-launcher.ts` (launch single watcher instead of 3)
- Modified: `src/cli.ts` (new `forge watch` command replacing individual watch:* commands)

---

## WS4: Git Operations Automation

**Goal:** Eliminate redundant git operations, establish a traditional (non-inference) git workflow automation layer.

### Problem

450 clones of GitWeave in a few days. Agents shouldn't be cloning — they should be working in the local checkout. Investigation shows the forge agents themselves don't clone (they use `cwd` pointed at `projects/<name>/`), but the Claude Code SDK's `isolation: "worktree"` feature creates worktrees which may trigger git operations that look like clones in GitHub traffic.

### Design: Git Workflow Automation Layer

Create a deterministic (non-inference) automation layer for common git operations:

```typescript
// src/git/workflow.ts — traditional automation, no LLM inference needed

interface GitWorkflow {
  // Branch management
  createFeatureBranch(project: string, workItemId: string): Promise<string>;
  checkoutBranch(project: string, branch: string): Promise<void>;

  // PR lifecycle
  createPR(project: string, branch: string, title: string, body: string): Promise<number>;
  mergePR(project: string, prNumber: number, strategy: 'squash' | 'merge'): Promise<void>;

  // Cleanup
  cleanupAfterMerge(project: string, prNumber: number): Promise<void>;
  // → delete local branch, delete remote branch, pull main

  // Sync
  syncMain(project: string): Promise<void>;
  // → checkout main, pull, prune remote branches

  // Dependency chains
  getWorkItemDependencyOrder(project: string): Promise<string[]>;
  // → topological sort of work items by dependsOn
}
```

### Key Principles

1. **No cloning.** Projects are local. Period.
2. **Branch naming is deterministic.** `feat/<project>-<seq>-<slug>` from work item ID.
3. **Cleanup is automated.** After PR merge: delete local branch, pull squash commit to main.
4. **Dependency ordering is traditional.** Topological sort of `dependsOn` graph — no inference needed.
5. **State is on disk.** Branch ↔ work item mapping stored in work item JSON.
6. **Agents use the automation.** Instead of agents running raw git commands via inference, the workflow stage calls `gitWorkflow.createFeatureBranch()` before spawning the agent.

### Benefits
- Consistent branch naming (no agent creativity in branch names)
- Guaranteed cleanup (no orphaned branches)
- Dependency chains resolved by graph algorithm, not agent inference
- Auditable: every git operation logged to events
- Evolvable: users can customize the workflow (branch prefix, merge strategy)

### Implementation
- New: `src/git/workflow.ts` (~250 lines)
- New: `src/git/branch-naming.ts` (~50 lines)
- Modified: `src/workflow/stages/test.ts` (use gitWorkflow.createFeatureBranch)
- Modified: `src/workflow/stages/pr.ts` (use gitWorkflow.createPR)
- Modified: `src/workflow/stages/review-prs.ts` (use gitWorkflow.cleanupAfterMerge)
- Modified: Agent prompts in `agents/*.md` (remove git command instructions, agents receive pre-checked-out branch)

---

## WS5: Unified /implement Command

**Full ADR:** [004-unified-implement-command.md](./004-unified-implement-command.md)

### Implementation Steps

1. **Create ImplementSession type and persistence**
   - `src/state/implement-session.ts`
   - File-based: `.forge/sessions/<id>.json`
   - Methods: `create()`, `load()`, `update()`, `findIncomplete(project)`

2. **Create implement session orchestration loop**
   - `src/workflow/stages/implement-session.ts`
   - Phases: plan → implement → review
   - Each phase checks session state before starting
   - Updates session state as phases complete

3. **Update /implement command handler**
   - Check for incomplete session → offer resume
   - Check for roadmap → require if missing
   - Create session → start orchestration loop
   - Auto-enable worker

4. **Dependency-layer job posting**
   - Topological sort work items by `dependsOn`
   - Assign layers (0 = no deps, 1 = depends on layer 0, etc.)
   - Queue layer 0 immediately, queue subsequent layers as dependencies complete

5. **Worker self-awareness**
   - Budget ~200MB for worker process overhead
   - Subtract from available memory before scheduling
   - Log worker's own memory usage periodically

6. **Remove /design command**
   - Design analysis absorbed into planning phase
   - Planner agent already does architecture analysis

7. **Update help text and documentation**

---

## WS6: Crash Recovery Improvements

**Goal:** When forge crashes and restarts, cleanly resume from where it left off without redoing completed work.

### Current State
- Jobs stuck in `running` are reset to `queued` on startup (works)
- Orphaned agents are detected and logged (works)
- But: no concept of "which phase was I in" or "which work items were already done"

### Improvements

1. **Phase-aware restart** (enabled by WS5's ImplementSession)
   - On startup, check for incomplete sessions
   - Skip completed phases
   - Resume from the exact failure point

2. **Failure diagnosis**
   - When a job was stuck (reset from running), analyze why:
     - Check system logs for OOM killer entries
     - Check event log for last agent activity
     - Check resource profiler for memory/CPU at time of failure
   - Log diagnosis to session's `crashLog` field

3. **Failure → Learning pipeline**
   - When a crash is diagnosed, create a learning entry:
     - "trafficGame work-item jobs OOM at >1.2GB — reduce build concurrency"
   - Profiler uses this to adjust future resource estimates

4. **Graceful shutdown improvements**
   - On SIGTERM: save session state, mark phase as "interrupted"
   - On SIGINT (first): same as SIGTERM
   - On SIGINT (second): force kill (existing behavior)
   - Session state always reflects reality

### Implementation
- Modified: `src/jobs/worker.ts` (failure diagnosis on recovery)
- Modified: `src/state/implement-session.ts` (from WS5)
- Modified: `src/session/session.ts` (graceful shutdown saves session)
- New: `src/diagnostics/crash-analyzer.ts` (~100 lines)

---

## Implementation Order

```
Phase 1 (Immediate — fix the bleeding):
  WS1: TrafficGame memory leaks
  WS3: tmux UI stability (quick wins — render throttling)

Phase 2 (Foundation — prevent future crashes):
  WS2: Process isolation (cgroups)
  WS4: Git workflow automation layer

Phase 3 (Architecture — unify the experience):
  WS5: Unified /implement command
  WS6: Crash recovery (builds on WS5)
```

Each phase can be worked on independently within the phase. Phases are ordered by dependency and urgency.
