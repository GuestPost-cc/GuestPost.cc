# Testing

## Test types

| Type | Tool | Location | Coverage target |
|------|------|----------|-----------------|
| Unit (API) | Jest | `apps/api/src/__tests__/` | 80%+ |
| Unit (UI) | Vitest | `packages/ui/src/` | 80%+ |
| E2E | Playwright | `e2e/` | Critical paths |
| Integration | Scripts | `scripts/` | Scenario-based |

## Running tests

```bash
# API unit tests
pnpm --filter @guestpost/api test

# UI component tests
pnpm --filter @guestpost/ui test:coverage

# E2E tests (requires full stack running)
npx playwright test

# Integration tests
pnpm test:integration
pnpm test:concurrency
pnpm test:load
```

## Before committing

`pnpm check` validates the gate (Biome + ESLint + typecheck + depcruise).
Pre-commit hook runs Biome on staged files.

Do NOT commit code that breaks the `main` branch build or test suite.
