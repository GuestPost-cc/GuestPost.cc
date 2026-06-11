---
note_type: domain-memory
domain: billing-payments
project: guestpost-platform
updated: 2026-06-11
---

# Billing & Payments

## Wallet-Based Payment System

Pattern: **reserve → capture → release** using Stripe integration.

### Transaction Types

`TransactionType` enum: `DEPOSIT`, `PURCHASE`, `REFUND`, `WITHDRAWAL`, `WITHDRAWAL_REVERSAL`, `SETTLEMENT_RELEASE`, `SETTLEMENT_CLAWBACK`, `DEBT_REPAYMENT`, `RESERVATION`

### Concurrency

- Version-based optimistic concurrency on `Wallet` prevents race conditions
- In-transaction audit logging on all money paths (pool-deadlock fixed — all hot paths pass `tx` to `audit.log`)
- `submitPayment` claims order (version-guarded DRAFT→PAID) BEFORE money moves; reserve/pay run inside same tx
- PrismaService tuned: `connection_limit=25` + `pool_timeout=20`; transactionOptions maxWait 10s / timeout 20s

### Stripe Integration

- Stripe webhooks verified BEFORE queueing (HMAC `stripe-signature` t/v1, 300s tolerance, timing-safe via `STRIPE_PAYOUT_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET`)
- Bad sig → 401, missing config → 503, never enqueued
- Stripe adapter: idempotency via `Idempotency-Key` HTTP header

### Money Safety

- `splitPlatformFee` Decimal helper (fee-by-subtraction)
- `Transaction.reference @@unique`: database-level duplicate prevention for webhooks
- Refunds are wallet-credit only (no Stripe refund-to-card yet)
- Chargebacks handled via `charge.dispute.created` webhook + staff notifications

## Key Models

- `Wallet` — per-org wallet with `balance` Decimal (versioned)
- `Transaction` — ledger row with `reference` unique constraint

## Key Files

- `apps/api/src/modules/billing/` — wallet, deposits, payments
- `apps/api/src/modules/billing/__tests__/`
- `apps/api/src/common/platform-fee.ts`
