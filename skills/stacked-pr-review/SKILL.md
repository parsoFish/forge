---
name: stacked-pr-review
category: workflow
description: Progressive review of stacked/chained PRs with unique delta isolation and dependency-ordered close-out.
---

## When to Use This Skill

- When reviewing PRs that form dependency chains (stacked branches)
- When PRs from an implementation cycle share files across branches
- When `gh pr diff` shows accumulated changes instead of unique deltas
- When close-out must respect merge ordering (foundation first)

## Core Concept: Layer-by-Layer Review

Stacked PRs that all target `main` accumulate ancestor commits in their diff.
The fix: review and merge in dependency order so each layer's diff is naturally correct.

```
Layer 0 (foundation):  diff against main ← always correct
Layer 1 (depends on 0): after layer 0 merges, diff against updated main ← correct
Layer 2 (depends on 1): after layer 1 merges, diff ← correct
```

## Unique Delta for Stacked PRs

When PRs can't be merged between review rounds, compute the unique delta explicitly:

```bash
# PR B depends on PR A — show only B's unique changes
git diff origin/<A-branch>...origin/<B-branch>

# File stats for the unique delta
git diff --stat origin/<A-branch>...origin/<B-branch>

# Commits unique to B (not in A)
git log origin/<A-branch>..origin/<B-branch> --oneline
```

**Do NOT use `gh pr diff`** for stacked PRs targeting main — it shows the accumulated diff.

## Cross-PR File Awareness

When multiple PRs modify the same files (cross-contamination from implementation):

1. Build a file ownership map: `file → [PR numbers]`
2. Files touched by 2+ PRs are "overlapping" — not a review concern
3. Tell the reviewer which files are shared so it doesn't flag them as "unrelated"

## Close-Out Ordering

1. Close-out items respect `mergeLayer` — lower layers process first
2. Each close-out item depends on its parent layer's close-out
3. After foundation PRs merge, dependent PRs rebase automatically
4. `fix-and-merge` for CONFLICTING PRs, `merge-only` for clean ones

## Anti-Patterns

- Reviewing all stacked PRs simultaneously with accumulated diffs
- Using `gh pr diff` for stacked branches targeting main
- Creating close-out items for all layers at once before merging foundations
- Flagging shared files as "unrelated to this PR" in cross-contaminated branches

## Checklist

- [ ] PRs sorted by merge layer before presentation
- [ ] Unique delta computed for stacked PRs (not accumulated diff)
- [ ] File ownership map built to detect cross-PR overlap
- [ ] Close-out items have correct dependency chain
- [ ] Foundation PRs merge before dependent ones start close-out
