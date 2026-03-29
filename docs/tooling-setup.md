# Forge Tooling Setup Guide

This guide covers the MCP servers, SKILL files, CLI tools, and configuration
that enhance Claude Code when working with the forge orchestrator and its
managed projects.

## Quick Start

```bash
# 1. Set up secrets
cp .env.mcp.example .env.mcp
# Edit .env.mcp with your actual values

# 2. Install MCP servers
./scripts/setup-mcp.sh

# 3. Verify
claude mcp list
```

## MCP Servers

MCP (Model Context Protocol) servers extend Claude Code with structured tool
access to external services. They're installed at the **user scope** (available
across all projects) or **project scope** (via `.mcp.json`).

### Recommended Servers

| Server | Project | Purpose | Requires Secret |
|--------|---------|---------|-----------------|
| **github** | All | PR management, issues, code search | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| **playwright** | trafficGame | Browser automation, E2E testing | None |
| **terraform** | GitWeave | Provider schemas, module docs | Optional `TF_TOKEN` |
| **docker** | simplarr | Container lifecycle management | None |
| **context7** | All | Live library/framework documentation | None |
| **sequential-thinking** | Forge | Structured multi-step reasoning | None |

### Installation

**All servers at once:**
```bash
./scripts/setup-mcp.sh
```

**Individual server:**
```bash
./scripts/setup-mcp.sh github
./scripts/setup-mcp.sh playwright
```

**List available:**
```bash
./scripts/setup-mcp.sh --list
```

**Manual install (if script doesn't work):**
```bash
claude mcp add -s user github -- npx -y @modelcontextprotocol/server-github
claude mcp add -s user playwright -- npx -y @playwright/mcp@latest
claude mcp add -s user terraform -- npx -y @hashicorp/terraform-mcp-server
claude mcp add -s user docker -- npx -y docker-mcp
claude mcp add -s user context7 -- npx -y @upstash/context7-mcp@latest
claude mcp add -s user sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking
```

### Project-Level Config (Optional)

For sharing MCP config with collaborators:
```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json with actual values — it's gitignored
```

### Managing Servers

```bash
claude mcp list                    # Show all configured servers
claude mcp remove github           # Remove a server
claude mcp add -s user name -- cmd # Add/replace a server
```

## Secret Management

**Never commit secrets.** The pattern:

| File | Contains | Checked In |
|------|----------|------------|
| `.env.mcp.example` | Masked placeholder values | Yes |
| `.env.mcp` | Real secret values | No (gitignored) |
| `.mcp.json.example` | MCP config with placeholder tokens | Yes |
| `.mcp.json` | MCP config with real tokens | No (gitignored) |
| `forge.config.example.json` | Orchestrator config template | Yes |
| `forge.config.json` | Your orchestrator config | No (gitignored) |

The setup script (`scripts/setup-mcp.sh`) automatically loads `.env.mcp` if
present, so exported env vars are available to MCP servers.

## SKILL Files

Skills provide domain-specific knowledge to Claude Code agents.
Located in `skills/<name>/SKILL.md`.

### Available Skills

| Skill | Category | Relevant Project |
|-------|----------|-----------------|
| `code-review` | quality | All |
| `layered-testing` | testing | All |
| `pr-workflow` | workflow | All |
| `stacked-pr-review` | workflow | Forge (review phase) |
| `canvas-game` | frontend | trafficGame |
| `docker-compose` | infrastructure | simplarr |
| `terraform-iac` | infrastructure | GitWeave |
| `wsl-development` | tooling | env-optimiser |

### Using Skills

Skills are referenced by agents during their work — they're loaded from the
`skills/` directory when relevant. No manual invocation needed.

To add a new skill:
```bash
mkdir skills/my-skill
# Create skills/my-skill/SKILL.md with YAML frontmatter
```

## CLI Tools

These tools should be installed on your system for full functionality:

| Tool | Required By | Install |
|------|-------------|---------|
| `gh` (GitHub CLI) | Review phase, PR workflow | `apt install gh` or `brew install gh` |
| `docker` | simplarr, Docker MCP | Docker Desktop |
| `terraform` | GitWeave, Terraform MCP | `tfenv install 1.14.7` |
| `node` 18+ | All TypeScript projects | `nvm install 22` |
| `python3` | env-optimiser | System Python or pyenv |
| `tmux` | Forge UI | `apt install tmux` |
| `playwright` | trafficGame E2E | `npx playwright install` |

## Agent Definitions

Located in `agents/*.md`. Each agent has a YAML frontmatter defining its
role, tools, and optional model override.

| Agent | Role | Model |
|-------|------|-------|
| `architect` | System design, ADRs | Opus |
| `planner` | Work item breakdown | Sonnet |
| `developer` | Implementation, bug fixes | Sonnet |
| `pr-reviewer` | PR review, merge decisions | Sonnet |
| `researcher` | Pattern discovery | Haiku |

Model overrides are configured in `forge.config.json` under `models`.

## Everything Claude Code (ECC)

The ECC plugin is installed at `~/.claude/everything-claude-code/` and provides
additional agents, skills, and rules. Key additions:

- **Agents**: build-error-resolver, security-reviewer, refactor-cleaner, tdd-guide
- **Skills**: tdd-workflow, verification-loop, security-review, backend-patterns
- **Rules**: coding-style, testing, git-workflow (in `~/.claude/rules/common/`)

## Configuration Files

| File | Purpose | Scope |
|------|---------|-------|
| `~/.claude.json` | Claude Code global config (model, MCP) | All projects |
| `~/.claude/settings.json` | Permissions, hooks, plugins | All projects |
| `~/.claude/rules/common/*.md` | Global rules (coding style, testing) | All projects |
| `CLAUDE.md` | Project instructions | This project |
| `forge.config.json` | Orchestrator config | This project |
| `.mcp.json` | Project MCP servers | This project |
