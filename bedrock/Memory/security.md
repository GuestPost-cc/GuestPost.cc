---
note_type: domain-memory
domain: security
project: guestpost-platform
updated: 2026-09-08
---

# Security

## Audit Logging

- `AuditLog` model tracks all financial/security actions
- All hot money paths write audit in-transaction (fixed pool-deadlock: pass `tx` to `audit.log`)
- Cold paths (disputes, refunds, settlements admin actions) pending sweep

## Encryption

- **PayoutMethod details**: AES-256-GCM encrypted via `PayoutEncryptionService`
- **PayoutProvider config**: AES-256-GCM encrypted
- **Decrypt endpoint** `POST /admin/payout-methods/:id/decrypt`: permission-gated (`FINANCIAL_DATA_DECRYPT`), reason required (min 10 chars), `PAYOUT_METHOD_DECRYPTED` audit (actor/reason/IP/UA), `Cache-Control: no-store`
- Provider error messages redacted via `redactSensitive()` in PayoutExecutionService

## Webhook Security

- Stripe: HMAC verified before queueing (timing-safe, 300s tolerance)
- Wise: RSA-SHA256 signature verified
- Fail-closed: missing config → 503, bad sig → 401

## Guards

- `AuthGuard` (global) — validates session
- `CurrentAuthorityGuard` (global, after `AuthGuard`) — resolves User,
  ActiveContext, active customer/publisher membership, StaffMembership role,
  and staff permissions from PostgreSQL once per request
- The 30-second auth-context cache is presentation-only. `ActorTypeGuard`,
  `MemberRolesGuard`, `StaffRolesGuard`, `OrderOwnershipGuard`, and
  `PermissionsGuard` consume the fresh request authority and never authorize
  from cached tenant/role/permission fields.
- Generic support read/reply is customer/publisher-only; staff use the guarded
  admin surface. Generic settlement detail is customer-only; staff use the
  guarded admin settlement surface.

## Full Application Row-Level Security

- The staged full boundary classifies all 99 Prisma models and installs
  explicit SELECT/INSERT/UPDATE/DELETE policies for customer, publisher,
  staff, Better Auth, catalog, webhook, and worker workloads. The migration
  leaves the six active Phase 1 `ApiKey` policies untouched while staging 392
  inert policies across the other 98 models. A separately confirmed activation
  script verifies that state, prepares authorizer grants, atomically swaps
  `ApiKey` to its four full-boundary policies, and verifies the final 99-table,
  396-policy boundary before commit.
- Customer and publisher policies recheck live membership and non-suspended
  users. Customer API keys additionally recheck the live OWNER role, so a
  forged/stale organization-role setting cannot grant access. Staff policies
  ignore caller-supplied role settings and derive SUPER_ADMIN, OPERATIONS, or
  FINANCE authority from live `StaffMembership` rows.
- Better Auth uses `AUTH_DATABASE_URL` and a separate auth identity because it
  performs session/account reads before tenant context exists. API startup
  fails when `RLS_ENFORCEMENT_ENABLED=true` without that URL. The auth role has
  only account/session and birth-time provisioning tables, not orders,
  marketplace, payouts, or reporting.
- A central RLS-aware Prisma proxy wraps each operation in an interactive
  transaction, sets and clears every context GUC with transaction-local
  `set_config`, and rejects array-form transactions while enforcement is on.
  Explicit security transactions (organization-owner and opaque-key
  validation) unwrap the proxy and install their exact context on the raw
  transaction host. Transaction completion prevents connection-pool context
  leakage.
- Reviewed catalog rows are shared intentionally with live customers and
  publishers; draft/unverified listings or listings on inactive/unverified
  websites remain hidden. Authenticated telemetry is bound to the exact actor;
  anonymous telemetry cannot claim a user ID. Public review authors use
  display-safe name/image snapshots, so catalog reads never require access to
  private `User` rows. Public website metrics remain restricted to reviewed
  catalog websites. RLS remains a row boundary, not column masking, so endpoint
  projections and API guards remain mandatory.
- Mutation authorization is command-aware. Customer and publisher membership
  writes recheck live owner rows, non-owner invite acceptance is constrained by
  a database trigger to the unchanged PENDING-to-ACTIVE transition, Operations
  cannot mutate staff authority, and audit rows are append-only. Database
  triggers also reject deletion/demotion of the last active customer or
  publisher owner to prevent an application lockout; parent-scoped advisory
  transaction locks serialize concurrent owner transitions before recounting.
- The 11-role topology keeps schema owner, migrator, API, auth, worker,
  reporting, and the boolean-only RLS authorizer separate. All are
  non-superuser and `NOBYPASSRLS`; provisioning leaves credential roles
  `NOLOGIN`. The worker is a platform service principal with an explicit model
  allowlist and required server-selected queue context. Reporting has no table
  grants.
- `scripts/test-full-rls-boundary.sql` is a destructive ephemeral-database
  proof covering customer owner/member, publisher, staff roles, auth, public,
  worker, cross-tenant DML, spoofed role/telemetry, membership self-promotion,
  invite acceptance, last-owner preservation, append-only audit, delivery
  fencing, no-context denial, suspension, and immediate authority revocation.
  CI builds a dedicated database and runs the full
  provision/activate/reprovision/test sequence. Reprovisioning restores the
  NOLOGIN authorizer's schema usage and read-only access to existing policy
  roots, while future roots still require explicit migration grants.
- Rollout is lockout-safe: install policies inert, provision disabled roles,
  verify separate credentials, deploy context-aware code, canary, activate
  atomically, and canary again. The guarded emergency script disables the
  generalized boundary atomically while preserving Phase 1 `ApiKey` RLS.
  `docs/RLS_ROLLOUT.md` is canonical.

## Support Messaging Security

- Generic support is available to customers and order-authorized publishers.
  Staff access is limited to Super Admin and assignment-scoped Operations;
  Finance and unknown/missing staff roles fail closed.
- Operations treats a ticket as Platform support only when it has an explicit
  `PLATFORM` channel with no publisher owner, or when it is an unambiguous
  legacy general ticket with null order, channel, and publisher owner. Every
  contradictory or ambiguous legacy route fails closed, and the support inbox
  and Operations workbench consume the same predicate.
- The API projects a stable sender party, safe display name, and `isSelf` flag.
  Public ticket responses omit raw requester, organization, assignment, user,
  email, forensic snapshot, and internal-note fields rather than returning
  redacted placeholders. Only Super Admin receives raw forensic IDs/email.
- `PUBLIC` visibility is part of the database message-page predicate before
  cursor and limit. Internal notes therefore cannot leak, consume a public page
  slot, change its cursor, or disclose staff activity through inbox ordering.
- Create and reply commands require actor-scoped UUID v4 idempotency keys.
  Exact normalized replay returns the original row without duplicate audit or
  notification evidence; mismatched key reuse fails with conflict.
- Ticket create/reply/status/claim/reassignment re-resolve live authority in
  their serializable locked transaction. A prior list/detail response is never
  accepted as authorization for a later mutation.
- Terminal order-ticket claim and Super Admin reassignment share one
  Order-before-Ticket eligibility boundary and never mutate fulfillment
  history. A disputed order requires a live `OPEN`/`UNDER_REVIEW` dispute with
  a post-fulfillment previous status; inconsistent or stale dispute projections
  fail closed. Reassignment revalidates both the Super Admin actor and the
  active, non-banned Operations target and records the reason in atomic system,
  audit, and outbox evidence. A required expected-owner precondition is compared
  under the Ticket lock, so concurrent stale reassignment loses with no writes
  instead of silently overwriting the first administrator's decision.
- Operations demotion and suspension use the same serializable staff
  offboarding boundary as fulfillment ownership. Any assigned non-closed
  Support ticket, including `RESOLVED`, blocks authority removal. Historical
  `CLOSED` tickets are atomically released to the unassigned queue and the
  released count is retained in the protected role/suspension audit event.
  Any managed platform Website also blocks authority removal so future orders
  cannot route to former Operations staff. Platform Website creation and
  reassignment take the shared staff lock order, revalidate the active target,
  and commit reassignment plus its audit evidence atomically.

## Channel Security

- BullMQ job payloads HMAC-signed via `QUEUE_SIGNING_SECRET`
- Helmet security headers with strict CSP
- CORS origin allowlist configured
- Rate limiting: environment-aware tiered limits (auth, marketplace, billing, admin)

## Critical Rules

- No first-membership-wins — all context from ActiveContext table
- SUPER_ADMIN does not bypass `SENSITIVE_PERMISSIONS` — `FINANCIAL_DATA_DECRYPT` must be explicitly granted
- Stripe webhook dummy mode removed — all envs require real Stripe keys
- All critical statuses (PAID, ACCEPTED, VERIFIED, COMPLETED, REFUNDED) are system-only
- Business-action endpoints replace generic status transitions (prevents unauthorized transitions)
