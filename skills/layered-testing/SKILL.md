---
name: layered-testing
category: testing
description: Design and implement tests at multiple layers following the project's layered testing strategy.
---

## When to Use This Skill

- When creating tests for any new feature or work item
- When establishing test infrastructure for a project
- When evaluating test coverage of existing code

## Layered Testing Approach

### Unit Tests
- **Purpose:** Verify isolated logic and pure functions
- **Scope:** Single function or class
- **Speed:** Must be fast (< 100ms per test)
- **Isolation:** Mock external dependencies, test logic only
- **When:** Always — every piece of logic gets unit tests

### Integration Tests
- **Purpose:** Validate component boundaries and contracts
- **Scope:** Module interactions, API contracts, database queries
- **Speed:** Can be slower but should use in-memory alternatives where possible
- **Isolation:** Real components, mocked external services
- **When:** When components interact across boundaries

### E2E Tests
- **Purpose:** Confirm critical user flows work end-to-end
- **Scope:** Full system paths from input to output
- **Speed:** Accept slower execution for confidence
- **Isolation:** Real system, may use test fixtures
- **When:** For critical user-facing flows

### Explorative Tests
- **Purpose:** Discover edge cases through property-based or fuzz testing
- **Scope:** Domain-specific risk areas (parsing, crypto, data transforms)
- **Speed:** May run many iterations
- **When:** When the domain has complex input spaces

## Test Quality Checklist

1. Tests validate behavior, not implementation details
2. Test names read like specifications
3. Arrange-Act-Assert structure
4. Descriptive assertions (not just truthy/falsy)
5. Independent tests (no shared mutable state)
6. Deterministic (no flaky tests)
7. Edge cases covered (empty, null, boundary values)
8. Error scenarios tested explicitly
