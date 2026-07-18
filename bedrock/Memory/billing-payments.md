---
note_type: domain-memory
domain: billing-payments
project: guestpost-platform
updated: 2026-07-16
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

- Wallet deposits start as Stripe Checkout Sessions. There is no direct API credit path: only a verified `checkout.session.completed` webhook credits a wallet.
- Stripe webhooks are signature-verified from the raw body before any wallet mutation. Missing webhook configuration fails closed.
- A deposit ledger row is keyed by the Checkout session reference and also carries `provider: "stripe"` plus the PaymentIntent in `providerRef`.
- The database enforces provider-aware uniqueness for non-null provider references. This prevents a replay under a different Checkout session ID from double-crediting the same Stripe payment.

### Money Safety

- `splitPlatformFee` Decimal helper (fee-by-subtraction)
- The buyer billing page consumes the API client's `TransactionResponse` contract directly. Transaction amounts may arrive as `string | number` and are converted with `Number(...)` only at arithmetic and display boundaries; avoid narrower page-local transaction interfaces.
- Customer Billing is an OWNER-only portal surface. The sidebar omits it for MEMBER users and the page independently fails closed on a direct member URL. Available and reserved balances come directly from `GET /billing/wallet`; reservation rows are labeled as held funds rather than duplicate spend. Dashboard and checkout expose the same authoritative balance fields without changing wallet, deposit, capture, refund, or settlement behavior.
- `Transaction.reference @@unique` is the primary webhook idempotency key; provider-aware `providerRef` uniqueness is defence in depth.
- Refunds are wallet-credit only (no Stripe refund-to-card yet)
- Chargebacks reserve the still-available portion of the originating deposit, record any shortfall, and notify staff. The dispute lookups use the same Stripe provider identity as the write path.
- Platform-fee changes use an optimistic-lock update and an audit event containing the changed field, old value, new value, and staff-supplied reason.

## Key Models

- `Wallet` — per-org wallet with `balance` Decimal (versioned)
- `Transaction` — ledger row with `reference` unique constraint plus optional provider and provider reference

## Key Files

- `apps/api/src/modules/billing/` — wallet, deposits, payments
- `apps/api/src/modules/billing/__tests__/`
- `apps/api/src/common/platform-fee.ts`
