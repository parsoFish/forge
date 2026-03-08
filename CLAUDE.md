# Forge — Autonomous Multi-Agent Orchestrator

> The orchestrator is a thin coordination layer with strong opinions. Agents are smart; steer them with values, not scripts.

## Core Values

This orchestrator acts as a **lead engineer** instructing a team of autonomous agents. Every decision flows from these five principles:

### 1. Quality Gatekeeper
- **Zero tolerance for warnings.** Code that emits lint warnings, type errors, or deprecation notices does not ship.
- **TDD is the default.** Tests are written before implementation unless technically impractical. Test-after is the exception, not the norm.
- **Strict formatting and linting.** Every project must have an enforced style configuration. Agents must run formatters and linters before declaring work complete.
- **Strong coverage expectations.** Not arbitrary percentage targets — meaningful coverage of behavior, edge cases, and failure modes.

### 2. Pattern-Driven Architecture
- **Use established patterns.** DDD, hexagonal architecture, repository pattern, strategy pattern — reach for proven solutions first.
- **Invest in good abstractions.** Interfaces, dependency injection, and clear boundaries are not premature if they serve separation of concerns.
- **Dependencies are welcome if proven.** Don't reinvent wheels — but vet dependencies for maintenance health, security, and API stability.
- **Follow ecosystem conventions religiously.** If the framework has a way, use that way. Don't fight the tool.

### 3. Bold & Clean Change Management
- **Actively pay down tech debt.** If you see a mess near where you're working, clean it up. Don't leave broken windows.
- **Willing to break things to improve them.** Large refactors are acceptable when they produce genuinely better architecture.
- **Tech debt is tracked, not ignored.** When debt is accepted intentionally, it's documented with a rationale and remediation path.
- **No fear of breaking changes** when they're communicated clearly and migration paths are provided.

### 4. Why-Focused Documentation
- **Comments explain WHY, not WHAT.** The code shows what happens; comments explain the reasoning behind non-obvious decisions.
- **PR descriptions explain the decision, not the diff.** Why was this approach chosen? What alternatives were considered?
- **Concise but detailed READMEs.** Every project gets a README. Complex topics break out into `docs/` subdirectories.
- **Architectural Decision Records (ADRs)** for significant design choices. Kept in `docs/decisions/`.

### 5. High Agent Autonomy
- **Agents decide most things independently.** Implementation details, refactoring scope, dependency choices — agents own these.
- **Escalate only for:** major architectural shifts, ambiguous requirements, cross-project breaking changes, or security-sensitive decisions.
- **Creative liberty is encouraged.** If an agent finds a better approach than what was planned, it should pursue it and document why.
- **Experimentation within bounds.** Agents can spike and prototype, but experiments must not pollute the main branch.

## Layered Testing Strategy

Tests are designed at multiple layers, each with a clear purpose:

| Layer | Purpose | Scope |
|-------|---------|-------|
| **Unit Tests** | Verify isolated logic and pure functions | Single function/class |
| **Integration Tests** | Validate component boundaries and contracts | Module interactions, API contracts, DB queries |
| **E2E Tests** | Confirm critical user flows work end-to-end | Full system paths |
| **Explorative Tests** | Fuzz/property-based testing for edge cases | When domain warrants it |

## Build & Test Commands

```bash
# Orchestrator
cd /home/parso/sideProjects
npm run build          # Compile TypeScript
npm run lint           # ESLint check
npm run test           # Run orchestrator tests
npm start              # Run orchestrator CLI

# Individual projects — agents should discover per-project commands from their package.json/pyproject.toml/Makefile
```

## Architecture

```
/home/parso/sideProjects/
├── CLAUDE.md               # This file — orchestrator memory
├── package.json            # Orchestrator package
├── tsconfig.json
├── src/                    # Orchestrator source
│   ├── cli.ts              # CLI entry point
│   ├── orchestrator.ts     # Main engine — workflow dispatch
│   ├── workflow/           # Pipeline stages
│   ├── agents/             # Agent spawning & management
│   ├── state/              # File-based state (work items, decisions)
│   └── config/             # Core values, settings
├── agents/                 # Agent definitions (declarative markdown)
├── skills/                 # Reusable skill definitions
├── docs/                   # Orchestrator documentation
│   ├── core-values.md      # Expanded core values
│   ├── architecture.md     # Architecture deep-dive
│   ├── workflow.md         # Workflow pipeline docs
│   └── decisions/          # ADRs
├── .forge/                 # Runtime state (gitignored)
│   ├── work-items/         # Active work item tracking
│   ├── decisions.md        # Agent decision log
│   └── research/           # Research agent findings
└── projects/               # Managed projects (git submodules)
    ├── trafficGame/
    ├── simplarr/
    ├── env-optimiser/
    └── GitWeave/
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI entry point — `orch` command |
| `src/orchestrator.ts` | Core engine — project scanning, workflow dispatch |
| `src/workflow/pipeline.ts` | Stage-based pipeline runner |
| `src/agents/runner.ts` | Claude Code SDK wrapper for spawning agents |
| `agents/*.md` | Declarative agent definitions (markdown + YAML frontmatter) |
| `skills/*/SKILL.md` | Reusable skill definitions |
| `.forge/work-items/` | Runtime work item state |

## IMPORTANT Rules

- **Always run the project's test suite before declaring work complete.**
- **Always run linters/formatters before creating a PR.**
- **Never merge without all CI checks passing.**
- **Use conventional commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **One concern per PR.** If a refactor emerges during feature work, split it into a separate PR.
- **When in doubt about architecture, refer to the core values above.**
- **Fresh context is reliability** — re-read project state each cycle rather than relying on stale memory.
- **Push to remote only after reflect.** Commits happen locally throughout development. Push to the forge remote only after the reflect phase completes and learnings are validated. This keeps the remote clean and ensures only verified, complete work is published.
