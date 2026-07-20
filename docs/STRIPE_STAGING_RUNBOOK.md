# Stripe staging rollout runbook

This runbook is for Stripe test mode on the deployed staging/dev environment.
It does not authorize live money.

## 1. Preconditions

- The migration `20260720090000_stripe_first_finance_groundwork` is deployed.
- API, worker, portal, and publisher app use the same release.
- Exactly one current worker fleet is running.
- The Stripe account/platform country and intended connected-account countries
  are legally and technically supported. Test mode success is not proof that a
  Bangladesh or other production entity can activate the same live product.
- Finance and Security owners are named for the test window.

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
PAYOUT_LEGACY_METHODS_ENABLED=false
NEXT_PUBLIC_PORTAL_URL=https://app.guestpost.pro.bd
NEXT_PUBLIC_PUBLISHER_URL=https://publisher.guestpost.pro.bd
```

The API must fail at boot if an enabled feature lacks its key/webhook secret.
Never put `sk_*`, `rk_*`, or `whsec_*` values in browser-exposed environment
variables, logs, screenshots, tickets, or documentation.

The staging restricted key needs only the Stripe resources used by this
release: Checkout Sessions (write/read), Accounts and Account Links
(write/read), Balance Settings (write/read), Transfers and Transfer Reversals
(write/read), and Payouts (write/read). Deny every unrelated resource. Use a
separate key per environment and rotate it immediately if it is exposed.

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
2. `https://api.guestpost.pro.bd/api/v1/payout-webhooks/stripe_connect`
   - listen to events on **your account**;
   - `transfer.created`
   - `transfer.canceled`
   - `transfer.updated`
   - `transfer.reversed`
3. `https://api.guestpost.pro.bd/api/v1/payout-webhooks/stripe_connect`
   - listen to events on **connected accounts**;
   - `account.updated`
   - `payout.created`
   - `payout.updated`
   - `payout.paid`
   - `payout.failed`
   - `payout.canceled`

Copy each destination's signing secret to its matching environment variable.
The two payout destinations intentionally share a URL; the API verifies either
secret while keeping them independently rotatable. Do not reuse a secret from
a different destination or mode.

## 4. Deployment order

1. Back up the database and record release SHA/image.
2. Pause new financial test actions.
3. Deploy the additive migration.
4. Deploy API and the matching worker/app release.
5. Set test keys/secrets with both feature flags still false; restart and check
   health.
6. Enable deposits; restart; run the deposit matrix below.
7. Enable Connect; restart; onboard one internal test publisher.
8. Run reconciliation. It must return no new critical drift before continuing.

## 5. Deposit test matrix

- successful card: one `DepositAttempt`, one DEPOSIT ledger row, one wallet
  credit, public reference shown, expected test descriptor recorded;
- browser refresh/back/duplicate click: no second session/credit for the same
  idempotency key;
- missing/reused-with-different-details idempotency key: request rejected;
- abandoned/expired Checkout: no credit;
- forged or wrong-mode webhook: HTTP 400, no state change;
- duplicate and out-of-order events: one state transition;
- amount/currency/metadata mismatch: no credit and an actionable error/audit;
- Stripe retry after temporary API/DB failure: event is safely reprocessed;
- dispute opened/won/lost: wallet hold and deposit state remain consistent.

Use only Stripe's published test cards. Never type a real card into test mode.

## 6. Publisher payout test matrix

1. Publisher clicks **Connect Stripe** and completes Stripe-hosted onboarding.
2. Refresh status; verify `ENABLED`, manual payout schedule, and one provider-
   managed payout method with no raw bank details in GuestPost.
3. Request withdrawal; confirm gross, USD 0.00 fee, net, public reference, and
   settlement/order allocation details.
4. Finance approves after the configured hold.
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
11. Attempt cancellation before a provider ID is recorded and during the
    Transfer-to-Payout handoff; both must fail closed. After recovery state,
    cancel must cancel the Payout (when possible), reverse the Transfer, and
    only then return the withdrawal to an executable state.

## 7. Daily controls during test rollout

- Run `GET /api/v1/admin/reconciliation` with Finance/Super Admin access.
- Compare successful deposits to DEPOSIT ledger rows and Stripe payment objects.
- Compare processing/completed withdrawals to both Transfer and Payout objects.
- Investigate every recovery-required execution before further payout tests.
- Keep test per-transaction and daily limits small.

## 8. Kill switch and recovery

Set `STRIPE_DEPOSITS_ENABLED=false` and/or `STRIPE_CONNECT_ENABLED=false` to
stop new sessions/transfers/payouts, then restart the API. Do not delete keys or
webhook secrets or change the active environment's test/live gate: verified
inbound events, status polling, safe cancellation/reversal, disputes, and
reconciliation must continue for money already in flight.

Never retry an ambiguous provider send by creating a new idempotency key. Find
the original Stripe object first. Never restore a publisher balance while a
Transfer/Payout may still hold or deliver the funds.

## 9. Live-mode gate

Live mode remains blocked by `STRIPE_LIVE_MODE_ENABLED=false`. Enabling it needs
legal/entity approval, Stripe production activation, production webhooks and
rotated live secrets, successful sandbox evidence, external-account/cash-
liability reconciliation, transaction/daily limits, alerts, rollback plan, and
two-person approval. Change the gate in a separate reviewed release window.
