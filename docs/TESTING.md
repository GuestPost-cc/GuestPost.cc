# Testing

## Test types

| Type | Tool | Location | Coverage target |
|------|------|----------|-----------------|
| Unit (API) | Jest | `apps/api/src/__tests__/` and module `__tests__/` | 80%+ |
| Contract (API client) | Jest + TypeScript | `packages/api-client/src/__tests__/` | Request/response boundary |
| Unit (UI) | Vitest | `packages/ui/src/` | 80%+ |
| E2E | Playwright | `e2e/` | Critical paths |
| PostgreSQL integration | Jest | `apps/api/src/__tests__/integration/` | Transactions, locks, invariants |
| Scenario integration | Scripts | `scripts/` | Provider/domain journeys |

## Running tests

```bash
# API unit tests
pnpm --filter @guestpost/api test

# API PostgreSQL integration tests (requires the disposable template database)
pnpm --filter @guestpost/api test:integration

# Typed API-client contract tests
pnpm --filter @guestpost/api-client test

# UI component tests
pnpm --filter @guestpost/ui test:coverage

# Browser E2E tests (starts API, customer portal, and publisher portal)
pnpm test:e2e

# Integration tests
pnpm test:integration
pnpm test:concurrency
pnpm test:load
```

## Support messaging gates

The support contract and threat model are documented in
`docs/SUPPORT_MESSAGING.md`. Run these focused checks while changing support:

```bash
# Request paths, bodies, DTO privacy fixtures, sender semantics, and query keys
pnpm --filter @guestpost/api-client exec jest src/__tests__/support.spec.ts --runInBand

# Server policy, projection, idempotency, ordering, and fail-closed role tests
pnpm --filter @guestpost/api exec jest --selectProjects=unit --runInBand support

# Real PostgreSQL serialization/assignment races (after template setup)
pnpm setup:integration-test-db
pnpm --filter @guestpost/api exec jest --selectProjects=integration --runInBand support

# Shared conversation alignment, labels, accessibility, and terminal state
pnpm --filter @guestpost/ui test -- support-conversation
```

The public projection gate must assert that sensitive properties are absent,
not merely `null`: raw `user`, email, files, routing IDs, `participantRole`,
`actorSnapshot`, and `authorEvidence` must not serialize to customer or
publisher clients. Internal notes must be filtered by the server before
projection. Tests must also cover multi-page public inbox traversal without
gaps or duplicates, public-activity ordering that ignores newer internal
activity, unknown staff roles failing closed, exact idempotent replay versus
mismatched-key conflict, deterministic `createdAt`/`id` message ordering,
deleted authors, close/reopen mapping, publisher order authorization, and
reply/status races with reassignment or claim.

There is intentionally no mocked Playwright support test. The current browser
harness has no safe fixture for simultaneous customer, publisher, Operations,
and Super Admin sessions. A real multi-actor support journey remains a paid-
launch acceptance gate; its required assertions are listed in
`docs/SUPPORT_MESSAGING.md`.

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
