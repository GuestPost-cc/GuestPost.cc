-- The enum value is isolated so PostgreSQL can commit it before later DDL
-- uses it in constraints and triggers.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REFUND_REVERSAL';
