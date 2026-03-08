# ADR-002: Six-Phase Workflow Architecture

**Date:** 2026-03-08
**Status:** Accepted
**Deciders:** User + Forge orchestrator

## Context

Forge evolved organically from a simple design→plan→implement pipeline into a system with roadmapping, PR review loops, fix automation, and reflection — but these capabilities weren't structured into a coherent lifecycle. The per-work-item pipeline (`test→develop→pr→review`) worked well, but the outer loop (what triggers what, where humans engage) was implicit.

After running the first full autonomous cycle across 4 projects (127+ work items, 27 job runs, all PRs closed), clear patterns emerged:
- The system needs exactly **two interactive leverage points** where humans steer
- Everything between those points should be fully autonomous
- The PR merge pipeline is a distinct phase, not just "end of review"
- Reflection must be a first-class phase that feeds back into roadmapping

## Decision

Adopt a six-phase lifecycle with explicit interactive/autonomous boundaries:

```
┌─────────────────────────────────────────────────────────────┐
│                     FORGE LIFECYCLE                          │
│                                                             │
│  ┌──────────────┐     ┌──────────────────────────────┐     │
│  │ 1. ROADMAP   │────▶│ 2. DESIGN / PLAN / DEVELOP / │     │
│  │  (interactive)│     │    TEST                      │     │
│  │  Opus         │     │    (autonomous, Sonnet)      │     │
│  └──────────────┘     └──────────────┬───────────────┘     │
│                                       │                     │
│                                       ▼                     │
│  ┌──────────────┐     ┌──────────────────────────────┐     │
│  │ 5. REFLECT   │     │ 3. REVIEW                    │     │
│  │  (interactive)│     │    (interactive)              │     │
│  │  Opus         │     │    Haiku triage + Sonnet deep │     │
│  └──────────┬───┘     └──────────────┬───────────────┘     │
│             │                         │                     │
│             │         ┌───────────────▼──────────────┐     │
│             └────────▶│ 4. MERGE PIPELINE            │     │
│      (feeds back)     │    PlanMerge → DevelopPR →   │     │
│                       │    TestPR → MergePR           │     │
│                       │    (autonomous)               │     │
│                       └──────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Roadmapping (Interactive, Opus)

The human sets direction. The system presents what it knows about each project — current state, completed work, blockers, learnings from past reflections — and asks for priorities.

- **Trigger:** User initiates (`/roadmap`) or after reflect phase completes
- **Model:** Opus (deepest reasoning for strategic decisions)
- **Output:** Updated roadmaps per project with ordered milestones
- **Human role:** Provide direction, approve/adjust roadmap

### Phase 2: Design / Plan / Develop / Test (Autonomous, Sonnet)

The full implementation pipeline runs without human intervention. Each milestone spawns work items that flow through the TDD pipeline.

- **Trigger:** Approved roadmap with pending milestones
- **Model:** Sonnet (best coding model for implementation)
- **Stages per work item:** design → plan → test → develop → pr
- **Constraints:** Budget caps, concurrency ceiling, resource slots
- **Output:** PRs ready for review

### Phase 3: Review (Interactive, Haiku + Sonnet)

The second human leverage point. Haiku does initial triage (quick scan, categorize), Sonnet does deep review. Human sees both and provides direction.

- **Trigger:** PRs created from Phase 2
- **Model:** Haiku for triage, Sonnet for deep review
- **Human role:** Approve, request changes, redirect, or close
- **Output:** Approved PRs or change requests

### Phase 4: Merge Pipeline (Autonomous)

After human approval, the merge process runs autonomously with its own sub-pipeline:

1. **PlanMerge** — Analyze merge order, dependency chains, conflict potential
2. **DevelopPR** — Fix any review feedback, resolve conflicts
3. **TestPR** — Run full test suite, verify CI passes
4. **MergePR** — Merge when all gates pass

- **Trigger:** Human approves PR in Phase 3
- **Model:** Sonnet for fixes, Haiku for merge mechanics
- **Constraints:** Max fix rounds (3), CI must pass, no force merges
- **Output:** Merged PRs on main branch

### Phase 5: Reflect (Interactive, Opus)

The system reviews everything that happened: what was completed, what failed, what was untouched, what cost too much. Opus analyzes patterns and produces actionable recommendations.

- **Trigger:** After a merge cycle completes, or user initiates
- **Model:** Opus (deep analysis of complex multi-project outcomes)
- **Output:** Reflection report, updated learnings, recommendations
- **Feeds back to:** Phase 1 (roadmapping) with fresh context

## Mapping to Current Implementation

| Phase | Current State | Gap |
|-------|--------------|-----|
| Roadmapping | `stages/roadmap.ts` exists, works | Needs better integration with reflect output |
| Design/Plan/Develop/Test | `pipeline.ts` + all stage files | Working well, keep as-is |
| Review | `stages/review-prs.ts` + triage | Needs Haiku pre-triage before Sonnet deep review |
| Merge Pipeline | Fix loop exists (`worker.ts` pr-fix) | Needs formal PlanMerge/TestPR/MergePR stages |
| Reflect | `stages/reflect.ts` exists | Needs to feed output back to roadmap stage |

## Model Assignment Rationale

- **Opus** for strategic phases (roadmap, reflect): These require synthesizing broad context, making judgment calls, and producing novel insights. Cost is justified by the leverage — one good roadmap saves dozens of wasted work items.
- **Sonnet** for implementation and deep review: Best coding model. The bulk of token spend happens here, and Sonnet's quality-to-cost ratio is optimal.
- **Haiku** for mechanical tasks: PR creation, initial triage, merge mechanics. Fast, cheap, and sufficient for structured/templated work.

## Consequences

**Positive:**
- Clear separation of interactive (human-steered) and autonomous phases
- Reflection creates a feedback loop — the system learns and improves
- Merge pipeline becomes robust instead of ad-hoc fix-and-pray
- Model selection optimized for each phase's cognitive demands

**Negative:**
- More complex phase management in orchestrator
- Reflect phase adds cost per cycle (but pays for itself in avoided waste)
- Merge pipeline needs new stage implementations

**Risks:**
- Reflect quality depends on good event/outcome data — logging must stay rich
- Human bottleneck at Review phase could slow autonomous work (mitigate: batch reviews)

## Implementation Plan

1. Formalize phase transitions in orchestrator (phase.json state machine)
2. Add Haiku pre-triage to review pipeline
3. Implement PlanMerge, TestPR, MergePR stages
4. Wire reflect output into roadmap stage context
5. Add `/reflect` command to interactive session
