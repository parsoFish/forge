# ADR-003: Process Isolation & Resource Limits for Agent Subprocesses

**Status:** Proposed
**Date:** 2026-03-10
**Deciders:** User + Forge

## Context

The system crashes when agent subprocesses (builds, tests, dev servers) consume too much memory. Currently, the resource monitor tracks system-level CPU/memory and uses adaptive concurrency to throttle agent spawning — but once an agent is running, its child processes (TypeScript compiler, Vitest, Vite dev server, Playwright) can allocate memory without any per-process limits. A single runaway build can push WSL2 into OOM, killing everything including the forge orchestrator itself.

The cleanup log from the latest crash shows:
- Memory pressure at 88% (85% limit)
- A job frozen in "running" state for hours
- Worker marked unhealthy but couldn't recover

### Problem Statement

1. **No per-process memory ceiling.** Agent child processes can consume unlimited memory.
2. **No graceful shedding.** When memory is critical, there's no priority ordering for what to kill first.
3. **No observability per-subprocess.** We don't know which specific build/test consumed how much.
4. **Monitor pane doesn't reflect WSL reality.** `/proc/meminfo` MemAvailable may not account for WSL2's dynamic memory allocation to the VM.

## Decision

Implement a **Kubernetes-inspired request/limit model** for agent subprocesses, using Linux cgroups v2 (available in WSL2).

### Design

#### 1. Resource Requests & Limits

Each job type declares resource expectations:

```typescript
interface ResourceRequest {
  memoryRequestMb: number;  // Minimum guaranteed memory (for scheduling)
  memoryLimitMb: number;    // Hard ceiling (cgroup enforced)
  cpuShares?: number;       // Relative CPU weight (default: 1024)
}

const JOB_RESOURCE_PROFILES: Record<string, ResourceRequest> = {
  'work-item':  { memoryRequestMb: 512,  memoryLimitMb: 1500 },
  'pr-fix':     { memoryRequestMb: 512,  memoryLimitMb: 1500 },
  'implement':  { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'plan':       { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'review':     { memoryRequestMb: 256,  memoryLimitMb: 600  },
  'roadmap':    { memoryRequestMb: 256,  memoryLimitMb: 800  },
  'reflect':    { memoryRequestMb: 256,  memoryLimitMb: 600  },
};
```

#### 2. Cgroup v2 Enforcement

When spawning an agent subprocess:

1. **Create a cgroup** under a forge-managed hierarchy: `forge/<job-id>/`
2. **Set `memory.max`** to `memoryLimitMb * 1024 * 1024`
3. **Set `memory.high`** to 80% of limit (triggers kernel reclaim pressure before OOM)
4. **Spawn the agent process** inside the cgroup via `cgexec` or by writing PID to `cgroup.procs`
5. **Monitor `memory.current`** periodically for per-job observability
6. **On cgroup OOM:** The kernel kills the process (contained blast radius). Worker detects exit, marks job failed with `OOM_KILLED` reason, logs the peak memory.

#### 3. Scheduling with Requests

Before dispatching a job, the worker checks:
```
availableMemoryMb - sum(running jobs' memoryRequestMb) >= newJob.memoryRequestMb
```

This is the "request" guarantee — we only schedule if we believe there's enough headroom. The "limit" is the hard ceiling enforced by cgroups.

#### 4. Graceful Shedding (Kill Priority)

When system memory crosses critical threshold (90%+):

1. **Kill build/test slots first** (recoverable — just re-queue)
2. **Kill dev servers second** (can be restarted)
3. **Never kill the forge orchestrator process**
4. Priority ordering uses `memory.current` from cgroups — kill the biggest consumer first

#### 5. Fallback (No Cgroup Access)

If cgroups are unavailable (permissions, non-Linux):
- Fall back to current behavior (no per-process limits)
- Use `process.memoryUsage()` polling as best-effort per-agent tracking
- Kill via SIGTERM → SIGKILL escalation based on resource monitor readings

### WSL2 Memory Considerations

WSL2 uses a Hyper-V VM with dynamic memory allocation. `/proc/meminfo` reports the VM's memory, not the host's. This means:
- WSL2 can grow its memory allocation up to `.wslconfig` limits
- `MemAvailable` may look fine while the host is under pressure
- **Mitigation:** Read `/proc/pressure/memory` (PSI — Pressure Stall Information) for a more accurate picture of actual memory contention

## Consequences

### Positive
- Runaway builds can't crash the orchestrator
- Per-job memory visibility enables profiler learning
- Graceful shedding preserves the main process
- Tuning knobs (requests/limits) can evolve with profiler data

### Negative
- Cgroup setup requires either root or delegated cgroup access
- Additional complexity in agent runner
- WSL2 cgroup support may need testing

### Risks
- WSL2 cgroup v2 delegation may not work out of the box (needs testing)
- Setting limits too low could cause legitimate builds to OOM

## Implementation Plan

1. Detect cgroup v2 availability and delegation status
2. Create `ProcessIsolation` module in `src/monitor/`
3. Integrate into `runAgent()` in `src/agents/runner.ts`
4. Add `memory.current` polling to worker status broadcast
5. Add PSI reading to resource monitor for WSL2
6. Implement graceful shedding in worker main loop
7. Update monitor pane to show per-job memory usage
