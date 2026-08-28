-- Adds the order-event type used by the cancellation-case stall sweep.
-- Single statement: ALTER TYPE ... ADD VALUE must not share a transaction
-- with statements that use the new value (PostgreSQL restriction), and the
-- repo migration discipline keeps enum additions in dedicated transactions.

ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'CANCELLATION_STALL_REMINDER';
