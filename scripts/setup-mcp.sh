#!/usr/bin/env bash
#
# MCP Server Setup for Forge Orchestrator
#
# Installs MCP (Model Context Protocol) servers that enhance Claude Code's
# capabilities when working with this project and its managed sub-projects.
#
# Usage:
#   ./scripts/setup-mcp.sh           # Install all recommended servers
#   ./scripts/setup-mcp.sh github    # Install only the GitHub server
#   ./scripts/setup-mcp.sh --list    # List available servers
#
# Prerequisites:
#   - Claude Code CLI installed (`claude` command available)
#   - Node.js 18+ (for npx)
#   - Environment variables set (see .env.mcp.example)
#
# Secrets:
#   Copy .env.mcp.example → .env.mcp and fill in your values.
#   .env.mcp is gitignored — never commit real tokens.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }
dim()   { echo -e "${DIM}  $1${NC}"; }

# ── Server definitions ────────────────────────────────────────────────

declare -A SERVERS
declare -A DESCRIPTIONS
declare -A ENV_VARS

# GitHub — PR management, issue triage, code search
SERVERS[github]="npx -y @modelcontextprotocol/server-github"
DESCRIPTIONS[github]="GitHub API — PRs, issues, code search, repo ops"
ENV_VARS[github]="GITHUB_PERSONAL_ACCESS_TOKEN"

# Playwright — browser automation for E2E testing
SERVERS[playwright]="npx -y @playwright/mcp@latest"
DESCRIPTIONS[playwright]="Playwright browser automation — E2E testing via accessibility snapshots"
ENV_VARS[playwright]=""

# Terraform — IaC provider schemas, module docs
SERVERS[terraform]="npx -y @hashicorp/terraform-mcp-server"
DESCRIPTIONS[terraform]="Terraform registry — provider schemas, module docs, policy lookups"
ENV_VARS[terraform]=""

# Docker — container lifecycle management
SERVERS[docker]="npx -y docker-mcp"
DESCRIPTIONS[docker]="Docker — container lifecycle (list, start, stop, logs, exec)"
ENV_VARS[docker]=""

# Context7 — up-to-date library/framework documentation
SERVERS[context7]="npx -y @upstash/context7-mcp@latest"
DESCRIPTIONS[context7]="Context7 — live documentation for libraries and frameworks"
ENV_VARS[context7]=""

# Sequential Thinking — structured reasoning for complex tasks
SERVERS[sequential-thinking]="npx -y @modelcontextprotocol/server-sequential-thinking"
DESCRIPTIONS[sequential-thinking]="Sequential thinking — structured multi-step reasoning"
ENV_VARS[sequential-thinking]=""

# Server install order (recommended priority)
RECOMMENDED_ORDER=(github playwright terraform docker context7 sequential-thinking)

# ── Functions ─────────────────────────────────────────────────────────

check_prerequisites() {
  local missing=0

  if ! command -v claude &>/dev/null; then
    error "Claude Code CLI not found. Install: https://claude.ai/code"
    missing=1
  fi

  if ! command -v npx &>/dev/null; then
    error "npx not found. Install Node.js 18+: https://nodejs.org"
    missing=1
  fi

  if [ $missing -ne 0 ]; then
    exit 1
  fi
}

load_env() {
  local env_file="$PROJECT_ROOT/.env.mcp"
  if [ -f "$env_file" ]; then
    dim "Loading environment from .env.mcp"
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

check_env_var() {
  local var_name="$1"
  if [ -z "$var_name" ]; then return 0; fi
  if [ -z "${!var_name:-}" ]; then
    warn "$var_name not set — server may have limited functionality"
    dim "Set it in .env.mcp or export it before running this script"
    return 1
  fi
  return 0
}

install_server() {
  local name="$1"
  local cmd="${SERVERS[$name]}"
  local desc="${DESCRIPTIONS[$name]}"
  local env="${ENV_VARS[$name]}"

  echo ""
  echo -e "Installing ${GREEN}$name${NC} — $desc"

  # Check env vars
  if [ -n "$env" ]; then
    check_env_var "$env" || true
  fi

  # Install via claude mcp add at user scope
  if claude mcp add -s user "$name" -- $cmd 2>/dev/null; then
    info "Installed $name"
  else
    # May already be installed
    warn "Could not install $name (may already exist)"
    dim "Try: claude mcp remove $name && re-run this script"
  fi
}

list_servers() {
  echo ""
  echo "Available MCP servers:"
  echo ""
  for name in "${RECOMMENDED_ORDER[@]}"; do
    local desc="${DESCRIPTIONS[$name]}"
    local env="${ENV_VARS[$name]}"
    local env_label=""
    if [ -n "$env" ]; then
      env_label=" (requires: $env)"
    fi
    printf "  %-22s %s%s\n" "$name" "$desc" "$env_label"
  done
  echo ""
  echo "Install all:     ./scripts/setup-mcp.sh"
  echo "Install one:     ./scripts/setup-mcp.sh <name>"
  echo "Check status:    claude mcp list"
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
  echo "╔══════════════════════════════════════════════╗"
  echo "║     Forge MCP Server Setup                   ║"
  echo "╚══════════════════════════════════════════════╝"

  check_prerequisites
  load_env

  if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
    list_servers
    exit 0
  fi

  if [ $# -gt 0 ]; then
    # Install specific servers
    for name in "$@"; do
      if [ -z "${SERVERS[$name]:-}" ]; then
        error "Unknown server: $name"
        dim "Run with --list to see available servers"
        exit 1
      fi
      install_server "$name"
    done
  else
    # Install all recommended
    echo ""
    dim "Installing all recommended MCP servers..."
    for name in "${RECOMMENDED_ORDER[@]}"; do
      install_server "$name"
    done
  fi

  echo ""
  info "Setup complete. Verify with: claude mcp list"
  echo ""
  dim "To configure secrets, copy .env.mcp.example → .env.mcp"
  dim "and fill in your values. Never commit .env.mcp."
}

main "$@"
