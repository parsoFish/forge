---
name: code-review
category: quality
description: Structured code review process focusing on behavior, patterns, and quality gates.
---

## When to Use This Skill

- When reviewing pull requests created by other agents
- When self-reviewing code before committing
- When evaluating existing code quality

## Review Order

1. **Read the PR description** — Understand the WHY before the WHAT
2. **Review tests first** — Do they cover the right behavior?
3. **Review the implementation** — Does it follow patterns and conventions?
4. **Check quality gates** — Lint, types, test pass?
5. **Assess holistically** — Does this make the codebase better?

## Quality Checklist

### Tests
- [ ] Happy path covered
- [ ] Edge cases covered (empty, null, boundary)
- [ ] Error scenarios tested
- [ ] Test names are descriptive specifications
- [ ] No flaky or non-deterministic tests

### Code
- [ ] Follows ecosystem conventions
- [ ] Meaningful names for variables, functions, classes
- [ ] Small, focused functions (single responsibility)
- [ ] Error handling is explicit
- [ ] No dead code or debug artifacts
- [ ] Dependencies are injected, not hard-coded

### Architecture
- [ ] Concerns are separated
- [ ] Patterns are used consistently
- [ ] No unnecessary coupling
- [ ] Changes are scoped to one concern

### Documentation
- [ ] Comments explain WHY, not WHAT
- [ ] Complex logic has explanatory comments
- [ ] Public APIs are documented
- [ ] README updated if behavior changed

## Feedback Severity

- **blocker**: Must fix before merge
- **concern**: Should fix but not blocking
- **nit**: Style/preference, optional fix
