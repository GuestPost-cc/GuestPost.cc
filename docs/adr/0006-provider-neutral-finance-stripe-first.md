# ADR 0006: Provider-neutral finance with a Stripe-first rollout

- Status: Accepted
- Date: 2026-07-20

## Context

GuestPost accepts customer funds into an internal wallet and later pays earned
publisher balances. Stripe, PayPal, Wise, banks, and future crypto providers
move real money, but none of them explains who owns the money or why.

The previous Stripe payout adapter treated a Connect Transfer as a completed
bank payout. That is unsafe: a Transfer only moves funds from the platform
Stripe balance to a connected Stripe balance. A separate Payout moves those
funds to the publisher's bank.

## Decision

1. GuestPost's transaction, wallet, settlement, withdrawal, and payout records
   remain authoritative. Providers never directly mutate a balance.
2. Customer-facing method and execution provider are separate concepts:
   `CARD + STRIPE` now; `CARD + another provider` can be added later.
3. Every customer deposit has a `DepositAttempt`, public reference, immutable
   expected amount/currency/fee snapshot, provider identifiers, and one linked
   ledger transaction.
4. Every provider webhook is signature-verified against its raw body and
   durably deduplicated before a financial transition.
5. Publisher bank details are collected by Stripe-hosted Connect onboarding.
   GuestPost stores the connected-account identifier and readiness state, not
   the full bank account number.
6. Stripe publisher payout is a two-stage state machine:

   ```text
   GuestPost withdrawal reserved
     -> Stripe Transfer created (platform -> connected balance)
     -> Stripe Payout created (connected balance -> bank)
     -> payout.paid
     -> GuestPost withdrawal completed
   ```

7. A failed bank payout after a Transfer is a recovery-required state. Funds
   remain reserved until Finance safely cancels the Payout and reverses the
   Transfer. A local failure must never make funds withdrawable again while
   they still exist in a provider balance.
8. Initial currency is USD. Amount, source currency, destination currency,
   delivered amount, and fees are nevertheless snapshotted for future FX.
9. Initial fee policy is `stripe-initial-v1`: customers receive the full wallet
   credit and publishers receive the full requested withdrawal; GuestPost
   absorbs provider fees. A future policy must use a new version and explicit
   pre-confirmation disclosure.
10. New providers must implement the adapter contract and pass the certification
    checklist in `docs/PROVIDER_ROLLOUT_GUIDE.md` before being enabled.

## Consequences

- The platform can change providers without redefining wallet or settlement
  ownership.
- Stripe Checkout redirects are informational; only verified webhooks credit a
  wallet.
- Stripe Transfer IDs and Payout IDs are retained separately for recovery.
- Publisher statements may contain the requested short `GPOST` reference, but
  downstream banks can replace or truncate provider-supplied text. The durable
  GuestPost public reference remains the support and reconciliation key.
- A full double-entry general ledger and provider-clearing accounts remain the
  next accounting evolution. This change establishes the required provider-
  neutral identities and invariants without replacing the current ledger.
