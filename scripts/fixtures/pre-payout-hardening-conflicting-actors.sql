-- Negative populated-upgrade fixture. A single withdrawal/action may have
-- repeated audit rows from retries, but every row must identify the same
-- actor. This deliberately introduces a second actor so the payout migration
-- must abort before writing any schema or backfill state.

\set ON_ERROR_STOP on

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
) VALUES (
  'migration-rehearsal-conflicting-requester',
  'WITHDRAWAL_REQUESTED',
  'Withdrawal',
  'migration-rehearsal-withdrawal-completed',
  'migration-rehearsal-finance',
  'migration-rehearsal-org',
  CURRENT_TIMESTAMP - INTERVAL '10 days'
);
