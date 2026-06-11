---
note_type: domain-memory
domain: settlements
project: guestpost-platform
updated: 2026-06-11
---

# Settlements

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
