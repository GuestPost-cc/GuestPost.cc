# Stripe staging rollout runbook

This runbook is for Stripe test mode on the deployed staging/dev environment.
It does not authorize live money.

## 1. Preconditions

- The migration `20260720090000_stripe_first_finance_groundwork` is deployed.
- Every later finance-integrity migration is deployed and Prisma Client was
  generated from the same schema. `prisma migrate status` must be clean.
- Those migrations have first succeeded against a sanitized, populated recent
  clone. The clone and staging checks must report zero unvalidated financial
  constraints (`pg_constraint.convalidated = false`) and zero unexplained rows
  from `docs/FINANCIAL_INCIDENT_QUERIES.md`.
- API, worker, portal, and publisher app use the same release.
- Exactly one current worker fleet is running.
- The Stripe account/platform country and intended connected-account countries
  are legally and technically supported. Test mode success is not proof that a
  Bangladesh or other production entity can activate the same live product.
- Finance and Security owners are named for the test window.
- Wise is out of scope and remains disabled; Stripe staging evidence cannot
  certify Wise sends, completion, cancellation, or recovery.

## 2. Secret and feature configuration

Set in the deployment secret manager, never source control:

```text
STRIPE_SECRET_KEY=rk_test_...                  # least-privilege restricted key
STRIPE_WEBHOOK_SECRET=whsec_...               # customer deposit endpoint
STRIPE_PAYOUT_WEBHOOK_SECRET=whsec_...        # platform transfer endpoint
STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET=whsec_... # connected-account endpoint
STRIPE_DEPOSITS_ENABLED=true
STRIPE_CONNECT_ENABLED=true
STRIPE_LIVE_MODE_ENABLED=false
FINANCE_RUNTIME_MODE=recovery_only             # cutover/recovery posture
PAYOUT_EXECUTION_ENABLED=false                 # no new sends during cutover
PAYOUT_LEGACY_METHODS_ENABLED=false
NEXT_PUBLIC_PORTAL_URL=https://app.guestpost.pro.bd
NEXT_PUBLIC_PUBLISHER_URL=https://publisher.guestpost.pro.bd
```

The API must fail at boot if an enabled feature lacks its key/webhook secret.
Never put `sk_*`, `rk_*`, or `whsec_*` values in browser-exposed environment
variables, logs, screenshots, tickets, or documentation.

The staging restricted key grants only the Stripe Dashboard resources used by
this release: Checkout Sessions `Write`, Accounts `Write`, Account Links
`Write`, and Transfers `Write` under platform permissions, plus Payouts
`Write` under Connect permissions. `Write` includes the corresponding reads;
all unrelated platform and Connect resources remain `None`. Use a separate key
per environment and rotate it immediately if it is exposed.

## 3. Stripe Dashboard configuration

Create three webhook destinations so deposits, platform transfers, and
connected-account payouts each have a separate rotation boundary:

1. `https://api.guestpost.pro.bd/api/v1/billing/webhook/stripe`
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.dispute.created`
   - `charge.dispute.closed`
   - `radar.early_fraud_warning.created`
2. `https://api.guestpost.pro.bd/api/v1/payout-webhooks/stripe_connect/platform`
   - listen to events on **your account**;
   - `transfer.created`
   - `transfer.updated`
   - `transfer.reversed`
3. `https://api.guestpost.pro.bd/api/v1/payout-webhooks/stripe_connect/connected`
   - listen to events on **connected accounts**;
   - `account.updated`
   - `payout.created`
   - `payout.updated`
   - `payout.paid`
   - `payout.failed`
   - `payout.canceled`

Copy each destination's signing secret to its matching environment variable.
The payout destinations must not share a URL or secret. The platform route
accepts only `STRIPE_PAYOUT_WEBHOOK_SECRET` and transfer events without a
top-level Connect account. The connected route accepts only
`STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET` and requires the exact top-level
`acct_*` account on payout/account events. The legacy one-segment
`/payout-webhooks/stripe_connect` route returns 400 and never writes an inbox
row. Startup also rejects reused configured webhook secrets even while
outbound Stripe feature flags are disabled.

## 4. Deployment order

1. Build the evidence-aware release and record its SHA/image.
2. Pause new financial test actions and hard-drain every old API and worker
   writer. Feature flags alone do not make a mixed-version fleet safe.
3. Back up the database, then apply the finance migrations in the exact order
   documented in `docs/PRODUCTION_RUNBOOK.md`.
4. With the old API fully stopped, change the platform and connected-account
   Stripe Dashboard destinations from the retired shared URL to their explicit
   `/platform` and `/connected` URLs above. A delivery during this short gap
   may receive a non-2xx and must be allowed to retry; do not disable the
   destination or rotate its secret.
5. Start only the matching API/worker/app release. Verify old replica count is
   zero. Once evidence triggers are installed, an old image is not a rollback
   target; keep money gates closed and forward-fix.
6. Start with `FINANCE_RUNTIME_MODE=recovery_only`,
   `PAYOUT_EXECUTION_ENABLED=false`, and both Stripe feature flags false;
   restart and check health. Send one signed test delivery to each new payout
   URL, redeliver each exact event, and prove the correct channel persists once
   while the opposite secret and wrong topology are rejected without an inbox
   write. Confirm recovery/reconciliation and that a new
   liability/operator/send request returns `503 FINANCE_OPERATION_BLOCKED`.
7. Exercise `FINANCE_RUNTIME_MODE=locked`: signed inbound evidence and
   read-only inspection remain available, while provider polling, claim
   recovery, reconciliation workers, and every money mutation are blocked. A
   checkout-success delivery must persist `PENDING` evidence and return 503 so
   Stripe redelivers its non-replayable signed body. A signed
   `account.updated` must likewise persist without changing the account,
   schedule, or payout method and return 503; redelivering that exact event in
   `recovery_only` must perform one leased sync, one sanitized audit, and one
   `PROCESSED` transition. Return to `recovery_only` for the rest of the
   cutover.
8. Enable deposits, change to `FINANCE_RUNTIME_MODE=normal`, restart, and run
   the deposit matrix below.
9. Enable Connect while keeping `PAYOUT_EXECUTION_ENABLED=false`; restart and
   onboard one internal test publisher.
10. Only for the bounded payout matrix, set
   `PAYOUT_EXECUTION_ENABLED=true`. Return it to false immediately afterward.
11. Run reconciliation. It must return no new critical drift before
    continuing.

## 5. Deposit test matrix

- successful card: one `DepositAttempt`, one DEPOSIT ledger row, one wallet
  credit, public reference shown, expected test descriptor recorded;
- browser refresh/back/duplicate click: no second session/credit for the same
  idempotency key;
- missing/reused-with-different-details idempotency key: request rejected;
- abandoned/expired Checkout: no credit;
- forged or wrong-mode webhook: HTTP 400, no state change;
- persist both a signed test-mode deposit event and each signed dispute event;
  verify `PaymentProviderEvent.livemode = false`. Missing `livemode`, a live
  envelope with test credentials, a test envelope with live credentials, and
  malformed `sk_*`/`rk_*` prefixes all fail closed without a money mutation;
- leave a claimed test dispute pending, promote the deployment to a live key,
  and verify recovery quarantines that exact lease without a hold/case. Repeat
  with live evidence after switching to test and with the live gate disabled;
- duplicate and out-of-order events: one state transition;
- amount/currency/metadata mismatch: no credit and an actionable error/audit;
- Stripe retry after temporary API/DB failure: event is safely reprocessed;
- suppress checkout-success delivery after a paid test Checkout. After the
  attempt reaches the recovery age, run `deposit-credit-recovery`; verify one
  append-only retrieval observation, one wallet increment, one `DEPOSIT` row,
  and a terminal recovery aggregate. Redeliver the signed webhook and verify
  it proves the exact replay without a second credit;
- race a signed success delivery against the recovery job and verify both
  authorities terminalize while the wallet and ledger change exactly once;
- retrieve mismatched amount, currency, mode, metadata, PaymentIntent, or
  Charge test fixtures and verify quarantine plus Finance alert with no money;
- retrieve disputed and partially refunded Charge fixtures and verify they are
  rejected before persistence/credit; race a paid Checkout against local
  expiry and verify the exact paid authority credits the `EXPIRED` attempt;
- force duplicate-key collisions independently on session reference,
  PaymentIntent, wallet, amount, and currency: only an exact ledger plus linked
  `DepositAttempt` replay is accepted; every mismatch rolls back the wallet,
  quarantines the inbox row, and alerts Finance/Super Admin;
- after the original credit, move the attempt through each
  wallet-credit-backed derivative state—`PARTIALLY_REFUNDED`, `REFUNDED`,
  `DISPUTED`, and `CHARGEBACK`—and redeliver/reconcile the original paid event.
  Each state must preserve the one original wallet credit/`DEPOSIT` identity
  and must not be misclassified as an uncredited or missing deposit;
- dispute opened: one durable case, one owned hold, USD whole-cent
  amount/hold/exposure values, and structured shortfall; non-USD and sub-cent
  evidence must roll back;
- deliberately omit event terminalization after writing the wallet hold, case,
  and deposit projection; the deferred role-link check must roll back all
  three. A designated processed event cannot later be quarantined independently;
- redeliver a signature-valid conflicting envelope twice with the same
  provider event ID as a designated opened/resolved event. Both deliveries
  must return 2xx, the canonical event must remain `PROCESSED` with the exact
  role link, and exactly one identity-conflict audit plus one alert per
  Finance/Super Admin user must exist;
- duplicate/concurrent open events: one case and hold under real PostgreSQL
  uniqueness constraints;
- won/lost: one mutually exclusive terminal resolution;
- close-before-open: a complete verified event creates one correct terminal
  case; won-then-lost, lost-then-won, unsupported state, incomplete evidence,
  amount mismatch, and currency mismatch produce no incorrect money movement
  and remain retryable/quarantined;
- multiple or partial disputes for one payment remain independently traceable;
- processed dispute inbox rows without a matching case/hold fail
  reconciliation.
- leave dispute events stale/failed and verify the five-minute
  `payment-dispute-inbox` task retries them; deterministic contradictions and
  exhausted retries become critical quarantine drift.

Use only Stripe's published test cards. Never type a real card into test mode.

## 6. Publisher payout test matrix

1. Publisher clicks **Connect Stripe** and completes Stripe-hosted onboarding.
2. Refresh status; verify `ENABLED`, manual payout schedule, and one provider-
   managed payout method with no raw bank details in GuestPost.
   - race publisher refresh with the same signed `account.updated`; verify one
     managed method exists and both audited syncs converge;
   - deactivate the method with no nonterminal withdrawal, then refresh and
     redeliver `account.updated`; neither may silently reactivate it;
   - explicitly reactivate it as the current publisher owner only while the
     connected account is active, fully enabled, manually scheduled, and USD;
     restricted/deleted/non-USD accounts must fail closed;
   - race reactivation/deactivation, a new withdrawal, and an external-call
     claim; verify the documented ProviderAccount/Method lock order, one
     consistent winner, and no withdrawal bound to an inactive/unready route.
3. Request withdrawal; confirm gross, USD 0.00 fee, net, public reference, and
   settlement/order allocation details.
4. Request the publisher's full available balance; Finance approval succeeds
   after the configured hold because it proves the existing allocation rather
   than checking available funds again.
5. Execute with `stripe_connect`; verify distinct `tr_...` and `po_...` IDs.
6. Confirm the withdrawal stays PROCESSING for pending/in-transit Payout and
   completes only after `payout.paid` or equivalent provider retrieval.
7. Force failure after Transfer and before Payout; resume with the same bank-
   payout idempotency key and verify no second Transfer.
8. Force bank-payout failure; verify recovery-required state and no balance
   restoration. Cancel/reverse through the audited Finance path.
9. Replay webhooks and race webhook vs poller; lifetime-paid increments once.
10. Check the Stripe/bank test statement wording and retain the durable public
    reference even if a downstream display truncates it.
11. Crash after the execution reaches `CREATED` and
    `DESTINATION_VALIDATED`, before a provider claim. Finance Cancel must prove
    no provider IDs or `PayoutExecutionClaim` rows exist, persist typed
    `PRE_PROVIDER_ABORT`, and
    atomically return the reserved withdrawal to `APPROVED`. Race that action
    against a send claim and prove only one wins before provider I/O.
12. Attempt cancellation after `PROVIDER_SEND_CLAIMED` but before a provider ID
    and during the Transfer-to-Payout handoff; both must fail closed. After a
    provider-evidenced recovery state, cancel must cancel the Payout (when
    possible), reverse the Transfer, and only then return the withdrawal to an
    executable state.
13. Attempt Finance Mark Paid before execution and during Wise/Stripe
    processing; both must fail without changing withdrawal, execution,
    lifetime-paid, allocation, or audit provenance.
14. If a manual route is enabled, prove that only its existing PROCESSING
    execution can complete and that immutable payment evidence and
    maker-checker policy are enforced.
15. Crash once after each durable claim but before the Stripe call, and once
    after Stripe accepts but before local response persistence. Before 15
    minutes, recovery must be rejected as leased. After 15 minutes, **Recover
    claim** must send the exact original Transfer/Payout idempotency key and
    converge on the same `tr_...`/`po_...` object, including with
    `PAYOUT_EXECUTION_ENABLED=false`. Verify recovery only advances
    `PayoutExecutionClaim.lastClaimedAt`; it does not replace the first claim
    time, actor, key, fingerprint, or row.
16. Verify normalized claim authority at the database boundary:
    - one `PROVIDER_SEND` claim owns the Transfer key and one
      `BANK_PAYOUT_SEND` claim owns the derived bank-Payout key;
    - claimed stages and their claim rows commit together;
    - claim deletion, identity mutation, duplicate call-family insertion,
      non-monotonic lease updates, and a claimed execution with no claim row are
      rejected;
    - changing the execution key and claim fingerprint together is rejected;
    - adding `providerMetadata.externalClaims` is rejected and no JSON field or
      audit row is accepted as send authority.
17. Age a claim beyond 23 hours. Verify it moves to `*_CLAIM_EXPIRED`, creates
    Finance/Super Admin alerts, appears as critical reconciliation drift, and
    offers no blind Retry/Recover action. Resolve only by Stripe lookup and a
    documented Finance decision.
18. Deliver a signed `payout.paid` with the correct `po_...` but wrong Connect
    `account`, and a signed `transfer.updated` carrying paid status. Both must
    quarantine without changing liability. Deliver a late `payout.failed`
    after completion; it must alert without auto-reopening or decrementing
    `lifetimePaid`.
19. Exercise all three automated completion inputs: paid Payout create
    response, authenticated status poll, and signed `payout.paid`. Each must
    carry the persisted `po_...`, exact positive Stripe `amount` minor units,
    uppercase currency matching `destinationAmount`/`destinationCurrency`, and
    the immutable connected account. Omit or alter each fact independently and
    verify completion fails closed; webhook mismatches become durable
    quarantine evidence with Finance/Super Admin alerts.
20. Prove maker-checker boundaries: the approver cannot initiate the execution
    or own its first `PROVIDER_SEND` claim. For an enabled manual route, the
    completion checker must differ from the publisher requester, approver, and
    execution initiator. Each denial must preserve all balances, allocations,
    execution state, and completion provenance.

## 7. Closed-loop wallet gate

Verify the former customer wallet-withdrawal route is unavailable and cannot
debit a wallet through either HTTP or direct service use. No API-client method
may represent internal balance reduction as a successful external cash-out.

The legacy `scripts/provider-validation.ts` command is intentionally retired:
it created payout fixtures directly and bypassed these invariants. Use the
disposable PostgreSQL financial suites and this signed staging procedure.

## 8. Daily controls during test rollout

- Run `GET /api/v1/admin/reconciliation` with Finance/Super Admin access.
- Compare successful deposits to DEPOSIT ledger rows and Stripe payment objects.
- Compare processing/completed withdrawals to both Transfer and Payout objects.
- Investigate every recovery-required execution before further payout tests.
- Keep test per-transaction and daily limits small.

## 9. Kill switch and recovery

Set `PAYOUT_EXECUTION_ENABLED=false` to stop every new payout send. Use
`STRIPE_DEPOSITS_ENABLED=false` and/or `STRIPE_CONNECT_ENABLED=false` for the
direction-specific Stripe gates, then restart the API. Do not delete keys or
webhook secrets or change the active environment's test/live gate: verified
inbound events, status polling, safe cancellation/reversal, disputes, and
reconciliation must continue for money already in flight.

Never retry an ambiguous provider send by creating a new idempotency key. Find
the original Stripe object first. The only automatic exception is the bounded
15-minute-to-23-hour claimed-send recovery, which repeats the exact immutable
key after locked route validation. Never restore a publisher balance while a
Transfer/Payout may still hold or deliver the funds.

## 10. Live-mode gate

Live mode remains blocked by `STRIPE_LIVE_MODE_ENABLED=false`. Enabling it needs
legal/entity approval, Stripe production activation, production webhooks and
rotated live secrets, successful sandbox evidence, external-account/cash-
liability reconciliation, transaction/daily limits, alerts, rollback plan, and
two-person approval. Change the gate in a separate reviewed release window.
