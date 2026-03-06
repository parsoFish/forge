# Architecture — Forge Orchestrator

## Overview

Forge is a thin orchestration layer that spawns Claude Code instances as specialized
sub-agents. Each agent has a clear role, constrained tools, and the core values
injected into its system prompt. The orchestrator manages the workflow pipeline and
state; agents do the actual work.

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

## Component Architecture

```
┌─────────────┐
│   CLI       │  ← User entry point (Commander.js)
└──────┬──────┘
       │
┌──────▼──────┐
│ Orchestrator │  ← Workflow dispatch, project management
└──────┬──────┘
       │
┌──────▼──────┐     ┌──────────────┐
│  Pipeline   │────▶│ Stage Runner │  ← Sequential stage execution
└──────┬──────┘     └──────┬───────┘
       │                   │
┌──────▼──────┐     ┌──────▼───────┐
│ Agent Runner│────▶│ Claude Code  │  ← Spawns Claude CLI with agent config
└──────┬──────┘     │    CLI       │
       │            └──────────────┘
┌──────▼──────┐
│ State Store │  ← .forge/ directory (JSON files)
└─────────────┘
```

## Workflow Pipeline

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

Agents are defined in `agents/*.md` using OpenClaw-compatible format:

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
CLI with the agent's configuration.

## State Management

Runtime state lives in `.forge/` (gitignored):

- `work-items/*.json` — Individual work item tracking
- `designs/*.json` — Project design briefs
- `decisions.md` — Decision log (append-only markdown)
- `research/*.md` — Research agent findings

## Model Selection

Different agents use different Claude models based on their needs:

| Agent | Model | Rationale |
|-------|-------|-----------|
| architect | Sonnet | Design needs solid reasoning |
| planner | Sonnet | Planning needs structure |
| test-engineer | Sonnet | Test design needs precision |
| developer | Sonnet | Implementation workhorse |
| pr-creator | Haiku | PR creation is formulaic |
| reviewer | Sonnet | Review needs judgment |
| researcher | Haiku | High-volume, lower stakes |

Models are configurable via `forge.config.json`.
