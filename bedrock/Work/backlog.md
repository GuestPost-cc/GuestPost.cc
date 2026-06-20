---
note_type: backlog
project: guestpost-platform
updated: 2026-06-20
---

# Backlog

Forward roadmap after the Phases 6.6 → 7.7 audit batch. Canonical source for per-finding status is `bedrock/Views/audits/platform-audit-2026-06-15.md` §11.

**Critical-finding status: 11/11 closed** (Phase 7.6 closed the last one, #9 Mobile UX). All remaining items are High / Medium / strategic.

**2026-06-16 roadmap pivot** (post-Phase-7.7): future work is bundled into Phase 7.8 (Security Hardening) and Phase 7.9 (Frontend Quality & Accessibility) per the project-direction prompt. Phase 7.6.1 is approved but deferred into 7.9.

## Next (named follow-ups from the batch)

- [x] **Phase 7.7.x — complete structured-logger sweep.** ✅ DONE 2026-06-16 (commit `5af902c` on PR #1). All 8 worker files swept (85 callsites → logger.*); 4 stale `.js`/`.map` build artifacts removed; allowlist trimmed to forever-allowed entries only (`apps/api/src/main.ts` boot fallback + 3 browser `auth.tsx`).
- [x] **Phase 7.7.y — fix 3 pre-existing failing test specs** ✅ DONE 2026-06-16 (PR #4 merged, 3 commits `aa8cd55` + `74c8d51` + `b670493`). All 3 specs' mocks updated to match Phase 6.x production behavior; `testPathIgnorePatterns` back at jest default; apps/api jest now 33 suites / 478 tests with zero skips. No production code changed.
- [ ] **Phase 7.13.1 — `Settlement(status, reviewEndsAt)` composite index** via `CREATE INDEX CONCURRENTLY`. Tiny migration. Phase 7.3 auto-approve worker sweep hits this every 15m. **Unblocked by Phase 7.13** (Prisma 7 landed 2026-06-20). Next-up: simplest possible use of the new directive, pure read-path optimization with no app-layer change — surfaces any 7.x CONCURRENTLY behavior surprises on a low-stakes change.
- [ ] **Phase 7.13.2 — `MarketplaceFavorite(userId, listingId, serviceType)` partial unique index** via `CREATE INDEX CONCURRENTLY`. Closes the Phase 7.12.1 `addFavorite` TOCTOU race. Index addition + simplifies code (deletes the existing `findFirst + create` emulation in `marketplace.service.ts`). **Unblocked by Phase 7.13.**
- [ ] **Phase 7.14 — #23 fulfillment claim race fix.** Partial unique index on `FulfillmentAssignment(orderId)` WHERE status IN (ASSIGNED, IN_PROGRESS) via `CREATE INDEX CONCURRENTLY`, AND app-layer change at `order-fulfillment-assignment.service.ts:50-72` (constraint-enforced upsert + P2002 handling + user-facing error). **Unblocked by Phase 7.13**; highest business impact; lands LAST in the sequence after 7.13.1 + 7.13.2 prove the new directive works in production.

## Phase 7.13 — Prisma 6.19.3 → 7.8.0 + driver-adapter migration ✅ DONE

- [x] **Bump prisma + @prisma/client 6.19.3 → 7.8.0; add @prisma/adapter-pg + pg + @types/pg** ✅ DONE 2026-06-20 (commit `2ca6f70`). Touched both PrismaClient instantiation sites: `packages/database/src/index.ts` singleton + `apps/api/src/common/prisma.service.ts` NestJS service. Pool tuning (`max: 25`, `idleTimeoutMillis: 20_000`) moves from `?connection_limit=25&pool_timeout=20` URL params into the `PrismaPg(PoolConfig)` form. `buildDatasourceUrl` helper deleted. Removed `url = env("DATABASE_URL")` from `schema.prisma` + `engine: "classic"` from `prisma.config.ts` + `cp src/prisma/*.node` from `db:build` (no native binary under WASM Query Compiler). 74 files / +1152 −383.
- [x] **Rename Decimal import path: runtime/library → runtime/client** ✅ DONE 2026-06-20 (commit `5d6f49b`). Mechanical sweep across 15 apps/api files (4 production services + 11 specs). Single-pattern sed, 15/+15/-15.
- [x] **Worker `$disconnect` on graceful shutdown** ✅ DONE 2026-06-20 (commit `73b88cd`). Pre-existing gap surfaced + made load-bearing by the adapter migration — `apps/worker/src/index.ts:263-279` shutdown never released PrismaClient connections (fine under classic Rust engine, leaks under node-pg Pool). Slotted between health-server close and Sentry.flush. 1 file / +5 lines.
- [ ] **Phase 7.13.x follow-up — `createPrismaClient()` unification helper.** Both PrismaClient sites currently duplicate the adapter wiring (~3 lines each). Right long-term shape; deferred from this PR to avoid scope creep on a sensitive upgrade. Will land as a small follow-up once Prisma 7 is proven stable in production.
- [ ] **Schema-drift cleanup follow-up — orphaned `EscrowStatus` enum.** Phase 0 v2 pg_dump diff vs fresh-DB snapshot surfaced 151 lines of pre-existing drift: an `EscrowStatus` enum lives in the live dev DB but no current migration creates it (left over from `migrations_archive/`). Separate concern; not a Phase 7.13 blocker. Should land as a `DROP TYPE IF EXISTS "EscrowStatus" CASCADE` migration or as part of a broader `migrations_archive/` review.

Mission: Foundational dep upgrade / unlocks the audit's named "most valuable uncompleted roadmap item" / enables 7.13.1 + 7.13.2 + 7.14 fast-follows via `CREATE INDEX CONCURRENTLY` (prisma#14456).

## Phase 7.8 — Security Hardening Batch (per 2026-06-16 roadmap) ✅ DONE

- [x] **#26 — Email-keyed rate limiter** on auth endpoints. ✅ DONE 2026-06-17 (PR pending; commits `7a12a1e` + `f3fe975`). Better Auth plugin layers per-`SHA-256(email)` Redis counter on 4 verified endpoints (`/sign-in/email`, `/sign-up/email`, `/sign-in/magic-link`, `/request-password-reset`) on top of the existing per-IP Express limiter. Generic 429 byte-identical between layers (no enumeration oracle).
- [x] **#27 — Job-signing `iat` validation / replay protection** ✅ DONE 2026-06-17 (**Deploy A**; commits `058fa7e` + `f489e2e`). `signJobPayload` injects `iat`+`v: 1`; `verifyJobPayload` enforces 24h default freshness (per-queue overrides: delivery-verification 96h, payout 72h). Centralized `apps/worker/src/repeatable-job-registry.ts` with drift guard handles cron-payload reuse via `maxAgeMs: 0` bypass.
- [x] **§5.8 sub-finding — `hasAuthCredentials()` cookie sniff** ✅ DONE 2026-06-17 (commit `81174ee`). Regex written against captured Better Auth signed-cookie shape; 14-case unit test.
- [x] **#25 — Email-verification gate** ✅ DONE 2026-06-17 (commit `4dbfd67`). AuthGuard rejects state-changing methods on non-exempt customer routes when `emailVerified=false`. Bundled into Phase 7.8 per "related auth/session follow-ups".
- [x] **Deploy B — flip `allowMissingIat` default to `false`** ✅ DONE 2026-06-18 (commit `0e9eca1`). One-line flip in `ROLLOUT_DEFAULTS` plus docblock + 2 spec assertions rebadged. Pre-flight greps confirmed (a) no production callsite passes `allowMissingIat` explicitly and (b) all 10 worker processors emit the standard `"job signature invalid — rejecting"` log on a verify-failure (set-equality with `verifyJobPayload` callsites). The opt-in survives as an explicit emergency-rollback arg on `verifyJobPayload`. PR scheduled to merge ≥48h after Phase 7.8 (i.e. ≥ 2026-06-19 17:38 UTC).

Mission: Authentication / Authorization / Replay protection / Anti-abuse in one cohesive phase. **Status: complete (Deploy A + Deploy B both shipped).**

## Phase 7.12 — Marketplace Correctness Bundle (#16 + #17 + #18 + #20 + #24) ✅ DONE

- [x] **#16 — `removeFavorite` blasts service-scoped waitlist favorites** ✅ DONE 2026-06-18 (commit `04969b6`). Scoped to `serviceType: null`; new `removeFavoriteService` for service-scoped removal.
- [x] **#17 — No endpoint to create service-scoped (WAITLIST notify-me) favorite** ✅ DONE 2026-06-18 (commit `04969b6`). `addFavorite(userId, listingId, serviceType?)` + `CreateFavoriteDto.serviceType` + new `DELETE /favorites/:listingId/services/:serviceType` route with `ParseEnumPipe`. Service-existence pre-check rejects favorites scoped to PAUSED services. Phase 6 WAITLIST fan-out logic (existed for years at `marketplace.service.ts:728-749`) finally has an entry point.
- [x] **#18 — Auto-assignment writes customer's userId instead of the staffer** ✅ DONE 2026-06-18 (commit `1913b6e`). `assignedByUserId: snapshot.managedByUserId` (self-assignment by the system). The `auto: true` metadata flag still disambiguates.
- [x] **#20 — Favorites page shows $0 (response missing `services`)** ✅ DONE 2026-06-18 (commit `04969b6`). `getFavorites` includes services filtered to non-PAUSED, ordered by price asc.
- [x] **#24 — Platform website + auto-listing defaults wrong** ✅ DONE 2026-06-18 (commit `74857fc`). `verificationStatus: WebsiteVerificationStatus.VERIFIED` on platform website (matches schema comment); auto-listing `status: ListingStatus.DRAFT` (no more zero-service APPROVED listings going live).
- [ ] **Phase 7.12.1 follow-up — harden `MarketplaceFavorite` against duplicate-create race.** `addFavorite`'s `findFirst + create` pattern has a TOCTOU window if two concurrent identical requests arrive — Phase 0a confirmed dev DB is NULLS DISTINCT, so duplicate NULL-serviceType rows are possible. Out of scope for #17 (not the audit finding being fixed); low impact (WAITLIST fan-out de-dupes via findMany). Apply the same partial-unique-index pattern #23 will introduce when Prisma 6 → 7.4+ lands.

Mission: Marketplace correctness / closing the audit's remaining High findings except #23 / closing audit dashboard from 25/31 → 30/31 (97%).

## Phase 7.11 — Worker SSRF + DoS Hardening (#13 + #14) ✅ DONE

- [x] **#13 — Delivery-verification no response-body size cap** ✅ DONE 2026-06-18 (commits `0d954c5` + `5c5090d`). New `readBodyWithCap(res, maxBytes)` in `@guestpost/shared` streams the body, cancels the reader on overrun, throws `SafeFetchError("BODY_TOO_LARGE")`. Cap = 5MB in both worker fetch processors.
- [x] **#14 — DNS rebinding in SSRF guard** ✅ DONE 2026-06-18 (commits `0d954c5` + `5c5090d`). New `safeFetch()` in `@guestpost/shared` uses an undici Agent whose `connect.lookup` callback resolves DNS AND validates the resolved IP against `PRIVATE_IP_PATTERNS` inside the same callback. Connection binds to the validated IP — no TOCTOU window for AWS metadata bypass. Pure `validateResolvedAddress(hostname, address)` function lifted out for direct testability.
- [x] **Bonus — IPv4-mapped IPv6 patterns** ✅ DONE 2026-06-18. `PRIVATE_IP_PATTERNS` gains 6 new patterns covering `::ffff:127.0.0.1` style addresses that the legacy local duplicates missed.
- [x] **Adoption regression guard** ✅ DONE 2026-06-18 (commit `5c5090d`). `apps/api/src/__tests__/phase-7-11-safe-fetch-adoption.spec.ts` greps `apps/worker/src/processors/*.ts` for the deleted forbidden patterns + bare `await res.text()`. Failure message includes the rule's `why` so a future copy-paster sees the explanation.

Mission: Worker security hardening / shared safe-fetch primitive / defense-in-depth against SSRF + DoS.

## Phase 7.10 — Email Verification Flow (closes the Phase 7.8 #25 loop) ✅ DONE

- [x] **Wire Better Auth `emailVerification` block end-to-end** ✅ DONE 2026-06-18 (commits `77aeb99` + `882fc99` + `b0bd628`). Phase 7.8 #25 shipped the AuthGuard gate as a one-way trapdoor — no verification email was ever sent, so email/password signups were locked out indefinitely with no recovery path. Phase 7.10 wires `sendEmail` + `onEmailVerified` factory options on `createAuth` → Better Auth's `emailVerification.sendVerificationEmail` enqueues via the worker email queue; `sendOnSignUp: true` triggers automatically; `autoSignInAfterVerification: true` lands users back in `/dashboard`; `afterEmailVerification` invalidates the AuthGuard auth-context-cache immediately (no 30s stale-cache window). Customer-facing banner with 60s client cooldown + Resend button mounted in portal dashboard layout. Presentational shell at `packages/ui/src/components/email-verification-banner.tsx` so future publisher/admin verification gates (KYC, 2FA) can reuse without copy-paste.
- [x] **Phase 0 spike — verify Better Auth 1.6.14 contracts** ✅ DONE 2026-06-18. Found `emailVerification.afterEmailVerification(user, request?)` purpose-built callback at `@better-auth/core/dist/types/init-options.d.mts:528` — simpler than `databaseHooks.user.update.after` (no previous-row inspection, fires only on the verification transition). Confirmed `/api/v1/auth/send-verification-email` accepts `{ email, callbackURL? }` per its Zod body schema. `sendOnSignUp` lives in `emailVerification`, not `emailAndPassword`.
- [ ] **Phase 7.10.1 follow-up — admin "manually mark customer verified" action.** Speculative; defer until real support burden surfaces. If a customer can't receive emails (deliverability issue, typo in signup) they're stuck unless admin can override. One-line admin endpoint + RBAC gate + audit log entry.
- [ ] **Phase 7.10.2 follow-up — Nest + supertest HTTP integration test infrastructure.** The Phase 7.10 plan's case (e) (full HTTP-level unverified → verify-link → immediate-protected-POST chain) was scoped down to function-level unit tests because the repo has no Nest+supertest harness today. Each link of the chain IS proven individually (sendEmail callback fires, afterEmailVerification fires, cache invalidates) but the end-to-end HTTP request flow is currently only covered by manual smoke. Build the harness once → unlocks similar integration tests for AuthGuard / RBAC / queue-replay protection.

Mission: Auth UX completeness / closing the Phase 7.8 #25 lockout / shared verification UI primitive.

## Phase 7.9 — Frontend Quality & Accessibility (per 2026-06-16 roadmap) ✅ DONE

- [x] **#28 — Status-color centralization** ✅ DONE 2026-06-18 (commits `0a48f23` + `ea29e26`). Typed `STATUS_PRESENTATION` tables backed by Prisma enums + 5 per-family accessors in `@guestpost/ui`. Cross-family confusion fails `tsc`. 9 status pages migrated.
- [x] **#29 — Unused shared component adoption** ✅ DONE 2026-06-18 (commit `36fc4ee`). `<SupportPanel>`, `<FulfillmentChannelBadge>`, `<BriefRenderer>` all have real consumers; `OrderSupportPanel` hand-roll + 2 local `ChannelBadge` definitions deleted. Adoption regression guard at `packages/ui/src/components/__tests__/shared-component-adoption.test.ts`.
- [x] **#30 — Hooks-rule violation in publisher listings page** ✅ DONE 2026-06-18 (commit `510993b`). 4 inline `useMutation` calls + `lifecycleOpts(label)` helper. Bonus: ESLint rider surfaced + fixed 9 additional latent rules-of-hooks violations in `apps/admin/marketplace/page.tsx`.
- [x] **Phase 7.6.1 — Drawer a11y polish** ✅ DONE 2026-06-18 (commits `8c9d868` + `e90ea34`). New `<Drawer>` on Radix Dialog provides focus trap + Escape + scroll-lock + `aria-modal` + focus restore. 3 dashboards ported; portal layout also gained the pathname-auto-close it was missing since Phase 7.6.
- [x] **ESLint rider** ✅ DONE 2026-06-18 (commit `510993b`). Root `eslint.config.mjs` (tight rule set) + `lint` scripts on portal/admin/publisher + CI steps in both workflows. Catches future rules-of-hooks regressions at PR time.

Mission: Frontend consistency / Accessibility / Maintainability / Shared patterns.
- [ ] **Phase 7.0.1 observability follow-ups.** Three small items, can batch into one migration / one PR:
  - Promote `requestId` from `AuditLog.metadata` JSON to a dedicated indexed column + backfill
  - Structured logger to replace `console.log` across api+worker (then `requestId` is grep-able in plain logs, not just Sentry context + audit DB)
  - Source-map upload via `SENTRY_AUTH_TOKEN` in CI (one-line `withSentryConfig` flip + `@sentry/cli` `pnpm-workspace.yaml` true-flip)
- ~~**#26** Email-keyed rate limiter~~ — **CLOSED** by Phase 7.8.
- ~~**#27** Job-signing `iat`~~ — **CLOSED** by Phase 7.8 (Deploy A + Deploy B).
- ~~**#28** Status-color centralization~~ — **CLOSED** by Phase 7.9.
- ~~**#29** Unused shared component adoption~~ — **CLOSED** by Phase 7.9.
- ~~**#30** Hooks-rule violation~~ — **CLOSED** by Phase 7.9.

## Later (Phase 7.x.x candidates — only if asked)

- [ ] **Revenue dashboard ergonomics** (if Finance asks): Recharts trend visualizations (`next/dynamic` to avoid bundle inflation), `groupBy=publisherId`, scheduled email reports, user-timezone toggle, multi-currency split.
- [ ] **Metrics layer** if Phase 7.0 structured logs become insufficient: prom-client OR OpenTelemetry-compatible collector reading from the `[SETTLEMENT_AUTO_APPROVE] runs_total=…` and `[NOTIFICATION] deduped key=…` structured lines. Deliberately deferred until existing log discipline proves insufficient.
- [ ] **Cache-key sweep**: settlements/withdrawals/reconciliation/payouts admin pages use bare `["X"]` keys instead of the consistent `["admin", "X", filters]` pattern set by Phase 7.1's Revenue tab. Drift-prone; ergonomic cleanup.
- [ ] **Reconcile portal `TicketDetail` shape** with api-client. Phase 7.1 sibling fix used `as unknown as` to bridge; the two shapes should be unified rather than cast.

## Strategic / re-architecture (long-horizon)

- [ ] **Double-entry ledger** (escrow / revenue accounts) replacing the current single-entry + reconciliation-detector pattern. Provable money conservation, dual-side audit trail, scales better for accounting.
- [ ] **Item-level settlements** if the platform ever supports multi-website orders. Today's one-website-per-order invariant keeps order-level settlements correct.
- [ ] **Provider-side payout reconciliation** (compare Wise / Stripe transfer list vs `PayoutExecution` rows). Catches orphan provider transfers that the local DB doesn't know about.
- [ ] **WebsiteVerification (DNS TXT)** required before listing approval. Phase 7-ish work touched verification triggers but the gate to require it before approval isn't enforced yet.
- [ ] **Order accept/delivery deadlines + timeout sweep** — SUBMITTED orders currently wait forever (reconciliation detector flags them but no auto-cancel).

## Acceptance / ops gaps (carried from prior batches, still open)

- [ ] **VPS-or-cloud shared-dev hosting decision.** Batch 24 confirmed dev stack is too heavy for 2GB RAM. Options: bigger VPS (4GB+), cloud sandbox (Railway / Fly / Render), or production-build-only deployment (`next start` not `next dev`). Today: laptop-only.
- [ ] **Docker image build OOM on 8GB local Docker VM.** Container builds validated through install but final `nest build` OOMs. Open: build on ≥4GB CI runner, then push GHCR.
