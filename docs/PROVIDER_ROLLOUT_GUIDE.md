# Provider rollout guide

Use this guide for PayPal, Wise, local banks, or a hosted stablecoin provider.
No new provider is enabled merely because its API call succeeds.

## Adapter boundaries

A deposit adapter may create a checkout/deposit instruction, retrieve provider
truth, request a refund, and verify/normalize webhooks. It may not write wallet
balances or ledger rows.

A payout adapter may validate a provider-managed recipient, submit money,
retrieve status, cancel where safe, and verify/normalize webhooks. It may not
change publisher balances, settlements, withdrawals, or lifetime totals.

The method remains separate from the provider. Examples:

| Method | Provider today | Possible future provider |
|---|---|---|
| Card deposit | Stripe | Adyen or another acquirer |
| Bank-account payout | Stripe Connect | Wise or local bank API |
| PayPal payout | Disabled | PayPal Payouts |
| Stablecoin deposit | Disabled | Approved hosted/custody provider |

## Implementation map

- Data contracts and invariants: `packages/database/prisma/schema.prisma` and
  additive migrations under `packages/database/prisma/migrations/`.
- Shared public references, fee snapshots, provider status normalization, and
  reconciliation: `packages/shared/src/financial-reference.ts`,
  `payout-status.ts`, and `reconciliation-core.ts`.
- Deposit adapter contract/registry: `apps/api/src/modules/billing/providers/`.
  Add the adapter to `DepositProviderService`; keep all wallet/ledger writes in
  `BillingService`.
- Payout adapter contract/registry: the `providers/` directory under
  `apps/api/src/modules/publisher-payouts/` and `PayoutProviderService`. Add an
  explicit method-to-provider
  route in `PayoutExecutionService`; an unknown route must remain blocked.
- Durable payout event processing and stale-stage recovery:
  `apps/worker/src/processors/payout.processor.ts`.
- Provider-independent browser contract: `packages/api-client/`; portal and
  publisher screens must consume gross/fee/net/reference/status, not raw
  provider objects.
- Operations and certification evidence: this guide,
  `PAYMENTS_ARCHITECTURE.md`, and provider-specific staging runbooks.

## Required provider capabilities

Document supported countries/currencies, minor-unit rules, recipient
onboarding, verification/KYC, status polling, signed webhooks, event ordering,
idempotency, cancellation semantics, references/descriptors, fee reporting,
FX, refunds/disputes, rate limits, and provider outage behavior.

## Certification gates

1. Legal/compliance approval for the platform entity and user countries.
2. Secrets held only in the deployment secret manager; least-privilege keys;
   rotation and revocation tested.
3. Test/live mode separation and a deliberate live-mode boot gate.
4. Server-owned amount/currency; no provider amount accepted from browser
   metadata as authoritative.
5. Stable idempotency keys for every external mutation.
   Public financial endpoints must require the key and bind it to the original
   amount, currency, method, and destination.
6. Raw-body signature verification, replay tolerance, durable event inbox,
   duplicate and out-of-order tests.
7. Exact internal state-machine mapping; ambiguous states remain pending.
8. Provider IDs persisted before any dependent external call.
9. Refund, dispute, cancellation, partial failure, timeout-after-send, and
   provider-outage recovery proven in sandbox.
10. Gross/fee/net/reference snapshots exposed before confirmation and retained
    after completion.
11. Internal reconciliation plus provider transaction/balance reconciliation.
12. Finance runbook, support reference lookup, alerts, dashboards, and kill
    switch exercised.
13. Canary limits: low per-transaction/daily caps and manual approval.
14. Two-person review of the first live-money batch.

## Rollout sequence

```text
adapter compiled but disabled
  -> contract/unit tests
  -> provider sandbox certification
  -> internal staff-only test
  -> small allowlisted canary
  -> capped percentage rollout
  -> general availability
```

At every phase, the kill switch stops new sends but does not stop webhook
verification or reconciliation of already in-flight funds.

## Future-specific constraints

- PayPal: capture/webhook confirmation credits deposits; publisher identity
  must be saved and verified before a Payout item is created.
- Wise/bank deposits: unique public reference + amount + currency must match
  confirmed receipt; browser upload is never proof of funds.
- Local bank: use country-specific normalized schemas, not unvalidated generic
  JSON entered by Finance at execution time.
- Crypto: use a hosted/custody provider, stablecoins and approved networks only;
  never store private keys in the application database; persist quote, atomic
  amount, network, transaction hash, confirmations, rate, and all fees.
