# Setup Guide — Forge Orchestrator

## Prerequisites

- **Node.js** >= 22.0.0
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`)
- **GitHub CLI** (`gh`) for PR creation
- **Git** configured with your GitHub credentials

## Claude Code Authentication

Forge uses Claude Code CLI to spawn sub-agents. You need to authenticate Claude Code
with a provider that gives access to Claude models.

### Option 1: GitHub Copilot (Recommended)

If you have a GitHub Copilot subscription with Claude model access:

```bash
# Configure Claude Code to use your Copilot license
claude config set --global provider copilot

# Authenticate (opens browser)
claude auth login
```

This routes all model calls through GitHub's API using your Copilot subscription.

### Option 2: Anthropic API Key

```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Or configure permanently
claude config set --global provider anthropic
claude config set --global apiKey sk-ant-...
```

### Option 3: Amazon Bedrock

```bash
claude config set --global provider bedrock
# Requires AWS credentials configured via aws configure
```

### Option 4: Google Vertex AI

```bash
claude config set --global provider vertex
# Requires GCP credentials configured
```

## Verify Authentication

```bash
# Quick test — should return a response
claude -p "Say hello" --model claude-haiku-4-20250414
```

## Install Forge

```bash
cd /home/parso/sideProjects

# Install dependencies
npm install

# Build
npm run build

# Link globally (optional)
npm link

# Verify
forge --help
# Or without linking:
npm run dev -- --help
```

## Configuration

Optionally create `forge.config.json` in the workspace root to override defaults:

```json
{
  "projects": ["trafficGame", "simplarr", "env-optimiser", "GitWeave"],
  "models": {
    "architect": "claude-sonnet-4-20250514",
    "planner": "claude-sonnet-4-20250514",
    "testEngineer": "claude-sonnet-4-20250514",
    "developer": "claude-sonnet-4-20250514",
    "prCreator": "claude-haiku-4-20250414",
    "reviewer": "claude-sonnet-4-20250514",
    "researcher": "claude-haiku-4-20250414"
  },
  "maxIterations": 10,
  "autoCreatePR": true,
  "researchIntervalHours": 24
}
```

## GitHub CLI Setup

For PR creation, ensure `gh` is authenticated:

```bash
# Install GitHub CLI
# Ubuntu/WSL:
sudo apt install gh

# Authenticate
gh auth login
```

## Usage

```bash
# Run full pipeline for a project
forge run trafficGame

# Run all projects
forge run-all

# Check status
forge status

# Resume a blocked work item
forge resume <work-item-id>

# Run research agent
forge research

# List managed projects
forge projects
```
