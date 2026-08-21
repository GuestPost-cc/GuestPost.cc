---
note_type: domain-memory
domain: security
project: guestpost-platform
updated: 2026-08-14
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
