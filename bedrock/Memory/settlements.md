---
note_type: domain-memory
domain: settlements
project: guestpost-platform
updated: 2026-08-15
---

# Settlements

## Snapshot trio (Phase 6 — reporting accuracy)

`Settlement` and `PlatformRevenue` each carry FIVE additional read-only columns frozen at creation time:

| Column | Source |
|---|---|
| `listingServiceId` | from `Order.listingServiceId` (FK SET NULL on listing-service drop) |
| `serviceType` | from the `ListingService` row's `serviceType` |
| `ownerType` | from the `Website.ownershipType` AT CREATION (PUBLISHER / PLATFORM) |
| `fulfillmentChannel` | from `Order.fulfillmentChannel` snapshot |
| `unitPrice` | per-service price (`ListingService.price`) at creation; distinct from `grossAmount` which is the full order amount |

These are NEVER updated after creation. Historical reports + refund clawback chains read them rather than re-derive from the live (mutable) listing.

Backfill: `scripts/backfill-settlement-snapshots.ts` covered 60/60 historical Settlement rows + 0 PlatformRevenue rows (no platform orders existed yet). Idempotent — only touches rows where `listingServiceId IS NULL`. Script removed after completion.

## Dual-Approval System

Both **customer** AND **admin** must approve before funds are released. Dispute blocks release.

### Platform Fee

20% platform fee captured at settlement creation via fee-by-subtraction (`splitPlatformFee`).

### Tier-Based Review Windows

- **NEW**: 30 days
- **TRUSTED**: 14 days
- **VERIFIED**: 7 days

### Auto-Approval

`SettlementAutoApproveService` sweeps periodically (interval-based, status-guarded). Admin approval still always required.

### Other Rules

- `confirmDelivery`/settlement atomically handled in single transaction
- `DEBT_REPAYMENT` transaction type for clawback scenarios
- `PlatformRevenue.reversedAt` for refund tracking instead of delete
- Reconciliation endpoint verifies settlement integrity

Settlement automation is fail-closed on current risk evidence. Missing or NEW
publisher tier, large/invalid order amount, missing/invalid customer history,
or any durable chargeback history forces manual review independently of the
global auto-release switch. Settlement creation loads organization/customer
history inside its locked transaction, and auto-release reloads the same
evidence after locking the Order so a later risk fact cannot rely on the older
snapshot.

## Confirmed delivery-fraud deny evidence

`DeliveryFraudFinding(outcome=CONFIRMED_FRAUD)` is an immutable operational
decision, not a settlement or refund record. It deliberately retains the
matching database-maintained `DeliveryFraudHold`. Settlement creation, manual
or automatic approval, release, and platform-revenue recognition all re-read
current holds under the Order fence and fail closed while that row exists.

The finding must link a cancellation review for the same Order. Operations or
Super Admin can recommend only a full refund with final responsibility;
Finance or Super Admin invokes the canonical refund primitive in a separate
money command. This is not actor-independent maker-checker because Super Admin
can currently authorize both commands. A
finding-linked case progresses only to `PENDING_FINANCE` and then `APPROVED`.
PostgreSQL rejects terminal diversion, incomplete Finance handoff, mismatched
refund amount/currency/order/responsibility, later cancellation rewrite, and
update/delete/truncate of the linked approved REFUND ledger row. Compensation
or correction uses new canonical evidence and never changes the permanent hold
or rewrites the original financial decision.

Force cancellation and dispute refund are blocked under the Order lock while a
finding exists. A deferred Order constraint validates the final transaction
state: `CANCELLED`/`COMPLETED` are forbidden, and `REFUNDED` requires every
linked case to contain complete approved Finance/refund evidence. This is the
alternate-writer and direct-SQL backstop for the application guards.

## Key Models

- `Settlement` — header with status, amounts, tier
- `SettlementApproval` — approval record with type (CUSTOMER / ADMIN)
- `SettlementApprovalType` enum

## Key Files

- `apps/api/src/modules/settlements/`
