# Workflow — Forge Orchestrator

## Lifecycle Overview

Forge operates a six-phase lifecycle with two interactive leverage points:

```
┌─────────────┐     ┌──────────────────────────┐     ┌─────────────┐
│ 1. ROADMAP  │────▶│ 2. DESIGN/PLAN/DEV/TEST  │────▶│ 3. REVIEW   │
│ (interactive)│     │    (autonomous)           │     │ (interactive)│
└─────────────┘     └──────────────────────────┘     └──────┬──────┘
       ▲                                                     │
       │            ┌──────────────────────────┐             │
       │            │ 5. REFLECT               │             ▼
       └────────────│    (interactive)          │◀────┌──────────────┐
                    └──────────────────────────┘     │ 4. MERGE     │
                                                     │ (autonomous)  │
                                                     └──────────────┘
```

**Interactive phases** are where the human steers direction.
**Autonomous phases** run without intervention, constrained by budget/concurrency caps.
**Reflect** creates the feedback loop — learnings from each cycle inform the next roadmap.

See [decisions/002-six-phase-architecture.md](decisions/002-six-phase-architecture.md) for the ADR.

## Phase 1: Roadmap (Interactive, Opus)

The human sets direction per project. The system presents current state, completed work, blockers, and learnings from past reflections.

**Trigger:** User initiates (`/roadmap`) or after reflect phase
**Output:** Updated roadmaps with ordered milestones per project

```bash
forge roadmap [project]       # Interactive roadmapping
forge roadmap --all           # Roadmap all projects
```

## Phase 2: Design / Plan / Develop / Test (Autonomous, Sonnet)

The full implementation pipeline. Each milestone spawns work items that flow through TDD:

```
design → plan → [per work item: test → develop → pr]
```

### Design (Architect Agent)
Analyzes the project holistically, proposes features with rationale and scope.
Output: Design brief saved to `.forge/designs/<project>.json`.

### Plan (Planner Agent)
Breaks features into atomic work items with acceptance criteria, test approach, and dependency order.
Output: Work items saved as `.forge/work-items/<project>/<id>.json`.

### Test (Test Engineer Agent)
Creates feature branch, writes failing tests at appropriate layers (unit, integration, e2e).
Output: Branch with failing tests committed.

### Develop (Developer Agent)
Implements minimum code to make tests pass, refactors, runs all tests and linters.
Output: Branch with passing tests, zero warnings.
**Quality gates:** All tests pass, zero lint warnings, zero type errors.

### PR (PR Creator Agent)
Pushes branch, creates pull request with why-focused description.
Output: PR ready for review.

## Phase 3: Review (Interactive, Haiku + Sonnet)

The second human leverage point. Two-tier review:

1. **Haiku triage** — Quick categorization, obvious issues
2. **Sonnet deep review** — Architecture, logic, edge cases
3. **Human review** — Approve, request changes, or redirect

```bash
forge review                  # Interactive PR review
forge review --project <name> # Review specific project
```

## Phase 4: Merge Pipeline (Autonomous)

After human approval, merge runs autonomously:

1. **PlanMerge** — Analyze merge order, dependency chains, conflict potential
2. **DevelopPR** — Fix review feedback, resolve conflicts (developer agent)
3. **TestPR** — Run full test suite, verify CI passes
4. **MergePR** — Merge when all gates pass

Constraints: Max 3 fix rounds before human escalation. CI must pass. No force merges.

```bash
forge fix <pr> --project <name>   # Trigger fix loop for a specific PR
forge fix-all [--project <name>]  # Fix all approved PRs
```

## Phase 5: Reflect (Interactive, Opus)

Analyze what happened: completed, failed, blocked, cost patterns.
Produce actionable recommendations that feed back into Phase 1.

**Output:** Reflection report in `.forge/learnings/`, updated roadmap context.

**Push to remote happens here.** Commits accumulate locally throughout the cycle. Only after reflect validates the learnings do we push to the forge remote. This keeps the published repo clean and ensures only complete, verified work is shared.

```bash
forge reflect                 # Run reflection analysis
```

## Work Item States

```
pending → in-progress → completed
                      → failed
                      → blocked (needs human attention)
```

## Resuming Work

```bash
forge resume <work-item-id>   # Resume from current stage
```

## Research Agent

Independently investigates new patterns, tools, and approaches.
Findings saved to `.forge/research/` as markdown reports.

```bash
forge research
```
