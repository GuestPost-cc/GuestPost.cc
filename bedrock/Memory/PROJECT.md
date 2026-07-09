# GuestPost.cc

**Project**: GuestPost content marketplace — SaaS platform connecting publishers and buyers for guest post placements.

## Tech Stack

- **Backend**: NestJS (apps/api), PostgreSQL via Prisma, Redis (BullMQ queues + caching)
- **Frontend**: Next.js 4 apps (portal, admin, publisher, website), Tailwind, shadcn/ui
- **Payments**: Stripe Connect (Checkout Sessions + PaymentIntents), Wise API (payouts)
- **Language**: TypeScript 6, strict mode, project references
- **Tooling**: pnpm 11, Turbo 2, Biome, opencode

## Audit Status (41 findings)

| Status | Count | Findings |
|--------|-------|----------|
| Closed | 38 | A-1–A-4, B-1–B-3, C-1–C-3, D-1–D-2, E-1–E-2, F-1–F-5, G-1–G-4, H-1–H-3, M-1–M-3, Z-1–Z-6, #23 |
| Partial | 1 | #22 (zero-value settlement semantics) |
| Deferred | 1 | #24 (timestamptz — scheduled pre-GA; operationally correct under UTC-only model) |
| Open | 1 | #25 (soft-delete) |

Open/partial items require architectural design discussion.

## Sprint History

- **Sprint A** (`c701f54`): Closed C-1, C-2, C-3 (3 low-risk findings)
- **Sprint B** (`1670867`): Closed H-3, M-2, M-3, H-1, H-2, M-1 (6 penetration test findings). Added 4 new test files.
- **Sprint C** (`4c8a81b`): Closed #20, #27, #32, #36 (4 low-risk findings). Audit at 37/41 closed.
- **D-1** (evidence-based): Closed #23 — existing `[customerId, status]` index confirmed via EXPLAIN ANALYZE; no code changes. Deferred #24 to pre-GA (functionally correct, UTC-only model).

## Service Architecture

- **apps/api** — NestJS REST API, 754 unit tests + integration tests
- **apps/worker** — BullMQ queue processor
- **apps/portal** — Buyer-facing dashboard
- **apps/admin** — Admin dashboard
- **apps/publisher** — Publisher dashboard
- **apps/website** — Public marketing site
- **packages/shared** — Shared utilities (29 tests)
- **packages/database** — Prisma schema + migrations
- **packages/ui** — Shared component library
- **packages/api-client** — Generated API client

## Key Patterns

- Controllers are thin; business logic lives in dedicated services
- Stripe webhook timestamp validation via shared `assertWebhookTimestampFresh`
- Redis pub/sub for cross-pod auth context invalidation
- Feature flags via `ENABLE_DIRECT_DEPOSIT` env var
- Worker deliveries verified via shared `delivery-verification` module (24 tests)
- Job signing with configurable secret (QUEUE_SIGNING_SECRET / JWT_SECRET fallback)

## Seed Script (`scripts/seed.ts`)

- Creates 6 dev users via the API (real password hashing), then bootstraps staff roles via DB
- Expects `.env.development` with `DATABASE_URL` (creates from `.env.example` if missing)
- Uses `scripts/env.ts` `loadRootEnv()` to load `.env.development`, stripping inline `#` comments (dotenv-compatible)
- API must be running on `:4000`
- Phases: (1) sign-up users via API, (1b) verify emails via DB, (2) staff bootstrap, (3) roles via admin API, (4) orgs + invites, (5) fund wallet via DB, (6) publisher inventory + marketplace listings (with `ListingService` rows), (7) payout providers
- Wallet funding bypasses API deposit endpoint (gated behind `ENABLE_DIRECT_DEPOSIT`) and writes directly via Prisma
