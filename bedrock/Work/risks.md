---
note_type: risks
project: guestpost-platform
updated: 2026-06-11
---

# Risks

Known project risks. Source: full architecture/security/financial review 2026-06-11.

## Open risks (launch blockers)

- Risk: `updateUserRole` publisher path attaches user as PUBLISHER_OWNER to the oldest Publisher in DB (admin.service.ts:124)
  - Why it matters: privilege escalation — admin promotion hands over an unrelated publisher's listings/balance/withdrawals
  - Mitigation: require explicit publisherId or create fresh Publisher
- Risk: single-entry bookkeeping; no escrow/revenue ledger accounts; SETTLEMENT_RELEASE/capture/refund transactions have no offsetting entries
  - Why it matters: money conservation unprovable; reconciliation drift undetectable; accounting audit fails
  - Mitigation: double-entry ledger (wallet/escrow/payable/revenue/external accounts) + nightly reconciliation; medium-term
- Risk: float money math — `Number(amount) * feeFraction` in settlements.service.ts:34, order-review.service.ts:184,206; Stripe deposit `Math.round(cents/100)` rounds to whole dollars (billing.service.ts:97)
  - Why it matters: penny drift, fee+payout != gross, deposits mint/destroy money
  - Mitigation: Decimal end-to-end, fee by subtraction, store cents
- Risk: order-level settlement pays first item's publisher entire order amount (settlements.service.ts:26 findFirst)
  - Why it matters: multi-website order = wrong publisher paid everything
  - Mitigation: enforce one-website-per-order invariant now; item-level settlements long-term
- Risk: refund clawback of RELEASED settlement hits CHECK >= 0 if publisher already withdrew — refund transaction aborts
  - Why it matters: customer refund becomes impossible; stuck disputes
  - Mitigation: PublisherDebt model, net against future settlements
- Risk: forceCancelOrder cancels PAID orders without refund; skips RELEASED settlements (admin.service.ts:297)
  - Why it matters: customer money stranded, publisher keeps payout on cancelled order
  - Mitigation: refuse PAID or delegate to RefundService
- Risk: AuditLog.organizationId FK + "SYSTEM"/"system" string values; audit.service.ts swallows create errors with warn
  - Why it matters: staff-role changes, platform-website ops, webhook deposits may silently lose audit records
  - Mitigation: seed SYSTEM org or nullable column; audit writes inside tx for financial ops
- Risk: no payout rail — Withdrawal.method is a bare string, no PayoutMethod/bank details/Stripe Connect
  - Why it matters: cannot actually pay publishers
  - Mitigation: PayoutMethod entity + Stripe Connect or Wise, pre-launch

## Open risks (non-blocking)

- Risk: tier withdrawal holds (NEW=30d etc.) computed but never enforced; reviewEndsAt set but consumed by nothing (no auto-release worker)
- Risk: dispute RESTORE/REJECT restores hardcoded PUBLISHED regardless of pre-dispute status; REFUND resolution non-idempotent (refund commits, dispute update fails -> unresolvable)
- Risk: confirmDelivery -> settlement creation non-atomic; DELIVERED orders without settlement possible, undetected
- Risk: listOrders/listPublisherOrders/listReports unpaginated with heavy includes — first scale failure
- Risk: submitPayment silently re-charges drifted listing price without consent (order-payment.service.ts:41)
- Risk: no website ownership verification; URL unique bypassed by www/slash variants; reviews default APPROVED without purchase
- Risk: publisher withdrawals create no Transaction row; PlatformRevenue deleted on refund (should be reversal rows)
- Risk: only 5 spec files; zero settlement/refund/concurrency tests
- Risk: no Stripe charge.dispute.created handler (chargebacks invisible)
- Risk: settlement throughput — every settlement needs 2 manual approvals + every withdrawal 2 staff clicks
-
