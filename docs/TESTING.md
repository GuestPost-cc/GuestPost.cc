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

# Browser E2E tests (starts API, customer portal, and publisher portal)
pnpm test:e2e

# Integration tests
pnpm test:integration
pnpm test:concurrency
pnpm test:load
```

## Before committing

`pnpm check` validates the gate (Biome + ESLint + typecheck + depcruise).
Pre-commit hook runs Biome on staged files.

Do NOT commit code that breaks the `main` branch build or test suite.

## Browser harness

The Playwright harness targets fixed loopback origins and will not accept a
remote application URL because the onboarding specs create real accounts. Run
`pnpm services:up`, apply all migrations, and then run `pnpm test:e2e`; the
harness starts and stops only the API, customer portal, and publisher portal.
Existing local servers are reused outside CI.

CI supplies an explicit `E2E_RUN_ID`. Fixture emails are deterministically
derived from that run, the test identity, and the retry number, so a retry does
not collide with an account committed by its first attempt. Local runs use a
process-scoped fallback and should target only the disposable Compose database.
Failures retain trace, screenshot, and video evidence under `test-results/`
and an HTML report under `playwright-report/`.
