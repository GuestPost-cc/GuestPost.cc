# Current Status

**Phase**: PR #61 is merged and exact commit `442304f` is live across all five Render services and all three Northflank worker workloads. The Neon staging database is migrated through the Stripe-first finance migration and every runtime uses a restricted application role; the former owner password was rotated after cutover. Stripe webhook destinations are active, but both deposit and Connect execution remain fail-closed pending replacement of the staging restricted key and a user-initiated sandbox checkout. Existing Admin-auth and GSC/GA4 deployment follow-ups remain open.

**Reconciled through**: Git commit `8cd5f2b` (358 commits total). The catch-up covers the 93 commits after the previous 265-commit history boundary at `d907b3d`; see `History/timeline/2026-07-16-catchup.md`.

## Current Local Work: Staff Marketplace And Canonical Order Integrity

- Rebuilt the Admin marketplace list and detail workflows for Super Admin,
  Operations, and Finance with consistent filters, responsive cards/tables,
  publisher or platform-owner context, service summaries, and source-aware
  Ahrefs, Moz, and OpenPageRank freshness states.
- Finance marketplace access is contextual and read-only. Operations retains
  only assigned platform-service actions, while moderation and global flags
  remain explicitly role-gated. Staff projections omit publisher contact data
  outside Super Admin and never expose service fulfillment settings.
- Platform-owned site creation now requires fresh manual Ahrefs traffic and Moz
  DA evidence in the same transaction as the site/listing, then queues the same
  Ahrefs DR and OpenPageRank providers used for publisher inventory.
- Added one shared seven-stage order lifecycle across Admin, customer, and
  publisher detail pages. Admin detail now includes a role-safe integrity report
  covering routing, assignment, delivery evidence, financial records, event
  history, and dispute/cancellation holds without widening sensitive data.
- Added focused lifecycle, RBAC, projection, platform-metric, and integrity
  regression coverage. Signed-in Operations browser checks passed for desktop
  and 390-pixel marketplace layouts, listing details, the platform metric form,
  and order integrity; the pass also caught and fixed Decimal/string price
  rendering at the API/UI boundary.
- Full local CI-equivalent validation passes on current `main`: 97 API unit
  suites / 993 tests, 9 API integration suites / 17 tests, 12 shared suites /
  106 tests, 3 API-client suites / 50 tests, 11 worker tests, and 9 UI test files
  / 67 tests with coverage. TypeScript, Biome, ESLint, dependency-cruise, a
  clean 43-migration replay, and all 12 production builds pass. The dependency
  audit initially exposed newly published Next.js advisories; all consumers
  were upgraded to 16.2.11 and the production audit now reports no known
  vulnerabilities.

## Current Local Work: Admin Staff Workspace Redesign

- Added an Admin-only workspace component system for consistent page framing,
  task-oriented headers, semantic KPI colors, filter/result surfaces, notices,
  status badges, and empty states.
- Updated the shared shell with role-specific Super Admin, Operations, and
  Finance accents, clearer scope context, grouped navigation, active states,
  responsive overflow protection, and a fail-closed state for STAFF accounts
  without a staff role.
- Migrated all 25 Admin overview, list, governance, inventory, finance,
  settings, and detail routes to the shared page boundary. Role-specific data,
  navigation, actions, route guards, API contracts, and ownership scopes are
  unchanged.
- Added `docs/ADMIN_WORKSPACE_UX.md` as the durable role, color, responsive,
  workflow, and security contract for future Admin work.
- Rebuilt the shared Admin order monitor around exact server pagination,
  role-specific attention/active/history totals, role-visible search, concise
  responsive order cards/tables, and links into the correct protected workflow.
- Reworked order detail into a role-aware decision page with next-action
  guidance, lifecycle KPIs, verification and settlement evidence, safe optional
  identity rendering, non-enumerating out-of-scope errors, and a strengthened
  Super Admin force-cancel confirmation.
- Tightened list/detail API projections so Operations never receives customer
  contacts, publisher trust/contact details, settlement context, or event
  metadata, while Finance retains only the financial evidence needed for its
  workflow. Added focused API and API-client regression coverage.
- Local validation: Admin production build, typecheck, lint, and focused Biome
  checks pass; 6 focused Admin guard, RBAC, scoping, and workbench suites pass
  49 tests. Signed-in browser checks pass for Super Admin, Operations, and
  Finance; unavailable navigation is absent, Operations direct Finance access
  fails closed, no runtime console errors were observed, and tested
  390/768/1,440-pixel layouts have no document-level horizontal overflow.
- Order-workflow validation: all 96 API unit suites pass (989 tests), all three
  API-client suites pass (50 tests), Admin lint/typecheck and the final
  production build pass, and focused order/cancellation suites pass 27 tests.
  A signed-in Operations browser smoke test passes for the role-scoped order
  monitor, an authorized detail, a guessed out-of-scope ID, and document-width
  overflow at the available 1,181-pixel viewport.

## Current Local Work: Domain Metrics and Publisher Import

- Implemented source-aware `WebsiteMetric` current values plus immutable
  replacement revisions, with a migration and generated Prisma client.
- Added worker adapters for Ahrefs free Domain Rating and OpenPageRank, fixed
  HTTPS destinations, response caps/timeouts, normalized value validation,
  creation/import wake-ups, and a monthly refresh sweep.
- Added required publisher/admin manual Ahrefs organic traffic and Moz DA with
  90-day moderation freshness, transactional audit, publisher detail UI, and
  required measurement fields in the site-enlistment form. New publisher
  websites now persist manual metrics atomically with the website and listing.
- Updated OpenPageRank to the current bearer-authenticated Keywords Everywhere
  bulk API contract. Local Ahrefs and OpenPageRank keys are configured in the
  ignored development environment; one-domain live smoke calls passed for both
  providers without exposing credentials.
- Public listing projections now include safe source-specific metrics and omit
  GSC/GA4 groups unless that exact provider link is active and has synced.
- Added the Super Admin CSV template/preview/commit/history UI and API. Imports
  are publisher-bound, row-transactional, idempotent, draft-only, and retain no
  raw CSV. Temporary forced verification is separately confirmed, reasoned,
  audited, expiring, replaceable by DNS proof, and auto-revoked by the sweep.
- Expanded the import page with all 26 accepted column contracts, live active
  category slugs, supported languages, additional CSV instructions, explicit
  skip semantics, and an accessible spaced file picker. Unsupported optional
  cells now import as warnings with only those values skipped; invalid website
  identity, duplicate domains, and malformed CSV remain blocking. The page is
  now compact and responsive, uses expandable references/mobile result cards,
  limits default history to five batches, and has no document-level horizontal
  overflow at 390, 768, 1,024, or 1,440 pixels, including expanded guidance and
  a loaded result batch.
- Added mixed-batch regression coverage proving that an existing domain is
  rejected independently while another importable row is created and reported
  in a `PARTIAL` batch. Preview also recognizes legacy `www.` stored domains.
- Validation is included in the full CI-equivalent pass above. The two new
  migrations replay cleanly from an empty PostgreSQL database; an end-to-end
  mixed CSV import remains a manual staging gate before release.

## Recently Completed

### Dependency Governance And Repository Protection

- Replaced the noisy one-package-at-a-time Dependabot queue with scheduled,
  cooldown-aware compatibility cohorts and a three-PR npm limit; routine major
  upgrades now require planned migrations while security updates retain their
  expedited lane.
- Added CI dependency review, resolved-lockfile compatibility enforcement,
  production vulnerability auditing, and advisory floors for temporary
  transitive security overrides. After enabling GitHub alerts, added patched
  floors for the newly published brace-expansion, shell-quote, and DOMPurify
  advisories rather than dismissing the two high and one low findings.
- Protected `main` with a required full CI check, one code-owner approval,
  stale-review dismissal, resolved review threads, squash-only merges, and
  automatic merged-branch deletion. Enabled dependency alerts, Dependabot
  security updates, secret scanning, and push protection.
- Reconciled and closed Dependabot PRs #62-#71 with documented reasons, removed
  their stale remote branches, and deleted five historical branches for merged
  PRs #57-#61. The next routine updates will be recreated under the new policy.
- Validation: PR #72 passed dependency review, policy and audit checks,
  migration replay, type/lint checks, API and package tests, UI coverage, and
  all production builds before merge.

### Neon Cutover And Stripe Staging Rollout

- Created expiring pre-rollout backup and migration-rehearsal branches from the
  Neon `production` branch. Replayed
  `20260720090000_stripe_first_finance_groundwork` transactionally on the
  rehearsal branch before applying it to production with its Prisma checksum.
- Verified the four finance tables, three enums, four database checks, inactive
  Stripe provider seed, and zero invalid wallet/withdrawal balances after the
  production migration.
- Created `guestpost_runtime` with database connect, schema usage, application
  table DML, sequence access, function execution, matching default privileges,
  a 30-second statement timeout, and a 60-second idle-transaction timeout.
  Render's five services and Northflank's service plus two jobs use this pooled
  runtime role; only the API holds the direct URL for migration tooling.
- Rotated the Neon owner password after API readiness, worker 1/1 health, and
  fresh successful five- and ten-minute job executions proved that no runtime
  depended on owner access. Post-rotation API readiness reports both PostgreSQL
  and Redis healthy.
- Configured a Stripe sandbox with one restricted test key and distinct webhook
  destinations/secrets for deposits, platform transfers, and connected-account
  payouts. Exact event allowlists, test/live mode checks, secret non-reuse, and
  independent deposit/Connect/live-mode kill switches remain enforced.
- During final verification, the active restricted-key value became visible in
  an operator-only dashboard transcript. It was expired immediately, the
  deposit flag was returned to false, the expired key was removed from Render,
  and the unused exposed standard secret was expired as well. Stripe's
  dashboard did not permit automated creation of the replacement; no exposed
  key remains trusted by the rollout.
- PR #61 passed CI run #350, was squash-merged as `442304f`, and the same commit
  is live on the Render API, portal, publisher, admin, website, Northflank
  realtime worker, on-demand job, and maintenance dispatcher. Both scheduled
  job lanes completed fresh successful runs on that commit.

### Stripe-First Provider-Neutral Finance Groundwork

- Added durable deposit attempts and provider event inbox records, mandatory
  input-bound idempotency, explicit paid-state verification, and one atomic
  wallet/ledger/attempt/event/audit transaction for customer funding.
- Added a deposit-provider registry and provider-neutral capability contracts
  so future gateways can be introduced behind the same domain boundary without
  changing wallet semantics.
- Added hosted Stripe Express onboarding with no local bank-data collection,
  provider-account state separate from payout methods, a manual USD payout
  schedule, and distinct persisted Transfer and bank Payout references.
- Added gross/fee/net/reference snapshots and source allocations to withdrawals,
  with fail-closed recovery and cancellation states for ambiguous provider
  outcomes. Provider fees are disclosed to publishers; statement text is a
  best-effort provider/bank surface and never the accounting source of truth.
- Added reconciliation coverage for provider success without a ledger entry,
  ledger/attempt amount drift, allocation drift, and Stripe Transfers that have
  not produced a paid bank Payout.
- Documented the architecture decision, security model, provider rollout
  checklist, Stripe staging steps, incident handling, and rollback constraints
  in `docs/adr/0006-provider-neutral-finance-stripe-first.md`,
  `docs/PAYMENTS_ARCHITECTURE.md`, `docs/PROVIDER_ROLLOUT_GUIDE.md`, and
  `docs/STRIPE_STAGING_RUNBOOK.md`.
- Validation: 90 API suites / 937 tests, 11 shared suites / 102 tests, six
  worker tests, API/worker/database/API-client builds, all four application
  typechecks, Prisma format/validate/generate, and whitespace checks pass.
  Clean migration replay and real Stripe test-mode end-to-end certification
  remain mandatory staging gates; they were not claimed from this local host.

### Hybrid Worker And Durable Payout Reconciliation

- Re-evaluated the payout path from the implementation: authenticated API
  requests initiate provider transfers synchronously; the worker only applies
  verified webhooks and polls uncertain executions.
- Split the worker into safe-default `all`, continuously running `realtime`,
  burst `on-demand`, and single-task `scheduled` modes. Added Northflank wake
  requests plus a mandatory 10-minute catch-up contract for burst work.
- Moved verified payout webhooks from a Redis acknowledgement boundary to a
  durable PostgreSQL inbox with event-level deduplication, bounded allowlisted
  fields, conditional leases, retryable out-of-order delivery, and provider-
  scoped execution references.
- Hardened payout recovery against ambiguous provider sends and balance races,
  signed integration queue payloads, separated queue Redis configuration, and
  reduced idle BullMQ and metrics traffic for Upstash.
- Added the deployment, security, scheduling, migration, rollback, monitoring,
  and incident runbook in `docs/WORKER_ARCHITECTURE.md`.
- Merged PRs #57-#59 and deployed exact commit `10c971c`: Northflank runs
  four continuous realtime queues, a five-minute deterministic maintenance
  dispatcher, and an API-wakeable on-demand job with a ten-minute catch-up.
  The recurring jobs use forbid-concurrency semantics and the realtime lane
  does not receive payout-provider, integration-encryption, or Google OAuth
  credentials.
- Migrated the non-production Neon database through
  `20260719223000_payout_webhook_inbox`; the payout-reference duplicate
  preflight and stale-webhook-lock check are clean. The Render API is ready
  with Redis and PostgreSQL healthy, and the first real five-minute maintenance
  and ten-minute on-demand catch-up executions completed successfully.
- The Render wake token is restricted to job-read/run access in the worker
  project. Its negative authorization checks deny service and secret reads.
  The temporary provisioning token was revoked, its setup role deleted, and
  all local temporary credential files were erased after cutover.

### Admin Authentication And Suspension Hardening

- Fixed the production login 500 caused by exhausted Redis request quota in the shared per-email limiter. Redis remains the cross-instance authority; a bounded local fallback preserves throttling and controlled 429 responses during provider/quota failures, with rate-limited warnings and periodic recovery attempts.
- Added correlation IDs, structured completion/error logs, and Sentry capture to raw Better Auth routes without logging request bodies, credentials, emails, cookies, or tokens.
- Aligned Admin login with the shared verified-session transport and made `/identity/me` the authoritative STAFF check. Login success now requires a real cookie round trip and matching session/user IDs, removing false-success redirects and blank/flickering dashboard loops.
- Replaced the one-click ban toggle with an audited suspension lifecycle: structured reason, required private note, optional expiry, atomic session revocation, safe user messaging, Super Admin governance guards, and explicit restoration that requires a fresh login.
- Applied `20260719210000_account_suspension_lifecycle` to the supplied Neon non-production database and verified all 39 migrations are current.
- Validation: 87 API suites / 907 tests, 8 auth suites / 38 tests, all 12 typecheck targets, Admin/Portal/Publisher lint, Prisma generation/build, repository formatting/dependency checks, and focused auth/session/suspension regressions pass.

### Unified Public Authentication And Session Hardening

- Added one website login/signup entrypoint with Customer/Publisher selection while preserving dedicated direct customer, publisher, and admin login pages.
- Made CUSTOMER/PUBLISHER account type immutable and mutually exclusive across email signup, Google signup, session creation, self-service identity routes, and admin role changes.
- Split login from signup for Google OAuth, disabled implicit signup/linking, required versioned Terms acceptance for both signup methods, and persisted auditable `LegalAcceptance` records.
- Replaced browser bearer-token/session rotation with one opaque HttpOnly cookie session, bounded rolling and absolute lifetimes, exact-origin/custom-header CSRF protection, token-redacted auth responses, and safe return paths.
- Fixed the permanent blank-dashboard redirect state, wrong-portal Google 500 path, password-reset endpoint/email/session revocation, and generic recovery/error messages.
- Validation: all 12 typecheck targets pass; auth, API-client, and UI package suites pass; all four Next production builds pass; the API unit suite and focused CSRF/account-immutability regressions pass after updating its structured-logger maintenance baseline.
- Deployed `20260719174500_versioned_legal_acceptance` to the supplied Neon non-production database and verified all 38 migrations are current.

### Google OAuth And Staging Worker Rollout

- Configured the `GestPoustLoginGSC` Google Auth Platform project with exact
  local/staging callbacks, GuestPost branding, and the five required identity,
  Search Console read-only, and Analytics read-only scopes.
- Recovered a malformed OAuth rollout where Render received an inline-commented
  client ID and a Redis env assignment instead of the Google secret. Restored
  the exact OAuth values in Render and the ignored local development env.
- Deployed the queue worker on Northflank, aligned its staging database, Redis,
  queue-signing, and integration-encryption settings with Render, and verified
  its pod is `Running`, `1/1 passing`, with zero restarts.
- Verified the Render API environment deployment is live and
  `https://api.guestpost.pro.bd/api/v1/health` returns `status: ok`.
- Verified a complete customer Google sign-in and callback into the deployed
  dashboard. Remaining manual gate: connect GSC/GA4 and run the first real sync.
- The unused, unrecoverable 2026-07-19 Google client secret should be disabled
  and deleted after explicit cleanup approval; the older enabled secret is the
  working deployment credential.

### Financial And Authorization Hardening

- Removed the direct wallet-credit HTTP endpoint, API-client method, feature
  flag, and production service mutation. Seed/load/integration/concurrency
  funding is isolated in test-only Prisma scripts with a production kill
  switch.
- Made order ownership deny-by-default for staff and future actor types, and
  constrained generic order detail/event routes to customer and publisher
  actors.
- Added a partial unique index and conflict-retry path for personal wallets;
  the migration merges any historical duplicate balances and ledger links.
- Added deterministic Wise/Stripe Connect webhook queue IDs even when the
  provider execution ID is absent.
- Added idempotent publisher debt notifications, debt-aware settlement-release
  messages, and fail-closed publisher-balance invariant checks.
- Validation: all 85 API unit suites (890 tests), all 9 API integration suites
  (17 tests), package tests, 65 UI tests with coverage, Prisma validation and
  full migration replay, repository pre-submit checks, and all 12 production
  builds pass.

### Operations Assignment And Support Workbench

- Replaced the generic Operations overview with an assignment-focused
  workbench for active/claimable fulfillment, assigned platform Support,
  operational cancellations/disputes, delivery/domain verification,
  marketplace moderation, and assigned-site readiness.
- Added the private/no-store `GET /admin/operations-workbench` endpoint with
  exact server counts and a bounded server-prioritized queue. Support assigned
  to the operator is guaranteed visibility within an equal severity band;
  only safely claimable fulfillment can mutate inline.
- Scoped the Operations order monitor and direct order detail to assigned or
  claimable fulfillment, orders with Support assigned to the operator, and
  active operational exception contexts. Direct-ID probing fails as not found,
  and Operations responses omit emails, finance data, audit metadata, and
  provider details.
- Added role-aware admin branding and navigation. Operations sees GuestPost
  Operations, Finance sees GuestPost Finance, and GuestPost Administration is
  reserved for Super Admin. Operations Support opens on Assigned to me, and
  the force-approval verification report is Super Admin-only.
- Validation: all 82 API unit suites and 876 tests pass; Admin lint/typecheck,
  API/API-client builds, Biome, whitespace checks, and signed-in browser QA for
  the workbench, assigned Support, domain verification, and order monitor pass.

### Finance Money Operations Workbench

- Replaced the generic Finance overview with a Support-first workbench for
  settlement, withdrawal, payout, cancellation, dispute, reconciliation, and
  publisher-debt decisions. The bounded server-prioritized queue guarantees
  that active Support remains visible without outranking critical integrity
  failures.
- Added exact Finance KPIs and pipeline totals through the dedicated,
  private/no-store `GET /admin/finance-workbench` endpoint. Money aggregation
  stays in Prisma Decimal; the response excludes payout credentials, provider
  configuration, raw execution errors, audit metadata, and decrypt output.
- Reorganized Finance Center into URL-backed Settlements, Withdrawals, Payouts,
  Reconciliation, and Revenue tabs. Settlement/withdrawal status filtering and
  pagination are server-side, and high-impact mutations remain in their
  existing reasoned and audited detail workflows.
- Validation: all 81 API unit suites and 870 tests pass; Admin lint/typecheck,
  API/API-client/shared builds, the complete 12-target production build, and
  whitespace checks pass. The live endpoint is registered and rejects an
  unauthenticated request with HTTP 401.

### Customer Order Workbench

- Rebuilt the customer shell around Work, Discover, Results & Finance, and
  Account, with owner-only Billing visibility and longest-route active-state
  matching.
- Replaced the overview with an action-first dashboard showing authoritative
  attention, active-order, delivered-result, wallet, campaign, and in-progress
  summaries.
- Rebuilt Orders as a server-paginated operational queue and reorganized order
  detail and checkout around value, deadline, turnaround, next action, delivery
  proof, and role-aware controls. OWNER can oversee the organization; MEMBER
  actions remain limited to orders the member created.
- Updated campaign counts/detail, complete report exports, wallet ledger copy,
  and support triage without changing deposit, payment, refund, payout, or
  settlement behavior.
- Validation: portal lint/typecheck and production build pass; publisher
  lint/typecheck pass; API/API-client builds pass; all 77 API unit suites and
  860 tests pass. Signed-in browser QA passed for owner Work Queue, Orders,
  Order Detail, Billing, secure order-linked Support, and the member Billing
  deep-link guard.

### Publisher Order Workbench

- Rebuilt the publisher shell around Work, Inventory, Finance, and Account
  navigation while preserving the existing GuestPost tokens and routes.
- Replaced the chart-first dashboard with an operational work queue showing
  attention items, due-risk, open work, withdrawable funds, lifetime earnings,
  pending balance, and in-progress orders.
- Rebuilt the Orders page as a responsive fulfillment queue with stage,
  website, deadline, search, and sort controls plus a clear next action on
  every row/card.
- Reorganized order detail around the structured brief, order value, deadline,
  turnaround, next step, verification, settlement, and timeline. Removed the
  nonfunctional attachment selector and fake JSON invoice download.
- Added an authenticated publisher support route with secure order linking and
  credential-sharing guidance.
- Validation: publisher lint/typecheck and production build pass; repository
  typecheck, Biome, dependency graph, and whitespace checks pass; signed-in
  browser QA passed for Work Queue, Orders, Order Detail, and order-linked
  Support using real local API data.

### Marketplace Taxonomy, Language, Policy, And Verified Metrics

- Added the reviewed 87-category marketplace taxonomy and explicit many-to-many listing categories, with 1–7 unique categories enforced in DTOs, active-record lookup, and a concurrency-safe database trigger.
- Added one controlled primary language and one value for every placement-policy field to both publisher and platform inventory flows; submission and approval fail closed when metadata is incomplete.
- Added searchable multi-select category/language filters, multi-value link/backlink/validity filters, boolean policy filters, updated buyer cards/details, and category-aware publisher/admin inventory editing.
- Removed self-reported performance inputs. GSC now publishes 30-day clicks/impressions and GA4 publishes 30-day sessions/users/pageviews into buyer-safe listing summaries; marketplace traffic ranking/filtering uses GA4 sessions.
- Validation: Prisma schema valid; API 75/75 suites and 857/857 tests pass; integrations 7/7 suites and 69/69 tests pass; focused taxonomy/inventory tests 56/56 pass; API, integrations, shared, database client, API client, and UI builds pass; portal, publisher, and admin production builds/typechecks/lint pass; Biome and whitespace checks pass.
- Local database recovery: reconciled a pre-existing `prisma db push` integration-schema drift, preserved and owner-scoped the existing encrypted Google account, marked `20260718120000_platform_domain_and_integration_ownership` applied, and deployed `20260718180000_marketplace_taxonomy_and_listing_policies`. All 36 migrations are current, Prisma reports an empty schema diff, API liveness/readiness are HTTP 200, and the database has 87 active categories with the max-seven trigger installed. All 17 legacy local listings still require an owner policy review because the migration intentionally did not guess commercial terms.

### Publisher Inventory And Service Management Redesign

- Consolidated publisher website enlistment and listing creation into one atomic flow with category, a server-enforced 500-character description, and an optional initial service.
- Made the publisher website detail page the workspace for listing metadata, DNS/review readiness, lifecycle transitions, and version-safe service management.
- Rebuilt the publisher Listings overview with actionable summaries and search/status/service/category filters; standalone listing creation now routes through website enlistment.
- Allowlisted publisher metadata writes so lifecycle, ownership, verification, featured state, website association, metrics, and service rows cannot be changed through the general listing update endpoint.
- Updated buyer marketplace cards/details with blue Publisher-managed and purple Platform-managed badges, two-line description truncation, full detail copy, and more comfortable filter spacing.
- Validation: API/API-client builds, publisher/portal typecheck and lint, both production builds, Biome, scoped whitespace checks, and all 75 API unit suites (855 tests) pass.

### Buyer Marketplace Decision Flow Redesign

- Rebuilt portal discovery around buyer comparison: service-aware pricing, turnaround, authority/traffic metrics, review evidence, fulfillment attribution, URL-access clarity, quick service chips, and a responsive filter system.
- Expanded search to category/tag names and case-insensitive location fields, and corrected price sorting to use the minimum matching AVAILABLE service instead of the removed listing-level price.
- Rebuilt listing detail around a mobile-first/sticky service picker, explicit fulfillment and deposit-gated URL guidance, service-scoped waitlist notifications, buyer reviews, and related listings.
- Preserved service-id locking into order creation and all existing publisher ownership, availability, and URL-disclosure rules.
- Validation: portal production build, portal typecheck/lint, API and API-client builds, Biome, scoped whitespace checks, and all 74 API unit suites (851 tests) pass.

### GitHub CI/CD Consolidation And Security Gate

- Replaced the overlapping `CI`, `Main`, and `PR` workflows with one authoritative `CI / build-and-test` gate for PRs, `main` pushes, and manual runs; Render still deploys only after checks pass.
- Added least-privilege permissions, immutable action and service-image pins, non-persistent checkout credentials, superseded-run cancellation, a 60-minute timeout, migration status checks, all package tests, and a complete production build.
- Added a moderate-or-higher production dependency audit and patched the discovered Multer, Hono server, and PostCSS advisories; the audit now reports no known production vulnerabilities.
- Fixed the integration queue circular dependency, deterministic webhook timestamp-boundary coverage, test-only Google OAuth bootstrap, and the Operations claim-race fixture exposed by the restored full gate.
- Validation: dependency graph has zero errors, 833 API unit tests pass, 16 database-backed integration tests pass, package/UI tests pass, and all 12 production targets build.

### Render Staging 500 Recovery

- Recovered deployed customer, publisher, and admin dashboard API 500s by applying the three pending Neon staging migrations through `20260716120000_order_cancellation_workflow`.
- Verified deployed API readiness plus authenticated customer `orders`/`billing`, publisher `orders`, and admin orders/fulfillment/cancellation/marketplace endpoints return HTTP 200.
- Fixed the secondary Render Redis issue where integration queue producers fell back to `localhost:6379` instead of Upstash `REDIS_URL`; deployed API commit `19c7024` is live.
- Confirmed Render free tier blocks Shell and One-Off Jobs, so staging migrations still need a local/direct Neon run until Render is upgraded.

### Admin Verification Navigation And Queue Recovery

- Renamed the DNS ownership surface to Domain Verification while retaining
  Delivery Verification for order-delivery intervention.
- Made sidebar selection choose the most specific visible route, so Delivery
  Verification no longer highlights its Domain Verification parent.
- Aligned the delivery queue UI and typed API client with the server payload,
  including website/source, publisher context, evidence, and `orderId`-based
  actions. Removed order-detail queue links for non-actionable delivery states.
- Replaced the dashboard's signed-out `null` render with a reliable sign-in
  redirect and visible transition state.
- Validation: targeted queue contract test, API/admin builds, admin typecheck
  and lint, API-client build, Biome, and signed-in browser verification pass.

### Admin Staff RBAC Realignment

- Restricted global Users and customer Organizations to Super Admin; Finance
  retains the Publisher directory while Operations has no global Publisher or
  Operations-staff roster access.
- Scoped Operations platform-site reads and mutations to assigned sites. A
  site enlisted by Operations is always assigned to its creator; only Super
  Admin can reassign ownership across staff.
- Scoped platform fulfillment to self-assigned and unassigned claimable work,
  made cross-staff assignment Super Admin-only, validated active Operations
  targets, and fixed claim so it cannot cancel or steal an existing assignment.
- Removed Operations access to settlement list/detail and Finance access to
  platform-site management. Finance retains read-only marketplace list/detail
  context, with no moderation, inventory-management, or contact-data access.
- Aligned admin navigation, deep-link guards, action visibility, Finance
  settlement approval, support copy, and overview KPIs. Fixed the marketplace
  Platform/Publisher/All filter query-key bug and removed unsupported
  Organization create/edit/delete controls.
- Added `docs/ADMIN_RBAC.md`, RBAC/scoping regression tests, and updated the
  existing fulfillment race guard. Validation: all 830 API unit tests, API
  build, admin production build/typecheck/lint, Biome, and diff checks pass.

### Operations Fulfillment And Staff Monitoring

- Added the Operations dashboard and Fulfillment workbench for assigned and
  self-claimed platform orders: accept, draft/save, customer review, revision,
  publish, verification, and structured cancellation.
- Added five-second and focus refresh for active and claimable orders. Claims
  remain per-order and race-safe through the active-assignment unique index;
  stale assignment writes are rejected transactionally.
- Added Operations production metrics for assigned, claimed, completed, and
  delivered sales, plus Super Admin staff monitoring with role-specific Finance
  activity and Publisher/Customer read-only account views.
- Redesigned Users & Staff around staff monitoring and added Super Admin-only
  credential creation for Super Admin, Operations, and Finance. Customers and
  Publishers remain signup-only.
- Added protections against staff conversion, self-demotion/suspension, removal
  of the final active Super Admin, and orphaning active Operations work.

### Structured Order Cancellation and Refunds

- Replaced generic cancellation with a shared, code-backed policy across customer, publisher, and platform fulfillment channels.
- Added structured cancellation cases, response deadlines, Operations review, Finance approval, Super Admin break-glass controls, responsibility attribution, and optimistic concurrency guards.
- Unified captured-payment refunds into one atomic wallet/ledger/order/assignment/settlement-or-revenue transaction; only publisher-responsible refunds affect publisher trust.
- Completed platform-owned orders into recognized platform revenue, hardened post-publication disputes, and added acceptance/cancellation timeout sweeps.
- Added Customer, Publisher, Operations, Finance, and Super Admin interfaces plus policy/service/refund regression coverage and deployment documentation.
- Validation is green across all 805 API unit tests, all 72 shared tests, affected application/package builds, frontend lint, Biome, and diff whitespace checks. Database-backed integration tests still require a local `psql` executable and isolated test database.
- Applied the three pending local migrations through `20260716120000_order_cancellation_workflow`; all 34 migrations now report current. This fixed the reported customer portal 500 responses, and authenticated wallet, transaction, and order requests each return HTTP 200.
- Aligned publisher-owned and platform-owned fulfillment with cancellation authorization: publisher actions resolve through ownership, platform actions require the active Operations assignment or a Super Admin override, and all deadline/warranty decisions come from the shared server policy.
- Removed the generic admin refund bypass. Cancellation and dispute refunds now require a final responsibility value and use the shared atomic refund path for wallet, transaction, assignment, settlement/platform-revenue, event, and audit updates.

### Platform Website Ownership Reassignment

- Fixed the missing Operations roster caused by the static `/admin/users/ops` endpoint being shadowed by the earlier dynamic `/admin/users/:id` route.
- Moved the roster to `/admin/staff/operations`, restricted results to active non-banned Operations staff, and added a route-regression test.
- Redesigned the admin ownership view and reassignment dialog with an always-visible owner roster, shared-queue option, loading/error/empty states, no-op prevention, and optional audit-reason validation.
- Verified the reported site in the signed-in admin browser: the seeded Operations member is visible and selectable without mutating the current assignment.

### Completed Admin Order Detail Recovery

- Fixed the completed-order detail crash caused by treating `SettlementApproval.approvedBy` as a user object and formatting the nonexistent `createdAt` field instead of `approvedAt`.
- Added a typed admin order-detail API contract, server-side human-approver enrichment, explicit system-actor labels, and defensive timestamp formatting.
- Aligned the same detail view with the actual order, publisher-profile, and delivery-evidence fields; verified the reported completed-order eye action and a delivered-order control in the signed-in admin browser.

### Admin Route Recovery and Settlement Queue Isolation

- Fixed valid admin app-router pages appearing as 404s under the long-running development stack by clearing only generated `.next/dev` outputs during `pnpm dev:all`; production build artifacts remain available.
- Isolated settlement auto-release onto its own BullMQ queue and clean up legacy repeatable registrations so auto-approve and auto-release workers cannot consume and skip each other's jobs.
- Verified all reported admin pages in a signed-in browser, including the exact order detail route, and observed both settlement sweeps complete on their intended workers without the prior unexpected-job warning.

### Authenticated Marketplace Access

- Removed the anonymous marketplace page plus its marketing-site header and footer links.
- Protected every marketplace discovery endpoint with the API's global session guard; anonymous requests now return HTTP 401.
- Added controller metadata coverage for all eight discovery handlers and verified the old marketing URL renders the not-found page while portal marketplace access remains available after login.

### Portal Billing Build Type Alignment

- Removed the stale page-local transaction interface from the buyer billing page so callbacks inherit the API client's `TransactionResponse` type.
- Preserved numeric conversion at arithmetic/display boundaries because serialized transaction amounts can be `string | number`.
- Verified the complete `pnpm dev:all` workflow: all 12 workspace builds passed and website, portal, publisher, admin, worker, and API returned HTTP 200.

### Auth Form Validation Hardening

- Fixed the shared auth forms so portal, publisher, and admin login/forgot-password flows reject empty and whitespace-only inputs with inline field errors.
- Added required Terms of Service acceptance to customer and publisher email signup; the acceptance flag is also enforced at the Better Auth request boundary.
- Upgraded only the shared UI resolver to the Zod 4-compatible release, preserving app-local resolver behavior outside the auth scope.
- Added schema, request-boundary, and UI regression coverage for empty submissions, normalization, Terms gating, and accessible server-error announcements.

### July 3–16 Code-Backed Catch-up

- Hardened worker, queue, logging, Prisma pool, encryption-verification, and test-template operations; CI now covers the integration database template path.
- Completed Integration Management v1 with encrypted OAuth state, ownership resolution, discovery/sync jobs, GSC and GA4 providers, publisher integration views, and website-level integration management.
- Shipped the enterprise delivery and settlement controls: auto-accept/release sweeps, delivery verification intervention, review-window visibility, and reasoned manual settlement approval.
- Added platform listing management and Ops scoping, permanent first-deposit URL reveal in the buyer portal, and the one-listing-per-website constraint.
- Moved wallet funding to Stripe Checkout with a webhook-only credit path; added financial transaction and withdrawal-approval hardening.
- Tightened mutation authentication: mandatory session secret, origin validation, all-actor verification gates, and atomic session rotation.

### Publisher Listings UI Modernization

- Replaced dense table-based listing view with modern cards showing site, service summary, lifecycle guidance, and contextual primary action buttons (submit/pause/unpause/archive).
- Redesigned create-listing dialog with a two-column layout: listing basics + optional first service, plus a checklist sidebar.
- Modernized edit-listing dialog with a bordered form panel and char-count hints.
- Replaced the services table with card-based service management: each service is a compact card with inline editing, availability dropdown, and a dedicated add-service form below.
- Kept service-dialog state fresh after add/update mutations by updating the open dialog directly (no reopen or full-page refresh required).
- Added presentation helpers (`serviceLabel`, `formatMoney`, `phaseCopy`) for consistent UI copy and reduced duplication.
- Added lifecycle phase copy map with user-facing guidance for every listing state.
- Upgraded new-website form (`/dashboard/websites/new`) to use shared `Select`/`Textarea` UI primitives via react-hook-form `Controller`.
- Removed unused `Clock` import.

### Integration UI Build Stabilization

- Fixed Next.js/Turbopack workspace-root resolution for all four Next apps by setting each app's `turbopack.root` to the monorepo root.
- Kept browser-facing integration imports on `@guestpost/integrations/client` so UI/API-client bundles do not pull worker/server dependencies transitively.
- Restored `SyncHistoryTable` compatibility with publisher page usage (`rows`, pagination, `onPageChange`) while preserving the richer progress/error UI.
- Made auth session rotation idempotent with `deleteMany()` to avoid noisy Prisma "record not found" warnings under concurrent/duplicate requests.
- Validation: `pnpm build` passes for all 12 workspace packages/apps.

### Phase 5C — Website Integration Panel

Built the website detail `/dashboard/websites/[id]` page that completes the integration management workflow for publishers:

**Backend:**
- `GET /publishers/:publisherId/websites/:id` endpoint (`websites.controller.ts` + `websites.service.ts`)
- Returns website data + `websiteIntegrations[]` + computed `seoIntegration` summary + `gscIntegration` reference + `gscAccountExists`
- Distinguishes last successful sync from last attempted sync

**API Client:**
- `publishers.getWebsite(publisherId, websiteId)` method

**Hooks:**
- `useWebsite(websiteId)` query hook in `apps/publisher/src/lib/hooks/websites.ts`

**Page UX States:**

| State | Primary Action |
|---|---|
| No GSC account | [Connect Google Search Console] → navigates to integrations page |
| GSC exists, no property linked | [Link a Property] → opens resource picker with confirm step |
| Property linked, idle | [Sync Now] [Unlink Property] — health summary with last sync times |
| Sync running | Animated progress bar |
| Token expired | ReconnectBanner |
| Error | Error display + retry/disconnect |

**Page Features:**
- Integration health summary (property, permission, last sync attempt, last successful sync)
- Link Property dialog with resource picker + confirm step (prevents accidental mappings)
- Disconnect dialog disabled during discovery/sync (prevents race conditions)
- SEO metrics placeholder with intentional onboarding copy (Phase 5D boundary)
- Sync history table (reuses `SyncHistoryTable` from `@guestpost/ui`)

**Navigation:**
- Website list rows are now clickable → navigate to `/dashboard/websites/[id]`
- Action buttons (verify, submit, edit, archive) use `e.stopPropagation()`
- Keyboard accessible (tabIndex, Enter/Space)

**Post-Disconnect invalidation:** website list + website detail queries both invalidated.

### Prior Completions

- Phase 3: React hooks (queries, mutations, polling)
- Phase 7.5: Generalized ownership model (`OwnerContext`)
- Phase 4: Shared UI components
- Phase 5A/5B: Publisher integration list + detail pages
- Phase 7: Async discovery, sync locking, Redis coordination

## Current Focus

### Secure customer order creation and article provenance

The marketplace order form now presents the service contract, server-projected
website access state, structured brief, article responsibility, campaign,
price/currency, turnaround, revisions, warranty, and requirements in one
responsive workspace. It submits idempotency and reviewed-quote assertions.

Customer source articles and publisher/Operations final submissions now use
`OrderArticleVersion`; customer, publisher, and Operations detail pages render
the relevant immutable history as safe text. Migration
`20260723180000_order_article_versions` must be applied and the Prisma client
generated before deploying the API and role applications.

The hybrid worker rewrite is merged through PR #57 and its main-branch CI is
green. The payout reference preflight returned no duplicates, the additive
inbox migration is deployed to the Neon test database, and all worker modes
passed against the new dedicated Upstash queue database. Northflank's free
project allows only two jobs, so a follow-up adds one five-minute maintenance
dispatcher alongside the API-triggerable on-demand/catch-up job. The realtime
service remains paused while that follow-up passes PR/CI and the controlled
cutover completes. The safe `all` default remains available for rollback.

The Operations assignment and Support workbench is code-complete and locally
verified. `GET /admin/operations-workbench` supplies exact workflow counts and
a bounded action queue spanning assigned/claimable fulfillment, assigned
Support, resolution/trust, moderation, and assigned-site readiness. Operations
order reads are server-scoped to actionable or assigned-support contexts and
sanitized before return; claim remains race-safe through the existing
fulfillment assignment service. Role-specific branding and navigation now
identify Super Admin, Operations, and Finance without changing their API
authority.

The Finance money-operations workbench is code-complete and locally verified.
The admin shell keeps the established grouped navigation while giving Finance
a role-specific Workbench, Finance Center, Evidence Review, and first-position
Support entry. `GET /admin/finance-workbench` supplies exact decision counts,
a bounded Support-aware priority queue, pipeline/reconciliation/revenue/debt
health, and sanitized allowlisted activity. The endpoint is Finance/Super
Admin-only, no-store, and read-only; payout decryption, raw provider failures,
and every high-impact money mutation stay separately permissioned and audited.
The in-app browser client blocked localhost navigation, but the live endpoint
is registered and authentication-protected, and all automated validation is
green.

The customer order workbench is code-complete on
`agent/customer-order-workbench` and locally validated against seeded OWNER
and MEMBER accounts. The publisher workbench is preserved in the parent
commit. Neither redesign changes payment, payout, order-state, ownership, or
cancellation authorization; both consume existing secured endpoints and expose
existing snapshot, deadline, brief, balance, and earnings fields through the
typed client.

Platform/publisher inventory, the reviewed marketplace taxonomy and placement
policy, and website-scoped Google marketplace summaries are code-complete. Both
July 18 migrations are applied and verified locally and on Neon. Worker
deployment and real-Google staging validation remain.

Publisher DNS verification remains unchanged. Platform sites skip DNS, while
both ownership types can explicitly link one GSC property and one GA4 property
to their single website/listing aggregate. GSC and GA4 syncs populate the
buyer-safe rolling 30-day metrics used by marketplace cards, details, traffic
filters, and default ranking. Google account selection is independent from
GuestPost login identity.

Operations can create platform websites from the admin portal; the API always
assigns those sites to the creator and existing order creation automatically
creates the matching fulfillment assignment for new platform orders. On an
assigned site, Operations can add/edit/pause listing services and connect,
link, unlink, or sync GSC/GA4. Publisher services and unassigned platform sites
remain inaccessible to Operations.

The July 14 Operations fulfillment gap is now implemented locally. Staging
validation should cover claim contention, customer review, publication,
verification, cancellation, and staff performance totals using production-like
data.

## Explicit Phase Boundaries

> **Phase 5C** ends when a publisher can successfully connect Google Search Console, link a property, synchronize it, and manage the integration. Displaying search analytics is explicitly deferred to Phase 5D.

> **Phase 5D marketplace slice is complete**: GSC/GA4 daily ingestion feeds buyer-safe listing summaries. Full owner reporting APIs, historical trend charts, pagination/backfill controls, and KPI dashboards remain a later reporting expansion.

## Next Actions

1. **Stripe deposit certification** — manually create the replacement restricted test key with only Checkout Sessions (platform Write), Accounts (platform Write), Account Links (platform Write), Transfers (platform Write), and Payouts (Connect Write); place it in Render without copying it into docs/logs; then re-enable deposits and complete one user-initiated sandbox Checkout. Verify the exact webhook, one-and-only-one wallet credit and ledger row, and a safe duplicate replay before treating deposits as certified.
2. **Stripe Connect certification** — keep `STRIPE_CONNECT_ENABLED=false` and the database provider inactive until an internal publisher completes hosted sandbox onboarding. Then certify platform Transfer, connected-account Payout, failure/reversal handling, fee disclosure, notifications, reconciliation, and statement-text behavior before enabling any broader cohort.
3. **Live-mode gate** — keep `STRIPE_LIVE_MODE_ENABLED=false`; complete legal entity, country/currency, business-profile, descriptor, webhook, restricted-key, bank-statement, incident, and rollback reviews in a separate production change.
4. **Redis quota validation** — monitor dedicated staging `QUEUE_REDIS_URL` commands/day for at least 24 hours after the hybrid cutover before treating the cost model as validated.
5. **Google integration staging pass** — authorize the production callback URI, connect a Google account different from the GuestPost login, discover/link GSC and GA4 properties for one publisher and one platform site, then verify daily rows and their buyer-safe 30-day listing summaries are written only to the selected website mappings.
6. **Auth IP warning follow-up** — Render logs now show Better Auth falling back to a shared per-path rate-limit bucket when no trusted client IP header is resolved; configure Better Auth trusted proxy/IP headers before production hardening.
7. **OAuth configuration** — authorize the deployed Google redirect URI `https://api.guestpost.pro.bd/api/v1/integrations/GOOGLE_SEARCH_CONSOLE/callback` plus any localhost callback still needed for development.
8. **Historical credential containment** — the exposed Neon owner credential was invalidated, but the old value remains in git history. Assess whether repository history/access containment is needed before production.
9. **Reporting expansion** — build on the completed GSC/GA4 ingestion
   - Pagination, configurable date windows, historical imports, and retry observability
   - Owner reporting endpoints (`GET /websites/:id/metrics`)
   - GSC/GA4 KPI cards and historical trend charts
10. **Additional providers** — Bing Webmaster Tools

## Backlog (Future Cleanup)

- Align Zod schema optionality with UI contracts (remove temporary `as` casts and bridge interfaces)
- Website detail API should return nested `integration` and `metrics` objects (currently composed client-side from `useIntegrations()`)
- Replace inline `Website` interface in list page with shared type

## Pre-Production Validation (Open Questions)

- OAuth refresh token lifecycle with real Google credentials
- Google API quota exhaustion handling
- Worker retry/backoff behavior
- Worker recovery after service restart
- Large-account discovery performance (hundreds of GSC properties)
- Concurrent sync request handling
- Audit event coverage for every integration action
- End-to-end reconnect flow
- Load testing with many linked websites

## Blockers

- Historical credential containment and Render environment review require operator access to the deployed Render project.
- Hybrid worker activation now requires the reviewed branch to pass GitHub CI
  and the explicit Northflank service/job configuration; the repository
  intentionally defaults to compatibility `all` mode until that
  operator-controlled cutover occurs.

## Completed 2026-07-24: order lifecycle hardening and local validation

- Prisma Client generated and `20260723180000_order_article_versions` applied to the local database.
- Customer, publisher, and Operations order pages now expose canonical lifecycle, timeline metadata, and role-relevant article history.
- Fixed publisher delivery-proof/review null-organization failures, post-create zero-total response snapshots, itemless listing-service pricing, service-query loss on login, and stale Next development output causing nested-route 404s.
- Full validation is green: 12 shared suites/108 tests; 99 API suites/997 tests; focused production builds passed; live role API and development-route smoke checks passed.
- Local smoke orders: `cmrxyiub900047pukwa0vbvu2` (platform, paid, customer article) and `cmrxym4uf000f7pukbk1usr8a` (publisher, paid, customer article).

## Completed 2026-07-24: campaign marketplace handoff cleanup

- Campaign list and detail actions now enter the marketplace with a canonical campaign context instead of opening the retired duplicate order form.
- Marketplace listing and service navigation preserves that context, and the order form submits it only when it matches a campaign returned by the tenant-scoped campaign API.
- The legacy `/dashboard/orders/new` page is now a fail-closed compatibility redirect that accepts the historical query name without retaining a second order-creation path.
