# Provider Integration Validation Report — 2026-06-12

Method: `scripts/provider-validation.ts` fires **genuinely signed** webhooks at the running platform and asserts every money transition end-to-end: API signature verification → BullMQ (HMAC-signed jobs) → worker → version-guarded DB transitions → reconciliation referee. Result: **30/30 PASS**.

Signature authenticity:
- **Stripe**: payloads signed with the real `STRIPE_WEBHOOK_SECRET` / `STRIPE_PAYOUT_WEBHOOK_SECRET` — byte-identical to production verification (`t=...,v1=HMAC-SHA256` and `constructEvent`). Project key verified live against api.stripe.com (`livemode: false`, balance endpoint 200).
- **Wise**: payloads signed RSA-SHA256 with a dedicated validation keypair; API configured with its public half (`WISE_WEBHOOK_PUBLIC_KEY`) — the exact production verification code path runs (`createVerify("RSA-SHA256")`, base64 header, fail-closed).

## Stripe matrix

| Case | Result | Evidence |
|---|---|---|
| Deposit webhook → wallet credit | PASS | +$123.45 exact (non-whole-dollar), ledger row w/ `providerRef = payment_intent` |
| Duplicate deposit delivery | PASS | 200 (replay-safe), zero double-credit, exactly 1 ledger row |
| Tampered signature | PASS | 400, nothing queued |
| `charge.dispute.created` → hold | PASS | $50 moved available→reserved |
| Duplicate dispute webhook | PASS | no double-hold |
| Dispute WON → release | PASS | hold returned to available, balances exact |
| Dispute LOST → permanent debit | PASS | reserved consumed, `CHARGEBACK` ledger row −$50 |
| Payout `transfer.updated status=paid` | PASS | worker completed execution + withdrawal |
| Money conservation referee | PASS | reconciliation `ok: true` after all events |

## Wise matrix

| Case | Result | Evidence |
|---|---|---|
| Tampered signature | PASS | 401, never queued |
| Non-terminal state (`processing`) | PASS | accepted, no transition |
| `completed` → completion | PASS | execution + withdrawal COMPLETED via worker, lifetimePaid +$25 exactly once |
| Replayed `completed` (duplicate/lost-webhook redelivery) | PASS | no-op, no double-pay |
| `cancelled` → failure | PASS | execution + withdrawal FAILED, $0 paid |
| FAILED recovery | PASS | admin reverse → REVERSED, funds restored (audited) |
| Lost webhook fallback | by design | 10-min status poller transitions PROCESSING executions via the same shared status maps (unit-tested; poller needs `WISE_API_KEY` and skips—never assumes—without it) |
| Reconciliation referee | PASS | `ok: true` |

## Not covered (requires real provider credentials — pre-launch checklist)

1. **Wise sandbox API**: recipient creation, transfer creation, real webhook subscription. No `WISE_API_KEY` configured. The adapter (idempotent `customerTransactionId`, profile/quote/transfer flow) is unit-tested; first real execution must be a $1 sandbox transfer with the checklist above.
2. **Stripe Connect transfers**: requires a connected account (KYC onboarding flow not built). `manual` payout rail is the beta path; `stripe_connect` adapter is unit-tested + webhook/poller validated above.
3. Real provider→platform network delivery (DNS/TLS/firewall) — needs a public URL; everything from the HTTP request inward is validated.

## Incident found & fixed during validation

Five stale worker processes were consuming the payout queue (every restart this session leaked one — wrong pkill pattern). Oldest ran yesterday's pre-normalizer build and swallowed two webhook jobs. Killed; single worker verified; re-run 30/30. **Production lesson encoded in runbook: exactly-one-worker supervision (pm2) is mandatory; multiple workers are safe only when all run current code.**
