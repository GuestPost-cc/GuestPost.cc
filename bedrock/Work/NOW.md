---
note_type: now
project: guestpost-platform
updated: 2026-10-02
---

# Current focus

## Reconciliation eligibility and delivery-verification recovery

Branch `fix/reconciliation-wallet-availability-and-delivery-verification`
targets current `origin/main`. It allows the typed refund-credit reversal
when current unreserved wallet balance covers the exact amount; historical
debits alone do not block, while insufficient available funds, disputes, and
ambiguous evidence remain fail-closed. The Admin preview explains the balance
requirement. Customer and publisher order pages refresh while verification is
pending, and the worker recovery sweep now recovers `RETRYING` rows as well as
`PENDING`. No schema migration or staging money mutation is part of this fix.
Focused API/worker tests, API/Admin/Portal/Publisher typechecks, worker build,
lint, and Biome checks pass. Next: review/CI, CodeRabbit and Strix, then deploy
API/worker/Admin/Portal and verify the canary without bypassing insufficient
balance or evidence gates.

## Financial reconciliation repair Phase 2

PR #149 (`fix/staging-reconciliation-single-actor`) adds an explicit
staging-only same-account test path while keeping two-person approval as the
default and production requirement. It requires the existing staging recovery
gates, a new explicit bypass flag, and an administrator-set database-local
role setting for the NOLOGIN `guestpost_financial_repair_staging` capability role, granted to API runtime without SET ROLE. The Admin UI only exposes the
single-account approve/execute controls when the API confirms both its config
and database capability gates. The user's evidence confirms case
`cmun9e6g9001` was an internal wallet credit, not a Stripe refund; no repair has
been executed. The staging single-actor exception now uses an administrator-
set PostgreSQL role setting scoped to one database; runtime self-elevation is
covered by the RLS boundary test. CI run #685 passed all checks, including
migrations, API integration, full RLS, build, and browser E2E. CodeRabbit's
refresh is rate-limited until its included window resets, and Strix PR reviews
remain blocked by the workspace trial limit. The earlier SECURITY DEFINER
review thread is resolved; no financial action has run. Keep PR #149 open
until the pending review decision is settled, and do not execute the case.
After merge,
deploy the Admin build as well as API, apply the migration, set the explicit
staging bypass and database-local role setting for the staging database, and
let the operator perform Maker-Checker/test actions manually.

## Force-cancel money conservation

PR #145 (`fix/order-force-cancel-money-conservation`) corrects paid
force-cancel allocation so customer refund plus publisher compensation cannot
exceed captured order gross. CodeRabbit's partial-credit-note and replay
findings are fixed with regression coverage, force-cancel now requires an
idempotency key, and external timelines show a structured reason code rather
than the internal audit note. The PR is rebased on current `main`. Strix
automatic review on push is disabled and must be explicitly rerun; CodeRabbit
reported its hourly review limit. Render's GitHub App already publishes
`in_progress` and `success` deployment statuses with dashboard links. Render
remains manual (`autoDeployTrigger: off`); do not create a duplicate/fake GitHub
deployment or promote this schema change before the documented migration/drain
gates pass.

## Cross-portal visual loading polish

Branch `fix/visual-loading-polish` is based on `origin/main` after PR #143. It
adds a shared, reduced-motion-aware top loading bar to the admin, customer, and
publisher portals for initial TanStack query loads and mutations. Cached
background refetches stay quiet unless a query opts in with
`meta.globalLoadingBar`. The customer dashboard's wallet snapshot skeletons
balances before its first response, and the admin force-cancel dialog is
viewport-bounded and scrollable. The loading-bar anti-flicker behavior has
focused UI tests. Local UI tests, TypeScript checks for all three portals, and
webpack production builds for the three apps pass using the existing installed
dependencies; review and CI remain the release gates.

## Billing cancel-return resilience

PR #143 (`fix/billing-cancel-return`) contains the follow-up to current `main`
(`6bd4dc1`). The API keeps the configured exact-origin CORS policy before
rate-limit middleware while allowing OPTIONS requests to continue through the
existing per-route limits, then respond before auth/controller handlers.
Billing wallet and transaction failures render independently; deposits are
gated on an available wallet, and failed history no longer reports zero total
deposits. CodeRabbit and Strix review comments were verified and addressed in a
follow-up commit; CI exposed an auth preflight regression, now fixed by the
post-limiter responder. The final portal production build passed, and a local
OPTIONS smoke confirmed rate-limited preflights retain CORS headers. The
authenticated local UI smoke remains open: the guarded seed script refused to
mutate a legacy fixture missing exact consent evidence, so no account data was
reset or repaired. Only localhost schema migrations were applied.

## Stripe return-domain repair

Branch `fix/stripe-return-domain`, rebased on `origin/main` (`c8e1128`),
contains the pending Stripe return-domain repair. Checkout and Stripe Connect account-link returns
derive only exact canonical origins from `NEXT_PUBLIC_ALLOWED_APP_DOMAINS`,
with the existing configured URLs as safe fallbacks; a cancelled Checkout clears
only the recovery state belonging to its exact opaque pending reference. It also runs the API and worker containers as the
non-root `node` user. Focused API (108 tests) and API-client (45 tests)
coverage passed, as did dependency-aware API and portal builds.

The same branch contains the reviewed Dependabot updates for AWS S3,
react-hook-form, Next 16.3.5, and Undici plus minimal dependency floors for
fast-uri 3.1.7, ip-address 10.5.1, multer 2.4.0, and Nodemailer 10.0.2+.
`pnpm audit --prod` reports zero vulnerabilities and `pnpm deps:policy` passes.
GitHub's signed Coolify push webhook is already configured at the public HTTPS
endpoint and its latest deliveries returned HTTP 200; do not replace it with
the private port-8000 URL shown in Coolify's internal display. The next action
is CI/review completion, then merge and deploy API, portal, publisher, worker,
website, and admin with the exact staging domain allowlist, CORS/trusted origins,
and HTTPS fallback URLs before testing a cancellation or deposit.

## Security sweep PR #125

PR #125 (`fix/security-sweep-hardening`) is rebased on current `main`
and contains verified SSRF redirect/DNS hardening, publisher-owner integration
authorization, shared client redirect validation, edge session-cookie shape
checks, literal marketplace search escaping, bounded OAuth/webhook inputs,
dashboard nonce CSP proxies, restricted worker metrics, and guarded local
setup/reset scripts. A client-controlled prefetch-header matcher exemption was
removed from all three proxies so it cannot skip dashboard redirects or CSP.
Each commit was submitted to CodeRabbit; its only actionable DNS/redirect
findings were fixed, while later requests were rate-limited. GitHub CI run
36359452259 passed the complete protected matrix, including isolated object
storage and browser E2E. The guarded Undici Agent explicitly disables automatic
address-family selection so its single-address DNS validation callback matches
the connection contract. The final CI and automated reviews must run after this
last connection-boundary hardening commit.

## Security and query hardening follow-up

Branch `codex/security-query-hardening` is stacked on the exact PR #116 head so
the staged full-RLS PR remains unchanged. The follow-up closes the audit items
that are safe and valuable to address now: API-key authentication is explicit,
creator-bound, expiring, permission-scoped, tenant-fenced, and fail-closed;
report responses and generated artifacts use customer-safe allowlists; legacy
stored report payloads are redacted; sweeps and admin review paths are bounded;
and the confirmed website, marketplace, reminder, and cancellation N+1 query
paths are replaced with batch queries. Supporting indexes and an additive
migration accompany the query shapes.

The branch also removes three unused queue families and the obsolete generic
verification worker, makes repeatable registration failures visible, sanitizes
integration callback errors, validates verification configuration at startup,
and aligns the repository checks and operational documentation with the current
Node/TypeScript/Next/Nest toolchain. Existing API keys without creator evidence
remain stored but cannot authenticate; rotate them after the migration. No RLS
activation or hosted database change is part of this branch.

Local validation is green for repository policy/format/lint/type/docs/dependency
checks, Prisma validation and generation, all 1,858 API unit tests, all 482
shared tests, all 131 API-client tests, and the focused worker runtime/sweep
tests. Nest, worker, shared, database, API-client, and UI TypeScript build stages
pass. GitHub run 34481816022 passed the complete migration, unit, integration,
RLS, package, UI, production-build, and browser matrix on commit `37aa2bd`.

PR #122's initial CodeRabbit and Codex reviews produced nine valid findings.
The follow-up excludes completed reminders before bounded selection; rotates
cancellation and website sweeps across runs; reauthorizes staff recipients at
the write boundary; preserves scoped legacy report jobs; filters public report
events before truncation; keeps API keys on the anonymous rate tier until
authentication; fences API-client keys to the configured origin; labels the
verification CSV as a current-page export; and moves new indexes/FK validation
to online, staged migrations. CodeRabbit's incremental review added two valid
hardening findings: direct API-key clients now enforce HTTPS except on loopback,
and concurrent-index retries fail closed on an invalid remnant with an exact
valid/invalid/absent recovery procedure. Focused regression coverage passes;
the final combined GitHub CI rerun on this last follow-up is the remaining gate.
The first rerun passed every code, migration, RLS, test, and production-build
stage before Docker Hub stopped serving the pinned MinIO digest. CI now pulls
that exact verified digest from MinIO's official Quay registry, and final run
34708411250 passed the complete matrix on commit `1010833`.

Canonical documentation now records the API-key lifecycle, permission/route
matrix, same-origin HTTPS transport boundary, bounded request queries, N+1
batching, sweep cursor fairness, report-queue compatibility, and the exact CI
and RLS assurance boundaries. Stale session-only authentication, gateway-only
rate-limit, disabled-development-limit, and generic verification-worker claims
were removed. Documentation commit `abc89f1` passed the complete GitHub matrix
in run 34722318918, including migrations, integration tests, the destructive
RLS boundary, packages, production builds, and browser journeys.

## Full staged application RLS

PR #116 now contains an inert four-command policy surface for 98 Prisma models
plus a lockout-safe activation-time swap from the six live Phase 1 `ApiKey`
policies to four full-boundary policies, alongside context-aware API, Better
Auth, integrations, and worker clients.
Customer, publisher, and staff authority is rechecked from live PostgreSQL
rows; public/catalog, webhook, auth, and platform-worker workloads have
separate explicit boundaries. Better Auth uses a distinct runtime URL, and API
startup fails if enforcement is enabled without it.

The 11-role topology is non-superuser, `NOBYPASSRLS`, and leaves all
credentials `NOLOGIN`. Activation is a separate guarded transaction after code
and credentials are canaried while policies remain inert. A guarded emergency
disable preserves the Phase 1 `ApiKey` boundary. A real PostgreSQL 17
provision/ownership/activation test passed for all 99 forced tables, including
customer owner/member isolation, publisher private and routed-order access,
Operations/Finance/Super Admin, auth table denial, public filtering, worker
no-context denial, cross-tenant DML, role and telemetry spoofing, customer and
publisher self-promotion denial, safe invite acceptance, last-owner
preservation (including concurrent customer and publisher owner demotions),
append-only audit, display-safe review snapshots, public metric filtering,
delivery URL fencing, suspension, and live membership revocation. The same
destructive matrix now runs after an activation-time provisioning rerun in a
dedicated GitHub CI database, proving authorizer ACL reconciliation is safe.
The CI ownership rehearsal transfers tables before independently owned
sequences because PostgreSQL transfers `OWNED BY` sequences with their parent
table and rejects an attached sequence-first owner change; the corrected clean
database sequence passed again through activation and the full matrix.

## Prior marketplace context

PR #105 layers the marketplace trust-boundary hardening on current `main` SHA
`1d993e0`, which already includes the support-messaging and confirmed
delivery-fraud releases. Its base conflicts are resolved locally and migrations
`20260821120000_marketplace_moderation` and
`20260821130000_marketplace_moderation_legacy_message_correction` are applied to
the explicitly authorized Neon staging database. The remaining work is to land
the review fixes and run the complete repository CI matrix. A staging migration
is not a production deployment.

The last independently recorded production deployment remains SHA `512b851`
in finance-locked mode. A merge to `main` does not deploy Render because every
Blueprint service has manual deployment enabled. The Northflank worker fleet
remains under the recorded full hold; do not infer a matching running worker
from a GitHub merge, CI pass, or staging migration.

## Marketplace hardening in PR #105

- Added immutable `ModerationEvent` history plus current projections and
  optimistic versions for listings and websites. The migration conservatively
  backfills legacy holds without guessing their prior state.
- Replaced generic lifecycle mutations with explicit, locked staff/publisher
  policies. Operations is assignment-bounded, Finance is read-only, Super Admin
  owns exceptional reopen/archive authority, and publishers cannot clear staff
  holds unless resubmission is explicitly enabled.
- Made website pause/archive independent of listing status and required an
  APPROVED listing with an active, VERIFIED website across every buyer
  discovery path and checkout. Orderability is revalidated while locking
  Website, MarketplaceListing, then ListingService.
- Restricted buyer metrics to current exact provider/key/direct-source evidence.
  Manual, staff, import, stale, mismatched, and unknown values remain available
  to authorized internal workflows only.
- Replaced broad public spreads with explicit allowlist serializers, including
  reduced review/publisher/service shapes and deposit-gated URLs.
- Added typed moderation commands/projections and capability-driven admin and
  publisher UI with reasons, messages, version conflicts, confirmations, and
  publisher-safe history.
- Removed publisher create-time status/featured/verified injection and routed
  legacy archive paths through the same moderation authority.
- Operations offboarding now fails closed while platform Websites remain
  assigned. Platform Website creation/reassignment serializes against staff
  demotion and suspension, revalidates the active Operations owner under lock,
  and commits reassignment with its audit record atomically.

## Confirmed-fraud base release

- Current `main` records confirmed delivery fraud as immutable, same-order
  evidence, retains the fraud hold, and drives a separate full-refund review
  through Operations and Finance authority.
- Database backstops bind terminal Order outcomes to the canonical cancellation
  and refund evidence and make confirmed-fraud findings and approved refund
  evidence append-only.
- Audience-specific stakeholder timelines and transactional communications do
  not expose raw internal notes, audit text, support identifiers, provider data,
  or generic metadata.
- The delivery-fraud migration remains a mixed-writer cutover: old API/worker
  images cannot be started against the guarded schema.

## Explicitly unchanged

- Staff security and finance governance remains owner-deferred: phishing-
  resistant MFA, recent step-up authorization, universal human money-command
  maker-checker, append-only staff-security evidence, and break-glass rehearsal
  remain paid-launch gates.
- Managed KMS/HSM, provider certification, legal/entity, browser acceptance,
  Redis capacity, and worker rollout gates remain open. Neither a staging
  migration nor this correctness batch certifies paid production.

## Validation state

Before the base merge, the marketplace batch passed all 1,693 API unit tests,
all 459 shared tests, all 90 API-client tests, API Nest build, Prisma
format/validate/generate, TypeScript checks for API/database/shared/API-client/
admin/portal/publisher, full ESLint for the three affected apps, Biome, and
`git diff --check`.

After the base merge, all 1,787 API unit tests passed together, as did database
and API typechecks, the API-client's 127 tests, 84 focused metrics/provenance/
search/client tests, affected app typechecks and lint, Prisma format/validate/
generate, and `git diff --check`. The Neon staging target reports all 78
migrations current with no failed migration. Its one legacy paused-listing and
one inactive-website projections use the corrected Super Admin wording, the two
archived-listing projections remain unchanged, and all four immutable legacy
events retain their original evidence. Invalid event targets remain zero, both
append-only guards remain enabled, and all five moderation constraints remain
present. PR #105 must still pass the combined repository CI matrix; local and
staging results are not a substitute for that check.

The first post-merge GitHub run passed dependency, migration, static, and API
unit stages, then exposed a direct Prisma `DriverAdapterError` serialization
shape in the real support/offboarding race. The structured retry classifier now
recognizes that exact adapter shape without parsing messages or trusting
arbitrary nested causes. Focused shared/admin coverage and the API build pass;
the full GitHub rerun passed. Review findings have since produced a narrow
follow-up batch, so the next pushed head must pass the complete GitHub matrix
again before merge.

## Next actions

1. Keep PR #122 based on `codex/staged-api-key-rls` and retarget it to `main`
   only after PR #116 lands. Preserve the complete green workflow evidence and
   resolved review state through that sequence.
2. Keep PR #116 unchanged and keep hosted databases unchanged. After merge,
   rehearse the canonical
   lockout-safe sequence from `docs/RLS_ROLLOUT.md` on a current staging clone,
   including separate API/auth/worker credentials and pre-activation canaries.
3. Treat activation on staging or production as a separate approved operations
   change; repository CI and merge do not authorize or perform that cutover.
