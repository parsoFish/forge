# Workflow — Forge Orchestrator

## Pipeline Overview

Every project flows through a staged pipeline:

```
design → plan → [per work item: test → develop → pr → review]
```

The first two stages (design, plan) operate at the **project level**.
The remaining stages operate **per work item**.

## Stage Details

### 1. Design (Architect Agent)

**Input:** A project directory
**Output:** A design brief (JSON)

The architect agent:
- Reads the project's README, config files, and key source files
- Assesses architecture, quality, testing, documentation
- Proposes features with rationale, scope, and priority
- Identifies tech debt and improvement opportunities

The design brief is saved to `.forge/designs/<project>.json`.

### 2. Plan (Planner Agent)

**Input:** A design brief
**Output:** A list of work items

The planner agent:
- Breaks each proposed feature into atomic work items
- Defines acceptance criteria for each
- Specifies the testing approach (which layers)
- Orders by dependency (critical path first)
- Names branches following conventions

Work items are saved individually as `.forge/work-items/<id>.json`.

### 3. Test (Test Engineer Agent)

**Input:** A work item description
**Output:** Failing tests on a feature branch

The test engineer:
- Creates the feature branch
- Studies existing test patterns and frameworks
- Designs tests at appropriate layers (unit, integration, e2e)
- Writes tests that fail (implementation doesn't exist yet)
- Commits the tests

### 4. Develop (Developer Agent)

**Input:** A branch with failing tests
**Output:** Passing tests with clean implementation

The developer:
- Reads the failing tests to understand expected behavior
- Implements the minimum code to make tests pass
- Refactors after green
- Runs ALL tests (new and existing)
- Runs linters — zero warnings
- Commits the implementation

**Quality gates:** All tests pass, zero lint warnings, zero type errors.

### 5. PR (PR Creator Agent)

**Input:** A branch with passing tests
**Output:** A pull request on GitHub

The PR creator:
- Pushes the branch to origin
- Creates a PR with why-focused description
- Adds appropriate labels

### 6. Review (Terminal State)

**Input:** A pull request
**Output:** Work item marked for human review

The review stage marks the work item as complete from the automation
perspective. A human reviews and merges (or requests changes).

## Work Item States

```
pending → in-progress → completed
                      → failed
                      → blocked (needs human attention)
```

## Resuming Work

If a work item fails or gets blocked, it can be resumed:

```bash
forge resume <work-item-id>
```

This picks up from the current stage with a fresh agent invocation.

## Research Agent

Independently of project work, the research agent periodically investigates
new patterns, tools, and approaches in the AI agent orchestration space.
Findings are saved to `.forge/research/` as markdown reports.

```bash
forge research
```
