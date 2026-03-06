---
name: pr-workflow
category: git
description: Standard workflow for creating branches, committing changes, and opening pull requests.
---

## When to Use This Skill

- When creating feature branches for work items
- When committing completed work
- When creating pull requests

## Branch Naming

```
feat/<project>-<short-description>    # New features
fix/<project>-<short-description>     # Bug fixes
refactor/<project>-<short-description> # Refactoring
docs/<project>-<short-description>    # Documentation
test/<project>-<short-description>    # Test-only changes
```

## Commit Messages

Follow conventional commits:

```
feat: add user authentication with JWT
fix: resolve race condition in queue processing
refactor: extract payment processing into service layer
test: add integration tests for user registration
docs: update API documentation for v2 endpoints
chore: upgrade TypeScript to 5.8
```

Rules:
- Lowercase first letter after prefix
- No period at end
- Imperative mood ("add", not "added" or "adds")
- Subject line under 72 characters

## PR Description Template

```markdown
## Why

[Motivation and context — what problem does this solve?]

## Approach

[Chosen approach and rationale — why this over alternatives?]

## Testing

[Testing strategy — which layers, what behavior is verified]

## Notes

[Follow-up work, caveats, reviewer focus areas]
```

## Workflow Steps

1. `git checkout -b <branch-name>` — Create feature branch
2. Make changes, running tests after each significant change
3. `git add -A && git commit -m "<conventional-commit>"` — Commit
4. `git push origin <branch-name>` — Push
5. `gh pr create --title "<title>" --body "<description>"` — Create PR
