---
note_type: domain-memory
domain: settlements
project: guestpost-platform
updated: 2026-06-14
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

## Key Models

- `Settlement` — header with status, amounts, tier
- `SettlementApproval` — approval record with type (CUSTOMER / ADMIN)
- `SettlementApprovalType` enum

## Key Files

- `apps/api/src/modules/settlements/`
