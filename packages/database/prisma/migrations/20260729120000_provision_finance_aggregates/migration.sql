-- Financial aggregate rows are provisioned with their owning domain object.
-- Read endpoints must never create accounting state. Backfill only owners with
-- no financial history; a missing balance beside history is corruption that
-- requires reconciliation, not a safe zero-row assumption.

-- Prisma 7 does not wrap migrations in a transaction. Keep the corruption
-- preflight and both backfills atomic.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Freeze every parent, aggregate, and history relation read below before the
-- preflight takes its snapshot. Without this barrier, READ COMMITTED could let
-- a financial-history insert commit between the DO block and the zero-row
-- backfill. Keep this list alphabetic so future history sources have one stable
-- lock order. SHARE blocks concurrent INSERT/UPDATE/DELETE (ROW EXCLUSIVE) but
-- permits reads; this transaction may still perform its own aggregate inserts.
LOCK TABLE
  "DepositAttempt",
  "Membership",
  "Order",
  "OrderCancellationRequest",
  "Organization",
  "PlatformRevenue",
  "Publisher",
  "PublisherBalance",
  "Settlement",
  "Transaction",
  "Wallet",
  "Withdrawal"
IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Publisher" p
    LEFT JOIN "PublisherBalance" pb ON pb."publisherId" = p."id"
    WHERE pb."id" IS NULL
      AND (
        EXISTS (SELECT 1 FROM "Settlement" s WHERE s."publisherId" = p."id")
        OR EXISTS (SELECT 1 FROM "Withdrawal" w WHERE w."publisherId" = p."id")
        OR EXISTS (SELECT 1 FROM "Transaction" t WHERE t."publisherId" = p."id")
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'finance aggregate preflight failed: publisher history exists without PublisherBalance';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Organization" o
    LEFT JOIN "Wallet" organization_wallet
      ON organization_wallet."organizationId" = o."id"
    WHERE organization_wallet."id" IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM "DepositAttempt" deposit
          WHERE deposit."organizationId" = o."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "Order" customer_order
          WHERE customer_order."organizationId" = o."id"
            AND (
              customer_order."paymentStatus" <> 'PENDING'
              OR customer_order.status NOT IN ('DRAFT', 'PENDING_PAYMENT')
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "Order" customer_order
          JOIN "Transaction" ledger
            ON ledger."orderId" = customer_order."id"
          WHERE customer_order."organizationId" = o."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "Order" customer_order
          JOIN "Settlement" settlement
            ON settlement."orderId" = customer_order."id"
          WHERE customer_order."organizationId" = o."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "Order" customer_order
          JOIN "PlatformRevenue" revenue
            ON revenue."orderId" = customer_order."id"
          WHERE customer_order."organizationId" = o."id"
        )
        OR EXISTS (
          SELECT 1
          FROM "Order" customer_order
          JOIN "OrderCancellationRequest" cancellation
            ON cancellation."orderId" = customer_order."id"
          WHERE customer_order."organizationId" = o."id"
            AND cancellation."refundTransactionId" IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM "Membership" membership
          JOIN "Wallet" personal_wallet
            ON personal_wallet."userId" = membership."userId"
           AND personal_wallet."organizationId" IS NULL
          WHERE membership."organizationId" = o."id"
            AND membership.status = 'ACTIVE'
            AND (
              personal_wallet."availableBalance" <> 0
              OR personal_wallet."reservedBalance" <> 0
              OR EXISTS (
                SELECT 1
                FROM "Transaction" personal_ledger
                WHERE personal_ledger."walletId" = personal_wallet."id"
              )
              OR EXISTS (
                SELECT 1
                FROM "DepositAttempt" personal_deposit
                WHERE personal_deposit."walletId" = personal_wallet."id"
              )
            )
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'finance aggregate preflight failed: organization history exists without Wallet';
  END IF;
END
$$;

INSERT INTO "PublisherBalance" ("id", "publisherId", "updatedAt")
SELECT
  'pb_backfill_' || md5(p."id"),
  p."id",
  CURRENT_TIMESTAMP
FROM "Publisher" p
LEFT JOIN "PublisherBalance" pb ON pb."publisherId" = p."id"
WHERE pb."id" IS NULL
ON CONFLICT ("publisherId") DO NOTHING;

INSERT INTO "Wallet" ("id", "organizationId", "updatedAt")
SELECT
  'wallet_backfill_' || md5(o."id"),
  o."id",
  CURRENT_TIMESTAMP
FROM "Organization" o
LEFT JOIN "Wallet" w ON w."organizationId" = o."id"
WHERE w."id" IS NULL
ON CONFLICT ("organizationId") DO NOTHING;

COMMIT;
