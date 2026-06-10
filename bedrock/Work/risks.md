---
note_type: risks
project: guestpost-platform
updated: 2026-06-11
---

# Risks

Known project risks. Source: full architecture/security/financial review 2026-06-11.
Status updated after hardening batch 9 (same day) — most blockers FIXED in working tree.

## Fixed in batch 9 (2026-06-11, migrations 20260611000000 + 20260611010000)

- FIXED: updateUserRole oldest-publisher privesc — now creates a fresh Publisher
- FIXED: float money math — `splitPlatformFee` Decimal helper (fee-by-subtraction); Stripe deposit exact cents division
- FIXED: first-item settlement bug — one-website-per-order invariant enforced in createOrder/addOrderItem
- FIXED: clawback dead-end — PublisherBalance.debtBalance; partial clawback + debt netted at release (DEBT_REPAYMENT tx)
- FIXED: forceCancelOrder strands PAID money — delegates to RefundService
- FIXED: AuditLog/Notification SYSTEM-org FK loss — columns nullable, sentinels removed, financial audits write inside tx
- FIXED: PlatformRevenue delete-on-refund — reversedAt column instead
- FIXED: withdrawal tier holds decorative — availableAt enforced at approve; idempotency via @@unique([publisherId, idempotencyKey]) not PK
- FIXED: withdrawal ledger gap — WITHDRAWAL tx at request, WITHDRAWAL_REVERSAL at reject
- FIXED: dispute RESTORE hardcoded PUBLISHED — previousStatus stored; REFUND resolution idempotent
- FIXED: confirmDelivery/settlement non-atomic — single transaction
- FIXED: unpaginated listOrders/listPublisherOrders/listReports
- FIXED: silent price-drift recharge — 409 with drifted items, prices synced outside tx
- FIXED: reviewEndsAt decorative — SettlementAutoApproveService sweeps (interval, status-guarded); admin approval still required
- FIXED: chargebacks invisible — charge.dispute.created handler + staff notifications
- FIXED: review gate on unreachable COMPLETED — now COMPLETED/SETTLED/DELIVERED
- FIXED: domain dedupe — Website.domain normalized column + backfill, checks in websites/admin create+update
- FIXED: publisher fulfillment transitions not status-guarded
- ADDED: PayoutMethod model + CRUD endpoints (bank details storage; real rail still pending)
- ADDED: GET /admin/reconciliation — wallet/publisher balance vs ledger, stuck DELIVERED orders
- REPAIRED: dev DB drift (missing CampaignStatus/ContentOrderStatus/RevisionStatus/WebsiteOwnershipType enums, Website.ownershipType, PlatformRevenue table) — migration 20260611010000 converts statuses in place with USING casts

## Still open

- Full double-entry ledger with escrow/revenue accounts — reconciliation service is the interim guard; legacy withdrawals (pre-batch-9) lack WITHDRAWAL tx rows and will show as expected publisher drift
- Real payout rail (Stripe Connect / Wise) — PayoutMethod stores details, transfers still manual mark-paid
- Stripe refund-to-card / chargeback fund handling — refunds are wallet-credit only
- Marketplace search ILIKE — fine to ~50k listings, then pg_trgm/FTS
- Website ownership verification (DNS TXT) — schema/endpoint work pending; manual admin review only
- MarketplaceListingView/Click growth — needs rollup + prune
- Fulfillment service merge (publisher/operations near-duplicates, now guard-parity at least)
- Order deadlines/SLA enforcement (no timeout on SUBMITTED orders)
- Agency features: invoicing, sub-accounts, NET terms
- E2E + concurrency test suite against real Postgres (unit coverage now exists for refund/withdrawal/fee paths)
