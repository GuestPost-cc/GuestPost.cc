---
note_type: domain-memory
domain: publisher-payouts
project: guestpost-platform
updated: 2026-06-11
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

## Payout Methods

Stored encrypted (AES-256-GCM) via `PayoutEncryptionService`. Types: bank_transfer, paypal, wise. Decrypt endpoint is permission-gated (`FINANCIAL_DATA_DECRYPT` permission + reason required).

## Payout Providers

Three adapter implementations via `PayoutProviderAdapter` interface:
- **Manual** — operator manually processes, then marks paid
- **Wise** — real API integration with idempotency via `customerTransactionId` (deterministic UUID)
- **Stripe Connect** — Stripe Connect transfers

Provider config stored encrypted. Missing API key → throws in production; fake COMPLETED in mock mode only.

## Payout Execution

Each payout attempt tracked in `PayoutExecution` with provider reference, idempotency key, status. `retryExecution` checks provider status of prior execution before re-sending.

### Webhooks

- Stripe: HMAC verification via `STRIPE_PAYOUT_WEBHOOK_SECRET` (falls back to `STRIPE_WEBHOOK_SECRET`)
- Wise: RSA-SHA256 verification via `WISE_WEBHOOK_PUBLIC_KEY` (PEM)
- Webhook controller is `@Public()` — signature verification IS the authentication

### Status Poller

BullMQ repeatable job `payout-check-status` every 10m (jobId `payout-check-status-poll`). Polls PROCESSING executions and transitions them. Payload HMAC-signed.

## Key Models

- `PublisherBalance` — balance tracking (versioned)
- `Withdrawal` — withdrawal request with hold tier
- `PayoutMethod` — encrypted payout details
- `PayoutProvider` — provider config (encrypted)
- `PayoutExecution` — individual payout attempt
- `PayoutBatch` — batch grouping

## Key Files

- `apps/api/src/modules/publisher-payouts/`
- `apps/api/src/modules/publisher-payouts/__tests__/`
- `apps/api/src/modules/publisher-payouts/providers/` — adapter implementations
- `packages/shared/src/payout-status.ts` — provider status fetchers
