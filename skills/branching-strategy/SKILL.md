---
name: branching-strategy
category: git
description: Layered Trunk branching strategy for multi-agent development — worktree isolation, dependency layers, Ship/Show/Ask merge classification.
---

## When to Use This Skill

- When creating branches for work items (especially with multiple agents)
- When deciding merge strategy for completed PRs
- When resolving conflicts between agent-produced branches
- When setting up worktree isolation for parallel work

## Strategy: Layered Trunk

Trunk-based development adapted for multi-agent workflows. Agents work in isolated
worktrees on short-lived feature branches. PRs are classified by risk to determine
merge behavior.

### Principles

1. **Main is always deployable** — all PRs pass CI before merge
2. **Short-lived branches** — hours, not days. Small PRs merge fast
3. **Worktree isolation** — each agent works in its own git worktree, never touching another's working tree
4. **Dependency layers** — PRs that depend on other PRs are grouped into merge layers; layer N merges only after layer N-1
5. **Rebase over merge** — linear history, easy bisect

## Branch Naming

```
feat/<project>-<work-item-slug>     # Features from roadmap items
fix/<project>-<pr-number>-round-N   # Fix branches for review feedback
```

## Worktree Lifecycle

Each agent gets an isolated worktree. The worktree is created from the latest main
(or parent branch for stacked PRs) and cleaned up after the PR is created.

### Create Worktree

```bash
# Create from latest main
git worktree add .forge/worktrees/<name> -b <branch-name> origin/main

# Create from parent branch (stacked PR)
git worktree add .forge/worktrees/<name> -b <branch-name> origin/<parent-branch>
```

### Work Inside Worktree

```bash
# All agent work happens inside the worktree directory
cd .forge/worktrees/<name>

# Agent makes changes, commits, pushes
git add -A && git commit -m "feat: implement feature X"
git push -u origin <branch-name>
```

### Create PR from Worktree

```bash
# Create PR targeting main (or parent branch for stacked)
gh pr create \
  --title "feat: short description" \
  --body "## Why\n\nMotivation.\n\n## Approach\n\nDetails." \
  --base main \
  --head <branch-name>

# For stacked PRs — target the parent branch
gh pr create \
  --base <parent-branch> \
  --head <branch-name> \
  --title "feat: builds on parent feature"
```

### Cleanup Worktree

```bash
# Remove worktree after PR is created and pushed
git worktree remove .forge/worktrees/<name> --force
```

## Merge Classification: Ship / Show / Ask

Classify each PR by risk level to determine merge behavior.

| Class | Risk | Merge Strategy | Examples |
|-------|------|----------------|----------|
| **Ship** | Low | Auto-merge after CI passes | Typo fixes, dep bumps, test additions, docs |
| **Show** | Medium | Merge, notify for async review | Feature implementation matching approved plan, refactors within module |
| **Ask** | High | Block until human approves | API changes, schema migrations, security-sensitive, cross-module refactors |

### Auto-merge Setup (Ship)

```bash
# Enable auto-merge on a Ship-class PR
gh pr merge <number> --auto --squash

# Check merge status
gh pr checks <number>
```

### Show — Merge + Notify

```bash
# Merge when CI passes, leave a comment for visibility
gh pr merge <number> --squash --delete-branch
gh pr comment <number> --body "Merged — async review welcome."
```

### Ask — Block for Review

```bash
# Request review from specific user
gh pr edit <number> --add-reviewer <username>

# Check review status
gh pr view <number> --json reviewDecision,reviews
```

## Dependency Layers

Work items form a DAG. Each item's merge layer = max(parent layers) + 1.
Items with no dependencies are layer 0.

```
Layer 0: [PR#1, PR#2, PR#3]     — merge first, no deps
Layer 1: [PR#4 (deps: #1,#2)]   — merge after layer 0
Layer 2: [PR#5 (deps: #4)]      — merge after layer 1
```

### Merge Order Enforcement

```bash
# Check if a PR's dependencies are merged
for dep in <dep-pr-numbers>; do
  state=$(gh pr view "$dep" --json state --jq '.state')
  if [ "$state" != "MERGED" ]; then
    echo "Blocked: PR #$dep not yet merged"
    exit 1
  fi
done

# Rebase onto main after dependencies merge (resolves accumulated diffs)
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

## Conflict Resolution

Agents resolve their own conflicts using the project's tests as arbiter.

```bash
# Rebase onto latest main
git fetch origin main
git rebase origin/main

# If conflicts:
# 1. Resolve automatically where possible
# 2. Run tests to verify resolution
# 3. If tests fail, escalate to user

# Force-push the rebased branch (safe — feature branch, not shared)
git push --force-with-lease origin <branch-name>
```

### Escalation Rules

- Conflict in test files → agent resolves (tests are the source of truth)
- Conflict in config/schema → escalate to user
- Conflict in files owned by another PR → escalate (file ownership check)
- 3+ failed rebase attempts → escalate with context

## PR Status Checks

```bash
# View PR state and mergeability
gh pr view <number> --json state,mergeable,mergeStateStatus

# List all open PRs for a project
gh pr list --label "<project>" --state open --json number,title,mergeable

# View CI check status
gh pr checks <number>

# View PR diff stats
gh pr diff <number> --stat
```

## Scaling Behavior

| Agents | Strategy |
|--------|----------|
| 1 | Sequential branches, no conflicts possible |
| 2-3 | Worktree isolation, file ownership advisory |
| 4-6 | Shared build queue, worktree isolation mandatory, merge queue for layer 0 |

The shared build queue ensures that even with 6 agents working in parallel worktrees,
only `build.capacity` agents run build/test commands at once. Others continue
non-build work (code generation, research, file editing) while waiting for a build slot.
