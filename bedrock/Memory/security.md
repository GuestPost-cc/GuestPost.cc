---
note_type: domain-memory
domain: security
project: guestpost-platform
updated: 2026-06-11
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
- `ActorTypeGuard` — domain isolation (CUSTOMER / PUBLISHER / STAFF)
- `MemberRolesGuard` / `StaffRolesGuard` — role enforcement
- `OrderOwnershipGuard` — resource ownership validation
- `PermissionsGuard` — sensitive permission checks (uncached)

## Channel Security

- BullMQ job payloads HMAC-signed via `QUEUE_SIGNING_SECRET`
- Helmet security headers with strict CSP
- CORS origin allowlist configured
- Rate limiting: environment-aware tiered limits (auth, marketplace, billing, admin)

## Critical Rules

- No first-membership-wins — all context from ActiveContext table
- SUPER_ADMIN does not bypass `SENSITIVE_PERMISSIONS` — `FINANCIAL_DATA_DECRYPT` must be explicitly granted
- Stripe webhook dummy mode removed — all envs require real Stripe keys
- All critical statuses (PAID, ACCEPTED, VERIFIED, SETTLED, COMPLETED, REFUNDED) are system-only
- Business-action endpoints replace generic status transitions (prevents unauthorized transitions)
