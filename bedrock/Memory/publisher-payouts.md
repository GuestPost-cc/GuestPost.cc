---
note_type: domain-memory
domain: publisher-payouts
project: guestpost-platform
updated: 2026-07-16
---

# Publisher Payouts

## Publisher Balance

`PublisherBalance` tracks: `pendingBalance`, `approvedBalance`, `withdrawableBalance`, `debtBalance`, `lifetimeEarnings`, `lifetimePaid`. Version-based optimistic concurrency.

## Withdrawals

Tier-based holds enforced at approval:
- **NEW**: 30-day hold (availableAt set 30d from approve)
- **TRUSTED**: 14-day hold
- **VERIFIED**: 7-day hold

Idempotency via `@@unique([publisherId, idempotencyKey])`. Ledger rows: `WITHDRAWAL` at request, `WITHDRAWAL_REVERSAL` at reject.

Approval is a single transaction, not a pre-check followed by a mutation. It re-validates the pending status, tier hold, publisher ban, active membership, withdrawable balance, active payout method, and absence of an in-flight execution before a version-guarded transition. Every rejected precondition creates a `WITHDRAWAL_APPROVAL_BLOCKED` audit event with a structured reason code.

## Payout Methods

Stored encrypted (AES-256-GCM) via `PayoutEncryptionService`. Types: bank_transfer, paypal, wise. Decrypt endpoint is permission-gated (`FINANCIAL_DATA_DECRYPT` permission + reason required).

Decrypt audit context uses the server-resolved request IP and user agent; it does not trust a caller-supplied forwarding header.

## Payout Providers

Three adapter implementations via `PayoutProviderAdapter` interface:
- **Manual** — operator manually processes, then marks paid
- **Wise** — real API integration with idempotency via `customerTransactionId` (deterministic UUID)
- **Stripe Connect** — Stripe Connect transfers

Provider config stored encrypted. Missing API key → throws in production; fake COMPLETED in mock mode only.

## Payout Execution

Each payout attempt tracked in `PayoutExecution` with provider reference, idempotency key, status. `retryExecution` checks provider status of prior execution before re-sending.

Payout initiation is synchronous in the authenticated API; the worker never
creates or sends a new payout. If a provider accepted a transfer but local
finalization fails, the returned provider transfer ID is persisted for
reconciliation. A failed execution without a provider ID is treated as
ambiguous and cannot be automatically resent with a new idempotency key.
Finance must reconcile the original provider idempotency key first.

Provider execution references are unique within each payout provider, and
webhook/status reconciliation also scopes every lookup by provider. Completion
locks the publisher balance row before moving withdrawal and balance state;
missing or conflicting balance state fails closed rather than silently
recording a partial completion.

### Webhooks

- Stripe: HMAC verification via `STRIPE_PAYOUT_WEBHOOK_SECRET` (falls back to `STRIPE_WEBHOOK_SECRET`)
- Wise: RSA-SHA256 verification via `WISE_WEBHOOK_PUBLIC_KEY` (PEM)
- Webhook controller is `@Public()` — signature verification IS the authentication
- After signature and timestamp verification, an allowlisted normalized event
  is durably inserted into `PayoutWebhookEvent` before the API returns 2xx.
  Redis is not part of the acknowledgement boundary.
- Deduplication uses the provider event ID when present, otherwise a SHA-256
  hash of the verified payload. The transfer ID alone is not an event identity,
  because one transfer can legitimately emit processing and terminal events.
- Unmatched provider references retry for up to 72 hours to cover the race where
  a webhook arrives before the provider transfer ID is committed locally.

### Status Poller

Northflank runs the allowlisted `payout-reconcile` scheduled task every 10
minutes. It drains the PostgreSQL webhook inbox first, then polls PROCESSING
executions. The task payload remains HMAC-signed and the one-shot worker exits
after completion. Legacy BullMQ repeatables remain available only in `all`
mode for rollout and rollback compatibility.

## Key Models

- `PublisherBalance` — balance tracking (versioned)
- `Withdrawal` — withdrawal request with hold tier
- `PayoutMethod` — encrypted payout details
- `PayoutProvider` — provider config (encrypted)
- `PayoutExecution` — individual payout attempt
- `PayoutWebhookEvent` — durable, deduplicated provider-event inbox
- `PayoutBatch` — batch grouping

## Key Files

- `apps/api/src/modules/publisher-payouts/`
- `apps/api/src/modules/publisher-payouts/__tests__/`
- `apps/api/src/modules/publisher-payouts/providers/` — adapter implementations
- `packages/shared/src/payout-status.ts` — provider status fetchers
