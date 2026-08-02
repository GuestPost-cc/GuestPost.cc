---
note_type: domain-memory
domain: billing-payments
project: guestpost-platform
updated: 2026-08-02
---

# Billing & Payments

`docs/FINANCIAL_INVARIANTS.md` is canonical when this summary is incomplete.

## Closed-loop wallet

Customer money uses reserve, capture, and release under a locked/versioned
`Wallet`. Every new available-balance spend enters through
`BillingService.reserve`; captures consume only an existing owned reservation.
Both reservation and capture lock and re-authorize the owned wallet and fail
closed on positive open/lost uncovered dispute exposure, so a standalone
capture cannot spend an earlier reservation after a zero-held dispute case is
recorded.
Order checkout locks the Order before the Wallet and validates its exact USD
item contract before either reservation or capture. The paid transition,
reservation, PURCHASE evidence, audit, and submission commit atomically; a
concurrent checkout request cannot debit the same Order twice.
The former customer wallet-withdrawal endpoint and API-client method are
retired because they reduced an internal balance without an external return.
A future return requires source allocation, destination policy, provider
execution, terminal evidence, and reconciliation.

## Stripe deposits

A durable `DepositAttempt` precedes Checkout. Only a fresh signature-verified
paid event—or a separately certified authenticated retrieval finalizer—may
credit a wallet. Attempt, wallet, one exact `DEPOSIT` ledger row, inbox state,
and audit commit atomically.

Exact replay requires the same Checkout session, PaymentIntent, wallet, amount,
currency, ledger row, and a wallet-credit-backed attempt. The backed statuses
are `SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`, `DISPUTED`, and
`CHARGEBACK`; derivative refund/dispute state does not erase the original
credit fact. A uniqueness error is never accepted without a fresh
post-rollback exact comparison.

Every newly accepted Stripe `PaymentProviderEvent` has immutable non-null
`livemode`; historical rows without that fact cannot authorize a new money
transition. Shared key classification supports both `sk_test_`/`sk_live_` and
least-privilege `rk_test_`/`rk_live_`. Credential and event modes must match.
Checkout-success recovery currently requires fresh signed Stripe redelivery;
the normalized inbox alone cannot authorize a credit. In locked finance mode,
the API persists the inbox row as `PENDING` but returns 503 so Stripe keeps
redelivering; it acknowledges only after a recovery-capable mode can consume
the fresh signed body.

## Payment disputes

Chargebacks use provider-neutral `PaymentDispute` cases keyed by
`(provider, providerDisputeId)`. The original PaymentIntent identity belongs
only to the deposit; hold/release/loss ledger rows use case-owned internal
references. Case, wallet, ledger, inbox, audit, and structured shortfall
converge in one serializable transition.

Spend reservation and dispute processing share `Wallet ... FOR UPDATE`.
Positive `OPEN` or `LOST` current exposure blocks new available-balance spend
with `409 WALLET_SPEND_BLOCKED_BY_DISPUTE`. Won/zero exposure permits spend.
Future credits are not auto-netted against lost shortfall; that requires a
separately reviewed recovery aggregate.

The five-minute durable worker retries transient dispute events from immutable
normalized facts and quarantines deterministic contradictions or exhaustion.

## Runtime and release

Finance runtime mode gates new liabilities, operator decisions, recovery,
reconciliation, sends, and manual completion independently from Stripe feature
flags. Missing/invalid production mode is `locked`; signed inbound evidence
still persists. Provider-inbox/dispute guards require a hard-drain cutover,
sanitized populated-clone rehearsal, validated constraints, incident queries,
and signed Stripe staging evidence.

## Key files

- `apps/api/src/modules/billing/`
- `apps/worker/src/processors/payment-dispute.processor.ts`
- `packages/shared/src/deposit-status.ts`
- `packages/shared/src/payment-dispute-core.ts`
- `packages/shared/src/stripe-key-mode.ts`
- `docs/STRIPE_STAGING_RUNBOOK.md`
