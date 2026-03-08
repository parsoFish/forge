# Architecture — Forge Orchestrator

## Overview

Forge is a thin orchestration layer that spawns Claude Code instances as specialized
sub-agents. Each agent has a clear role, constrained tools, and the core values
injected into its system prompt. The orchestrator posts jobs to a file-based queue;
a separate worker process picks them up and runs agents within concurrency and budget
constraints.

## Design Principles

Drawn from both OpenClaw (declarative markdown agents) and Ralph Orchestrator (loop-until-done):

1. **Declarative agent definitions** — Agents are markdown files with YAML frontmatter,
   not code. Easy to read, modify, and version control.
2. **Fresh context per invocation** — Each agent starts with fresh context and reads state
   from disk. No accumulated context drift.
3. **File-based state** — Work items, decisions, and research are stored as JSON/markdown
   files in `.forge/`. Simple, inspectable, diffable.
4. **Quality gates as backpressure** — Rather than prescribing how agents work, we define
   gates (tests pass, lint clean, types correct) that reject bad work.
5. **KISS** — The orchestrator is a thin coordination layer. Agents are smart; let them work.

## Six-Phase Lifecycle

The orchestrator manages projects through explicit phases (see [ADR-002](decisions/002-six-phase-architecture.md)):

```
Roadmap → Implement → Review → Merge → Reflect → Loop
```

| Phase | Mode | Model | What Happens |
|-------|------|-------|-------------|
| Roadmap | Interactive | Opus | Human sets direction, agent produces design briefs |
| Implement | Autonomous | Sonnet | Design → plan → test → develop → PR pipeline |
| Review | Interactive | Sonnet | PR triage, deep review, human approval |
| Merge | Autonomous | — | Fix review feedback, resolve conflicts, merge |
| Reflect | Interactive | Opus | Analyze outcomes, extract learnings for next cycle |

Phase transitions are explicit (`forge phase <name>`). The `forge resume` command
dispatches the right jobs for the current phase.

## Component Architecture

```
┌─────────────┐
│   CLI       │  ← User entry point (Commander.js)
└──────┬──────┘
       │
┌──────▼──────┐     ┌──────────────┐
│ Orchestrator │────▶│  Job Queue   │  ← Posts jobs to .forge/jobs/
└──────────────┘     └──────┬───────┘
                            │
                     ┌──────▼───────┐
                     │   Worker     │  ← Long-running job executor
                     └──────┬───────┘
                            │
┌──────────────┐     ┌──────▼───────┐
│  Pipeline    │────▶│ Stage Runner │  ← Sequential stage execution
└──────┬───────┘     └──────┬───────┘
       │                    │
┌──────▼──────┐     ┌──────▼───────┐
│ Agent Runner│────▶│ Claude Code  │  ← Spawns Claude CLI with agent config
└──────┬──────┘     │    SDK       │
       │            └──────────────┘
┌──────▼──────┐
│ State Store │  ← .forge/ directory (JSON files)
└─────────────┘
```

## Implementation Pipeline

Within the implementation phase, work items flow through stages:

```
design → plan → [per work item: test → develop → pr → review]
```

| Stage | Agent | Purpose |
|-------|-------|---------|
| design | architect | Analyze project, propose features |
| plan | planner | Break features into atomic work items |
| test | test-engineer | Write failing tests (TDD) |
| develop | developer | Implement to make tests pass |
| pr | pr-creator | Push branch, create pull request |
| review | reviewer | Mark for human review |

## Agent System

Agents are defined in `agents/*.md` using declarative markdown with YAML frontmatter:

```markdown
---
name: agent-name
role: agent-role
description: When to invoke this agent
tools: Read, Write, Bash
---

System prompt content here...
```

The registry loads these files, injects core values into each agent's system
prompt, and maps them to their workflow stage. The runner spawns Claude Code
SDK sessions with the agent's configuration.

## State Management

Runtime state lives in `.forge/` (gitignored):

- `jobs/*.json` — Job queue (queued, running, completed, failed)
- `work-items/<project>/*.json` — Individual work item tracking
- `designs/*.json` — Project design briefs
- `roadmaps/*.json` — Project roadmaps with milestones
- `learnings/*.md` — Reflection reports from each cycle
- `decisions.md` — Decision log (append-only markdown)
- `research/*.md` — Research agent findings
- `phase.json` — Current orchestrator phase

## Model Selection

Different agents use different Claude models based on their needs:

| Agent | Default Model | Rationale |
|-------|--------------|-----------|
| architect | Opus | Design needs deep reasoning |
| planner | Sonnet | Planning needs structure |
| test-engineer | Sonnet | Test design needs precision |
| developer | Sonnet | Implementation workhorse |
| pr-creator | Haiku | PR creation is formulaic |
| reviewer | Sonnet | Review needs judgment |
| pr-reviewer | Sonnet | GitHub PR review — quality + speed |
| researcher | Haiku | High-volume, lower stakes |
| reflector | Sonnet | Reflection needs analytical depth |

Models are configurable via `forge.config.json`.

## Concurrency & Resources

- **Adaptive concurrency** — Agent count scales dynamically with CPU/memory pressure
- **Resource slots** — Named pools (build, browser) coordinate heavyweight operations
- **Budget tracking** — Per-run and weekly cost caps with configurable warning thresholds
