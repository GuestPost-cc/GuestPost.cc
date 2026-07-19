---
note_type: project-memory
project: guestpost-platform
updated: 2026-07-19
---

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

- **apps/api** — NestJS REST API, 876 unit tests + integration tests
- **apps/worker** — BullMQ queue processor
- **apps/portal** — Buyer-facing dashboard
- **apps/admin** — Admin dashboard
- **apps/publisher** — Publisher dashboard
- **apps/website** — Public marketing site
- **packages/shared** — Shared utilities (72 tests)
- **packages/database** — Prisma schema + migrations
- **packages/ui** — Shared component library
- **packages/api-client** — Generated API client

## Key Patterns

- Controllers are thin; business logic lives in dedicated services
- Stripe webhook timestamp validation via shared `assertWebhookTimestampFresh`
- Redis pub/sub for cross-pod auth context invalidation
- Wallet credits have no direct HTTP or API-client mutation surface. Customer
  funding is accepted only through Stripe checkout/webhook verification;
  seed, integration, concurrency, and load setup use test-only Prisma helpers
  that refuse to run with `NODE_ENV=production`.
- Worker deliveries verified via shared `delivery-verification` module (24 tests)
- Job signing with configurable secret (QUEUE_SIGNING_SECRET / JWT_SECRET fallback)
- Publisher integrations are a top-level dashboard area at `/dashboard/integrations`, separate from Settings; sidebar active-state matching uses path-segment boundaries to avoid selecting Settings for integration pages.
- Publisher website ownership is proven via DNS TXT verification, not Google Search Console. GSC links search performance data after OAuth. DNS verification jobs require the worker queue process, and GSC OAuth requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus an authorized redirect URI matching `${API_BASE_URL}/integrations/GOOGLE_SEARCH_CONSOLE/callback`.
- Google OAuth identity is independent of the signed-in GuestPost identity. OAuth always presents Google's account chooser; credentials are encrypted and scoped by integration owner so the same Google account can be connected separately by a publisher and the platform. Callback return paths are app-relative and resolved server-side against the configured publisher/admin origins.
- Platform websites skip DNS and are created with one DRAFT platform listing in the same transaction. An Operations-created site is forcibly assigned to its creator, and new platform orders use that assignment automatically. GSC/GA4 credentials are isolated by platform website; Super Admin and the assigned Operations owner can connect, link, unlink, and sync from the site page.
- Marketplace listings select 1–7 reviewed categories through `MarketplaceListingCategory`, exactly one controlled primary language, and one value for each placement-policy field. Publisher/platform forms cannot write performance metrics; GSC supplies 30-day clicks/impressions and GA4 supplies 30-day sessions/users/pageviews for buyer-safe marketplace summaries.
- Publisher and platform website creation share a browser-safe enlistment validator and repeat the same checks at the API boundary: only public root HTTP(S) URLs are accepted; listing titles cannot be URLs/domains; title, description, name, and country reject HTML/control characters; category IDs are unique and limited to 1–7. Creation DTO validation remains the first boundary, and service validation protects direct/internal callers.
- Order cancellation is a dedicated domain workflow, not a generic status mutation. `packages/shared/src/order-cancellation-policy.ts` owns the stage/channel decision matrix and `OrderCancellationRequest` retains structured case history.
- Pre-acceptance exits are immediate; accepted work requires counterparty consent or Operations review plus Finance approval; published/delivered/completed work uses the dispute path. An active case holds fulfillment and increments `Order.version` to close transition races. Publisher actions require a publisher owner, and platform-fulfiller actions require the assigned Operations user (or Super Admin).
- Paid refunds use one transaction-aware path that reverses platform revenue or publisher settlement, cancels active assignments, credits the organization wallet, transitions the order, and writes ledger/event/audit records together. `Order.refundResponsibility` prevents platform/customer-attributed refunds from lowering publisher trust.
- Refund clawbacks that create publisher debt write an idempotent in-app
  explanation in the same transaction. Later settlement-release notifications
  state the exact amount applied to debt and the amount credited as
  withdrawable funds.
- Publisher-balance invariant checks throw on negative or non-finite
  withdrawable/debt balances so their enclosing financial transaction rolls
  back; PostgreSQL CHECK constraints remain the final data-layer backstop.
- Legacy personal wallets are unique per user through the partial
  `Wallet_userId_personal_key` index (`organizationId IS NULL`). The migration
  safely merges historical duplicates, while organization wallets may retain
  the same creator `userId`.
- Wise/Stripe Connect payout webhooks always receive a deterministic BullMQ
  job ID: provider execution ID first, then a hashed provider event ID, then a
  verified raw-payload hash.
- Platform-fulfilled orders create platform revenue and complete directly rather than creating publisher settlements. Worker sweeps enforce the acceptance and cancellation-response deadlines. Dispute refunds require Finance/Super Admin plus explicit responsibility rather than inferring fault from the listing channel.
- Prisma migrations are an API/worker release prerequisite. Generate the client from the migrated schema, apply migrations before serving requests that select new fields, and verify `prisma migrate status` during the release; otherwise shared reads such as order and billing queries can fail together with HTTP 500 responses.
- The customer portal is an order-focused workbench. Its dashboard uses exact server totals for attention, active work, and delivered results; `/dashboard/orders` is a server-paginated queue with stage, campaign, service, search, and sort controls; campaign and report totals page through the complete tenant-scoped data set rather than silently truncating at the API page limit.
- Customer actions are role-aware in the UI but remain server-authorized. An organization OWNER can act across the organization and manage Billing; a MEMBER can mutate only orders they created. Billing is hidden from member navigation and direct member access fails closed. Wallet display uses authoritative available and reserved balances from the billing API; no payment, refund, payout, or settlement behavior is derived in the client.
- The Super Admin overview is a read-only command center backed by `GET /admin/command-center`. It returns exact server-side workflow counts, a bounded priority queue, lifecycle/health/finance summaries, and sanitized audit activity. The route is `SUPER_ADMIN`-only, sends private no-store headers, excludes audit metadata and decrypted payout data, and leaves all high-impact decisions in the existing reasoned and audited workspaces. Operations and Finance keep their separate role-focused overviews.
- The Finance overview is a Support-first money-operations workbench backed by `GET /admin/finance-workbench`. It is restricted to Finance and Super Admin, uses exact database aggregates and Prisma Decimal money math, returns a bounded server-prioritized decision queue, and exposes only allowlisted/sanitized finance activity. Payout credentials, provider configuration, raw execution errors, audit metadata, and decrypted payout data never enter the overview response; all money mutations remain in the existing reasoned and audited Finance workspaces.
- The Operations overview is an assignment-focused workbench backed by `GET /admin/operations-workbench`. It is restricted to Operations and Super Admin and combines assigned/claimable platform fulfillment, assigned platform Support, operational cancellations and disputes, delivery/domain verification, moderation, and assigned-site readiness into one bounded server-prioritized queue. Only fulfillment is claimable inline; all other decisions deep-link to their existing authorized workspaces. Operations order list/detail reads use the same assignment, assigned-Support, and operational-exception scope and return sanitized contextual identities rather than global-directory or finance data.

## Seed Script (`scripts/seed.ts`)

- Creates 6 dev users via the API (real password hashing), then bootstraps staff roles via DB
- Expects `.env.development` with `DATABASE_URL` (creates from `.env.example` if missing)
- Uses `scripts/env.ts` `loadRootEnv()` to load `.env.development`, stripping inline `#` comments (dotenv-compatible)
- API must be running on `:4000`
- Phases: (1) sign-up users via API, (1b) verify emails via DB, (2) staff bootstrap, (3) roles via admin API, (4) orgs + invites, (5) fund wallet via DB, (6) publisher inventory + marketplace listings (with `ListingService` rows), (7) payout providers
- Wallet funding is test/seed-only and writes the balance plus ledger row
  directly through Prisma; no direct-deposit API endpoint or feature flag exists.
