# Forge

**Autonomous multi-agent orchestrator — a lead engineer for your codebase.**

Forge manages a team of AI agents that analyze, plan, implement, review, and merge changes across multiple projects. You set the direction; agents do the work.

## How It Works

Forge uses a **job queue architecture**. CLI commands post jobs to disk and return immediately. A separate worker process picks up jobs and runs agents via the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk).

```
forge roadmap myproject    # Post a roadmapping job (instant)
forge worker --daemon      # Process jobs continuously (long-running)
```

### Six-Phase Lifecycle

```
Roadmap → Implement → Review → Merge → Reflect → Loop
```

| Phase | Mode | Model | What Happens |
|-------|------|-------|-------------|
| **Roadmap** | Interactive | Opus | Human sets direction, agent produces design briefs |
| **Implement** | Autonomous | Sonnet | Plan → TDD → develop → test cycle |
| **Review** | Interactive | Sonnet | PR triage, deep review, human approval |
| **Merge** | Autonomous | — | Fix review feedback, resolve conflicts, merge |
| **Reflect** | Interactive | Opus | Analyze outcomes, extract learnings |

Phases transition explicitly. Agents run autonomously between human touchpoints.

## Quick Start

```bash
# Prerequisites: Node.js >= 22, Claude Code CLI authenticated

# Clone and build
git clone https://github.com/parsoFish/forge.git
cd forge
npm install
npm run build

# Configure
cp forge.config.example.json forge.config.json
# Edit forge.config.json with your model preferences and budget limits

# Add projects to manage
mkdir -p projects
cd projects && git clone <your-project-repo>
cd ..

# Start working
forge roadmap <project-name>    # Queue roadmap generation
forge worker                    # Process the queue
```

## CLI Commands

### Job Commands (non-blocking)

| Command | Description |
|---------|-------------|
| `forge roadmap [project]` | Generate project roadmap and design briefs |
| `forge plan [project]` | Break design briefs into work items |
| `forge implement [project]` | Run TDD implementation cycle |
| `forge review [project]` | Scan open PRs and queue reviews |
| `forge fix <pr#> --project <name>` | Autonomous review/fix loop for a PR |
| `forge fix-all [project]` | Fix loop for all open PRs |
| `forge reflect` | Analyze cycle outcomes and extract learnings |

### Worker

| Command | Description |
|---------|-------------|
| `forge worker` | Process queued jobs until empty |
| `forge worker --daemon` | Keep alive, wait for new jobs |

### Management

| Command | Description |
|---------|-------------|
| `forge status` | Phase, work items, jobs, budget, resources |
| `forge jobs` | Queue status breakdown |
| `forge phase [phase]` | Show or switch orchestrator phase |
| `forge projects` | List managed projects |
| `forge cancel [job-id]` | Cancel queued jobs |
| `forge retry` | Reset failed jobs to queued |
| `forge resume [project]` | Resume work based on current phase |
| `forge events [project]` | Show event log |

### UI (tmux)

| Command | Description |
|---------|-------------|
| `forge` | Launch full tmux dashboard |
| `forge watch:monitor` | Live resource monitoring |
| `forge watch:queue` | Live queue view |

## Configuration

Copy `forge.config.example.json` to `forge.config.json` and customize:

```jsonc
{
  "projectsDir": "projects",           // Where managed projects live
  "models": {
    "architect": "claude-opus-4-6",     // Model per agent role
    "developer": "claude-sonnet-4-6",
    "prCreator": "claude-haiku-4-5-20251001"
    // ...
  },
  "concurrency": {
    "ceiling": 6,                       // Max concurrent agents
    "targetCpuLoad": 0.65,             // Scale-up threshold
    "memoryPerAgentMb": 800            // Memory budget per agent
  },
  "costTracking": {
    "maxRunBudgetUsd": 500,            // Per-run budget cap
    "maxWeeklyBudgetUsd": 2000         // Weekly budget cap
  }
}
```

Projects are auto-discovered from `projectsDir/` — any subdirectory becomes a managed project.

## Architecture

```
forge/
├── src/
│   ├── cli.ts              # CLI entry point (Commander)
│   ├── orchestrator.ts     # Core engine — job posting
│   ├── workflow/           # Pipeline stages
│   ├── agents/             # Agent spawning via Claude Code SDK
│   ├── jobs/               # Job queue and worker
│   ├── state/              # File-based state (work items, roadmaps)
│   ├── monitor/            # Resource monitoring + adaptive concurrency
│   ├── budget/             # Cost tracking
│   └── config/             # Settings and core values
├── agents/                 # Agent definitions (markdown + YAML frontmatter)
├── skills/                 # Reusable skill compositions
├── docs/                   # Architecture docs and ADRs
├── .forge/                 # Runtime state (gitignored)
└── projects/               # Managed project checkouts (gitignored)
```

### Key Design Decisions

- **File-based state** — jobs, work items, and decisions are JSON files on disk. No database needed.
- **Thin orchestrator** — the orchestrator posts jobs and manages phase transitions. Agents are smart; they decide implementation details.
- **Adaptive concurrency** — agent count scales with CPU/memory pressure, not static limits.
- **Declarative agents** — agent behavior is defined in markdown files with YAML frontmatter, not code.
- **Resource slots** — heavyweight operations (builds, browsers) are coordinated through named slot pools.

## Agents

| Agent | Role | Model Tier |
|-------|------|-----------|
| Architect | Codebase analysis, design briefs | Opus |
| Planner | Work item breakdown with acceptance criteria | Sonnet |
| Test Engineer | Test-first development | Sonnet |
| Developer | Implementation (TDD green phase) | Sonnet |
| Reviewer | Code quality review | Sonnet |
| PR Reviewer | GitHub PR review with structured feedback | Sonnet |
| PR Creator | Branch + PR creation | Haiku |
| Researcher | Pattern discovery and ecosystem research | Haiku |
| Reflector | Outcome analysis and learning extraction | Sonnet |

Agent definitions live in `agents/*.md` — each is a markdown prompt with YAML frontmatter specifying name, role, tools, and description.

## Development

```bash
npm run build          # Compile TypeScript
npm run dev            # Run via tsx (no build step)
npm run test           # Vitest
npm run lint           # ESLint
npm run typecheck      # Type-check without emitting
```

## License

[Apache License 2.0](LICENSE)
