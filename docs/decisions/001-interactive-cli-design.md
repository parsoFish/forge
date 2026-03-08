# ADR-001: Interactive CLI Design

**Status:** Proposed
**Date:** 2026-03-07

## Context

Forge currently operates as separate CLI commands (`forge roadmap`, `forge worker`, `forge review`, etc.) that post jobs and exit. The worker runs in a separate terminal. This creates friction:

- No way to interact with the orchestrator while the worker is running
- Two interactive phases (roadmapping, PR review) require a separate Claude session
- Monitoring requires running `forge status` or `forge jobs` in yet another terminal
- No persistent view of what agents are doing

The desired experience (see `ui-scratch.png`) is a single interactive session where the user chats with the forge orchestrator while work runs in the background — similar to how a lead engineer delegates to a team while remaining available for questions.

## Decision

### Phase 1: Interactive REPL with Embedded Worker

`forge` with no subcommand starts an interactive session:

```
$ forge
▶ Forge v0.2.0 | 4 projects | Budget: $0.00/$75.00
  Worker: running (daemon) | Jobs: 0 queued | 0 running

forge> /roadmap trafficGame
  Starting roadmap conversation for trafficGame...
  [orchestrator agent engages in interactive chat]

forge> /status
  [inline status display]

forge> /jobs
  [live job list]
```

The session owns both the orchestrator chat and the embedded worker. Slash commands replace top-level CLI subcommands. The current CLI subcommands remain available for scripting/CI.

### Phase 2: Forge as MCP Server (for external Claude sessions)

Forge exposes its capabilities as an MCP server so users can interact with it from their own Claude Code session:

```bash
# Register forge as an MCP server
claude mcp add forge -- forge mcp-serve
```

This gives any Claude session access to forge tools:
- `forge_status` — current state across all projects
- `forge_roadmap` — start roadmapping for a project
- `forge_implement` — queue implementation jobs
- `forge_jobs` — view/reprioritise the job queue
- `forge_review` — trigger PR review cycle

### CLI-First, MCP-Second Rationale

Research shows CLI and MCP have different strengths. Forge should be **CLI-first with MCP as a convenience layer**, not the other way around.

#### Why CLI-first

1. **Token efficiency**: CLI tools are 33% more token-efficient than MCP equivalents in benchmarks. MCP tool definitions consume context before any work begins — a typical MCP server dumps its full schema (55K+ tokens for large servers). CLI tools use zero context until invoked.

2. **Composability**: CLI output pipes naturally into other tools. An agent can run `forge status --json | jq '.projects[] | select(.failedItems > 0)'` — this kind of filtering happens outside the context window, saving tokens.

3. **Debuggability**: When something goes wrong, you can run the exact same command the agent ran. MCP tool calls only exist inside conversation logs.

4. **LLM familiarity**: Models are trained on millions of man pages and shell scripts. They're excellent at constructing CLI commands. MCP requires learning a bespoke schema per server.

5. **No background processes**: CLI tools are stateless invocations. MCP servers are long-running processes that can hang, leak memory, or lose connection.

6. **Granular permissions**: Claude Code's allowedTools can permit `forge status` while requiring approval for `forge implement`. MCP offers coarser control.

#### Where MCP adds value

1. **Structured input/output**: For complex operations (e.g., reprioritising jobs with nested metadata), MCP's typed parameters are cleaner than constructing CLI flags.

2. **Authentication bypass**: MCP tools skip Claude Code's malicious command detection, meaning fewer round trips for trusted operations.

3. **Discovery**: MCP's tool listing lets Claude understand what forge can do without reading help text. With Tool Search lazy loading, the context cost is manageable.

4. **Complex multi-step flows**: For tasks requiring 5+ back-and-forth calls (like interactive roadmapping), MCP's 39% cost advantage on complex tasks outweighs CLI's per-call efficiency.

#### The hybrid approach

Forge should implement both, with the CLI as the source of truth:

```
forge CLI (source of truth)
  ├── forge status          # direct invocation
  ├── forge implement       # direct invocation
  └── ...

forge MCP server (thin wrapper)
  ├── forge_status  → calls `forge status --json` internally
  ├── forge_implement → calls `forge implement` internally
  └── ...
```

The MCP server is a thin adapter over the CLI — not a separate codebase. This means:
- CLI improvements automatically flow to MCP
- MCP tools can be tested by running the equivalent CLI command
- Users can choose whichever interface suits their workflow

## Architecture

### New: `Session` class

```
src/
  session/
    session.ts          # Interactive REPL — owns Worker + Orchestrator
    commands.ts         # Slash command registry and dispatch
    status-bar.ts       # Persistent bottom status line (jobs, budget, time)
    views/
      jobs-view.ts      # /jobs — live job list with reprioritisation
      agents-view.ts    # /agents — running agent progress
      monitor-view.ts   # /monitor — resource usage, recommendations
  mcp/
    server.ts           # MCP server adapter (Phase 2)
    tools.ts            # Tool definitions wrapping CLI commands
```

### Session lifecycle

```
forge
  → Session.start()
    → Worker.start(keepAlive=true)   // embedded, runs in background
    → StatusBar.render()             // persistent bottom line
    → REPL loop
      → parse slash command OR
      → forward to orchestrator agent chat
```

### Slash commands (map to UI buttons)

| Command | UI Equivalent | Mode | Description |
|---------|--------------|------|-------------|
| `/roadmap [project]` | roadmap button | Interactive | Chat-based roadmap session |
| `/design [project]` | design button | Autonomous | Queue design jobs |
| `/implement [project]` | plan→test→develop→pr | Autonomous | Queue full pipeline |
| `/review [project]` | review button | Interactive | Chat-based PR review |
| `/reflect` | reflect button | Interactive | Discuss learnings with orchestrator |
| `/config` | config button | Interactive | Edit settings inline |
| `/jobs` | jobs list panel | View | Show/reprioritise jobs |
| `/agents` | sub agents panel | View | Show running agent progress |
| `/monitor` | monitoring panel | View | Resource usage + recommendations |
| `/status` | — | View | Quick summary of everything |

### Status bar (always visible)

```
[3 running | 2 queued | $12.40/$75.00] simplarr/003-badge ● GitWeave/PR#5 ●
```

Shows: job counts, budget spend, and names of currently running work with a spinner.

### Orchestrator agent chat

The main chat area (left panel in the UI sketch) is a Claude session with forge tools available. When the user types something that isn't a slash command, it goes to the orchestrator agent which can:

- Answer questions about project state
- Explain what's happening with running jobs
- Help make decisions about priorities
- Kick off work on the user's behalf

This is the "forge agent" — it has access to all forge CLI commands as tools.

## Consequences

### Positive
- Single session for everything — no more juggling terminals
- Worker and chat coexist naturally
- Path toward the full TUI (UI sketch) without building it yet
- MCP server enables integration with external Claude sessions
- CLI-first means everything is testable and debuggable

### Negative
- More complex process model (REPL + background worker + agent chat)
- Need to handle stdin contention between REPL and agent prompts
- Status bar requires terminal capability detection (fallback to periodic logging)

### Risks
- Interactive roadmapping/review requires the orchestrator agent to maintain conversation state while the worker runs — need clean separation of concerns
- MCP server adds a maintenance surface — keep it as a thin CLI wrapper to minimise this

## Implementation Plan

1. **Status bar** — add a persistent status line to the existing worker (low risk, immediate value)
2. **Slash command registry** — parse `/command` input, dispatch to existing Orchestrator methods
3. **Session class** — REPL that owns Worker + Orchestrator, renders status bar
4. **Orchestrator agent integration** — wire up Claude chat with forge tools for the main panel
5. **MCP server** — thin adapter exposing forge tools for external Claude sessions
6. **View commands** — `/jobs`, `/agents`, `/monitor` with live-updating display

## References

- [MCP is dead. Long live the CLI](https://ejholmes.github.io/2026/02/28/mcp-is-dead-long-live-the-cli.html) — composability, debuggability, permissions arguments
- [MCP vs CLI: Benchmarking Tools for Coding Agents](https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/) — tmux/CLI 33% more token-efficient for established tools
- [I Benchmarked How Claude Code Consumes APIs. MCP Won.](https://dev.to/tobrun/i-benchmarked-how-claude-code-consumes-apis-mcp-won-and-it-wasnt-close-4k1) — MCP 2x cheaper for structured API access, but CLI still 100% success rate
- [Why CLI Tools Are Beating MCP for AI Agents](https://jannikreinhard.com/2026/02/22/why-cli-tools-are-beating-mcp-for-ai-agents/) — LLM familiarity, zero context overhead
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — Anthropic's own approach: agents write code to call tools
