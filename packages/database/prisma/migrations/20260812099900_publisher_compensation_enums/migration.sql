-- PostgreSQL makes values added to an existing enum usable only after the
-- adding transaction commits. Keep these changes separate from the tables,
-- constraints, and triggers that reference the new financial evidence types.

ALTER TYPE public."TransactionType"
  ADD VALUE IF NOT EXISTS 'PUBLISHER_COMPENSATION' BEFORE 'DEBT_REPAYMENT';

ALTER TYPE public."OrderEventType"
  ADD VALUE IF NOT EXISTS 'PUBLISHER_COMPENSATION_RECORDED';
