---
note_type: project-overview
project: guestpost-platform
updated: 2026-06-15
memory_branches:
  - identity-auth.md
  - billing-payments.md
  - orders-fulfillment.md
  - marketplace.md
  - settlements.md
  - publisher-payouts.md
  - infrastructure.md
  - security.md
---

# Project

## What this project is

Multi-tenant marketplace platform connecting customers (buyers of guest posts/backlinks) with publishers (website owners who publish content). Includes wallet-based payment system, order fulfillment workflow, settlement/payout system, and marketplace listings.

**Status**: Beta hardened + load-proven — 1000 concurrent users, zero money drift, full automated test suite (115 unit + 26 integration + 16 concurrency).

Stack: Node.js 22, TypeScript, NestJS 11 API + Next.js 15 frontends (portal, publisher, admin, website) + BullMQ workers + PostgreSQL 17 + Redis 7 + MinIO. pnpm 11 monorepo with Turbo 2.

## Architecture decisions

- **ActiveContext over Better-Auth session attributes**: decoupled from auth provider, immediate context changes, easy to query/validate
- **Version-based optimistic concurrency** on Wallet, PublisherBalance, Settlement — prevents race conditions without pessimistic locks
- **Transaction.reference @@unique**: database-level duplicate prevention for webhooks
- **Business-action endpoints** replace generic status transitions — each action validates actor type, org ownership, status, and business rules
- **Settlement dual-approval**: both customer + admin must approve before release; dispute blocks release
- **ActorTypeGuard**: separates CUSTOMER, PUBLISHER, and STAFF domains at controller/endpoint level
- **In-transaction audit logging**: all hot money paths pass `tx` to `audit.log` to prevent pool-deadlock
- **HMAC-signed queue payloads**: BullMQ jobs signed via `QUEUE_SIGNING_SECRET`
- **Phase 7.0 observability triad** (find / understand / trace failures):
  - **Sentry across all 3 runtimes** — API, worker, browser+server+edge per Next.js app. DSN-controlled (no-op without `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN`). Shared `initSentry()` in `packages/shared/src/observability/` accepts the consumer's Sentry module as a parameter so packages/shared takes no SDK dep. Closed runtime-tag registry (14 literals) — wrong tag = compile error.
  - **X-Request-ID correlation** via `AsyncLocalStorage` in `packages/shared/src/observability/request-context.ts`. NestJS middleware validates incoming header against `^[A-Za-z0-9_-]{1,128}$` (rejects control chars, newlines for log poisoning, non-ASCII, overlong), generates fresh `crypto.randomUUID()` if absent. ID propagates: API middleware → `AuditLog.metadata.requestId` (no migration — uses existing JSON column) → enqueued worker job (signed payload) → worker `runWithRequestId` wrapper → worker-side audit writes inherit it → Sentry scope tag on all 3 runtimes.
  - **Business-context tagging** — `setBusinessContext()` sets Sentry tags from `{userType, staffRole, customerRole, publisherRole, organizationId, publisherId, orderId, ticketId, settlementId, fulfillmentChannel, serviceType}`. Wired in NestJS interceptor (API), `attachObservability` factory (worker), `AuthProvider useEffect` (each frontend app).
  - **Worker health server** — raw `node:http` on `WORKER_HEALTH_PORT` (default 3004): `/health` (liveness), `/ready` (Redis ping + Prisma SELECT 1, 503 on failure), `/metrics/queues` (per-queue + totals via BullMQ `getJobCounts`). No Express dep.
  - **Worker `unhandledRejection` policy** — exit-after-flush by default (money-worker safety: corrupt in-memory state should not continue). Override via `UNHANDLED_REJECTION_EXIT=false` for dev. `uncaughtException` always exits.
  - **`beforeSend` redaction filter** — strips 3 headers (`Authorization`, `Cookie`, `Set-Cookie`) + redacts 10 key names (`password`, `accessToken`, `refreshToken`, `apiKey`, `paymentMethod`, `paymentMethodId`, `verificationToken`, `encryptedPayload`, `webhookSecret`, `signature`) recursively. New sensitive fields must be added to `REDACTED_KEYS` in `sentry-init.ts`.
  - **Self-test log on startup** — every runtime emits exactly one `[SENTRY] enabled runtime=X release=Y environment=Z` or `[SENTRY] disabled (no DSN) runtime=X` line for deploy-time grep verification.

## Project structure

- `apps/api` — NestJS REST API (:4000)
- `apps/worker` — BullMQ background jobs (email, notification, report, verification, payout)
- `apps/portal` — Customer portal Next.js (:3001)
- `apps/publisher` — Publisher dashboard Next.js (:3002)
- `apps/admin` — Staff admin panel Next.js (:3003)
- `apps/website` — Public marketing site Next.js (:3000)
- `packages/database` — Prisma schema + client (50 models)
- `packages/shared` — Types, constants, queue configs, payout status
- `packages/auth` — Better-Auth configuration
- `packages/api-client` — Frontend API client
- `packages/ui` — Shared React components
- `scripts/` — Seed, integration-test, concurrency-test, load-test

## Key domains

- **Identity/Org** — Multi-tenant orgs with CUSTOMER (OWNER/MEMBER), PUBLISHER (PUBLISHER_OWNER/MEMBER), and STAFF user types → `Memory/identity-auth.md`
- **Billing** — Wallet-based payments with Stripe; reserve→capture→release; version-based concurrency → `Memory/billing-payments.md`
- **Orders** — Full lifecycle DRAFT→COMPLETED with business-action endpoints, 18 states, sub-services → `Memory/orders-fulfillment.md`
- **Marketplace** — Listing discovery, categories, reviews, favorites, AI recommendations → `Memory/marketplace.md`
- **Settlements** — Dual-approval settlement, 20% fee, tier-based review windows → `Memory/settlements.md`
- **Publisher Payouts** — Withdrawals with tier holds, encrypted payout methods, Wise/Stripe/Manual adapters → `Memory/publisher-payouts.md`
- **Infrastructure** — Docker Compose, CI/CD, env config → `Memory/infrastructure.md`
- **Security** — Audit logging, encryption, webhook verification, guards, RBAC → `Memory/security.md`
