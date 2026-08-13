-- Post-publication refunds must carry an explicit publisher-pay disposition.
-- NONE is first-class evidence; absence is never interpreted as a decision.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
-- DDL below intentionally creates application objects in public. Functions
-- still pin pg_catalog first in their own execution-time search_path.
SET LOCAL search_path = public, pg_catalog, pg_temp;

LOCK TABLE
  public."Order",
  public."Publisher",
  public."PublisherBalance",
  public."Settlement",
  public."Transaction",
  public."User",
  public."Website",
  public."Withdrawal",
  public."WithdrawalAllocation"
IN SHARE ROW EXCLUSIVE MODE;

-- Carry-forward is a bounded legacy source. Re-establish parity before adding
-- the concurrency fence so an already-drifted balance cannot be normalized by
-- the first post-deploy writer.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."WithdrawalAllocation" allocation
    JOIN public."Withdrawal" withdrawal
      ON withdrawal."id" = allocation."withdrawalId"
    LEFT JOIN public."PublisherBalance" balance
      ON balance."publisherId" = withdrawal."publisherId"
    WHERE allocation."sourceType" = 'CARRY_FORWARD'
      AND (
        balance."publisherId" IS NULL
        OR balance."allocationCutoverAt" IS NULL
        OR balance."currency" IS DISTINCT FROM 'USD'
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'publisher compensation migration blocked: carry-forward evidence lacks a cut-over USD balance';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."PublisherBalance" balance
    LEFT JOIN public."Withdrawal" withdrawal
      ON withdrawal."publisherId" = balance."publisherId"
    LEFT JOIN public."WithdrawalAllocation" allocation
      ON allocation."withdrawalId" = withdrawal."id"
    GROUP BY
      balance."publisherId",
      balance."allocationCarryForward",
      balance."allocationCarryForwardUsed"
    HAVING balance."allocationCarryForwardUsed" IS DISTINCT FROM COALESCE(
      SUM(allocation."amount") FILTER (
        WHERE allocation."releasedAt" IS NULL
          AND allocation."sourceType" = 'CARRY_FORWARD'
      ),
      0
    )
      OR balance."allocationCarryForwardUsed" < 0
      OR balance."allocationCarryForwardUsed" > balance."allocationCarryForward"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'publisher compensation migration blocked: carry-forward allocation parity is invalid';
  END IF;
END;
$$;

CREATE TYPE "PublisherCompensationDisposition" AS ENUM ('NONE', 'EXACT_AMOUNT');

CREATE TABLE "PublisherCompensation" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "refundTransactionId" TEXT NOT NULL,
  "compensationTransactionId" TEXT,
  "debtRepaymentTransactionId" TEXT,
  "disposition" "PublisherCompensationDisposition" NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "responsibility" "CancellationResponsibility" NOT NULL,
  "reason" VARCHAR(2000) NOT NULL,
  "effectiveOrderStatus" VARCHAR(32) NOT NULL,
  "decidedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PublisherCompensation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PublisherCompensation_amount_shape_check" CHECK (
    "amount" >= 0
    AND "amount" * 100 = TRUNC("amount" * 100)
  ),
  CONSTRAINT "PublisherCompensation_currency_usd_check" CHECK ("currency" = 'USD'),
  CONSTRAINT "PublisherCompensation_reason_check" CHECK (
    LENGTH(BTRIM("reason")) BETWEEN 20 AND 2000
  ),
  CONSTRAINT "PublisherCompensation_status_check" CHECK (
    "effectiveOrderStatus" IN ('PUBLISHED', 'VERIFIED', 'DELIVERED', 'COMPLETED')
  ),
  CONSTRAINT "PublisherCompensation_disposition_check" CHECK (
    (
      "disposition" = 'NONE'
      AND "amount" = 0
      AND "compensationTransactionId" IS NULL
      AND "debtRepaymentTransactionId" IS NULL
    )
    OR (
      "disposition" = 'EXACT_AMOUNT'
      AND "amount" > 0
      AND "compensationTransactionId" IS NOT NULL
    )
  ),
  CONSTRAINT "PublisherCompensation_publisher_responsibility_check" CHECK (
    "responsibility" <> 'UNDETERMINED'
    AND ("responsibility" <> 'PUBLISHER' OR "disposition" = 'NONE')
  )
);

CREATE UNIQUE INDEX "PublisherCompensation_orderId_key"
  ON "PublisherCompensation"("orderId");
CREATE UNIQUE INDEX "PublisherCompensation_refundTransactionId_key"
  ON "PublisherCompensation"("refundTransactionId");
CREATE UNIQUE INDEX "PublisherCompensation_compensationTransactionId_key"
  ON "PublisherCompensation"("compensationTransactionId");
CREATE UNIQUE INDEX "PublisherCompensation_debtRepaymentTransactionId_key"
  ON "PublisherCompensation"("debtRepaymentTransactionId");
CREATE INDEX "PublisherCompensation_publisherId_createdAt_idx"
  ON "PublisherCompensation"("publisherId", "createdAt");
CREATE INDEX "PublisherCompensation_decidedByUserId_idx"
  ON "PublisherCompensation"("decidedByUserId");

ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_refundTransactionId_fkey"
  FOREIGN KEY ("refundTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_compensationTransactionId_fkey"
  FOREIGN KEY ("compensationTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_debtRepaymentTransactionId_fkey"
  FOREIGN KEY ("debtRepaymentTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherCompensation"
  ADD CONSTRAINT "PublisherCompensation_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "guard_publisher_compensation_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  order_row RECORD;
  refund_row RECORD;
  credit_row RECORD;
  debt_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation evidence is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation evidence is immutable';
  END IF;

  SELECT
    order_value."status"::TEXT AS status,
    order_value."paymentStatus"::TEXT AS payment_status,
    order_value."refundResponsibility"::TEXT AS responsibility,
    order_value."amount" AS amount,
    order_value."currency" AS currency,
    order_value."fulfillmentChannel"::TEXT AS fulfillment_channel,
    website."ownershipType"::TEXT AS ownership_type,
    COALESCE(settlement."publisherId", website."publisherId") AS publisher_id,
    COALESCE(settlement."publisherAmount", order_value."amount") AS maximum_publisher_amount
  INTO order_row
  FROM "Order" order_value
  LEFT JOIN "Website" website ON website."id" = order_value."websiteId"
  LEFT JOIN LATERAL (
    SELECT
      settlement_value."publisherId",
      settlement_value."publisherAmount"
    FROM "Settlement" settlement_value
    WHERE settlement_value."orderId" = order_value."id"
    ORDER BY settlement_value."createdAt" DESC, settlement_value."id" DESC
    LIMIT 1
  ) settlement ON TRUE
  WHERE order_value."id" = NEW."orderId"
  FOR SHARE OF order_value;

  IF NOT FOUND
    OR order_row.status IS DISTINCT FROM 'REFUNDED'
    OR order_row.payment_status IS DISTINCT FROM 'REFUNDED'
    OR order_row.responsibility IS DISTINCT FROM NEW."responsibility"::TEXT
    OR order_row.currency IS DISTINCT FROM NEW."currency"
    OR COALESCE(
      order_row.fulfillment_channel,
      CASE WHEN order_row.ownership_type = 'PLATFORM' THEN 'PLATFORM' ELSE 'PUBLISHER' END
    ) IS DISTINCT FROM 'PUBLISHER'
    OR order_row.publisher_id IS DISTINCT FROM NEW."publisherId"
    OR NEW."amount" > order_row.maximum_publisher_amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation does not match the terminal refunded publisher order';
  END IF;

  SELECT * INTO refund_row
  FROM "Transaction"
  WHERE "id" = NEW."refundTransactionId";
  IF NOT FOUND
    OR refund_row."type"::TEXT IS DISTINCT FROM 'REFUND'
    OR refund_row."orderId" IS DISTINCT FROM NEW."orderId"
    OR refund_row."currency" IS DISTINCT FROM NEW."currency"
    OR refund_row."amount" IS DISTINCT FROM order_row.amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation refund transaction evidence is invalid';
  END IF;

  IF NEW."compensationTransactionId" IS NOT NULL THEN
    SELECT * INTO credit_row
    FROM "Transaction"
    WHERE "id" = NEW."compensationTransactionId";
    IF NOT FOUND
      OR credit_row."type"::TEXT IS DISTINCT FROM 'PUBLISHER_COMPENSATION'
      OR credit_row."orderId" IS DISTINCT FROM NEW."orderId"
      OR credit_row."publisherId" IS DISTINCT FROM NEW."publisherId"
      OR credit_row."currency" IS DISTINCT FROM NEW."currency"
      OR credit_row."amount" IS DISTINCT FROM NEW."amount"
      OR credit_row."walletId" IS NOT NULL
      OR credit_row."settlementId" IS NOT NULL
      OR credit_row."provider" IS NOT NULL
      OR credit_row."providerRef" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Publisher compensation credit transaction evidence is invalid';
    END IF;
  END IF;

  IF NEW."debtRepaymentTransactionId" IS NOT NULL THEN
    SELECT * INTO debt_row
    FROM "Transaction"
    WHERE "id" = NEW."debtRepaymentTransactionId";
    IF NOT FOUND
      OR debt_row."type"::TEXT IS DISTINCT FROM 'DEBT_REPAYMENT'
      OR debt_row."orderId" IS DISTINCT FROM NEW."orderId"
      OR debt_row."publisherId" IS DISTINCT FROM NEW."publisherId"
      OR debt_row."currency" IS DISTINCT FROM NEW."currency"
      OR debt_row."amount" >= 0
      OR ABS(debt_row."amount") > NEW."amount"
      OR debt_row."walletId" IS NOT NULL
      OR debt_row."settlementId" IS NOT NULL
      OR debt_row."provider" IS NOT NULL
      OR debt_row."providerRef" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Publisher compensation debt-repayment evidence is invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PublisherCompensation_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PublisherCompensation"
FOR EACH ROW EXECUTE FUNCTION "guard_publisher_compensation_evidence"();

CREATE FUNCTION "guard_publisher_compensation_transaction_link"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate_id TEXT;
  candidate_type TEXT;
  linked_count BIGINT;
BEGIN
  -- Every transaction selected by immutable PublisherCompensation evidence is
  -- immutable too. Checking both OLD and NEW closes UPDATEs that change the
  -- transaction type/reference/identity (or its primary key via FK cascade)
  -- and would otherwise evade a guard that inspects only NEW.
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1
    FROM "PublisherCompensation" compensation
    WHERE compensation."refundTransactionId" IN (
        OLD."id",
        CASE WHEN TG_OP = 'UPDATE' THEN NEW."id" ELSE OLD."id" END
      )
      OR compensation."compensationTransactionId" IN (
        OLD."id",
        CASE WHEN TG_OP = 'UPDATE' THEN NEW."id" ELSE OLD."id" END
      )
      OR compensation."debtRepaymentTransactionId" IN (
        OLD."id",
        CASE WHEN TG_OP = 'UPDATE' THEN NEW."id" ELSE OLD."id" END
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation ledger evidence is immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."type"::TEXT = 'REFUND'
     AND NEW."type"::TEXT IS DISTINCT FROM 'REFUND'
     AND EXISTS (
       SELECT 1
       FROM "PublisherCompensation" compensation
       WHERE compensation."orderId" = OLD."orderId"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation refund evidence is immutable';
  END IF;

  candidate_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  candidate_type := CASE WHEN TG_OP = 'DELETE' THEN OLD."type"::TEXT ELSE NEW."type"::TEXT END;

  IF candidate_type = 'PUBLISHER_COMPENSATION' THEN
    SELECT COUNT(*) INTO linked_count
    FROM "PublisherCompensation"
    WHERE "compensationTransactionId" = candidate_id;
    IF linked_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Publisher compensation credit transaction requires one exact disposition';
    END IF;
  ELSIF candidate_type = 'DEBT_REPAYMENT'
    AND COALESCE(
      CASE WHEN TG_OP = 'DELETE' THEN OLD."reference" ELSE NEW."reference" END,
      ''
    ) LIKE 'publisher-compensation-debt:%' THEN
    SELECT COUNT(*) INTO linked_count
    FROM "PublisherCompensation"
    WHERE "debtRepaymentTransactionId" = candidate_id;
    IF linked_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Publisher compensation debt transaction requires one exact disposition';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Transaction_publisher_compensation_link_guard"
AFTER INSERT OR UPDATE OR DELETE ON "Transaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_publisher_compensation_transaction_link"();

-- Source allocations are spendable-liability evidence. Bind every new
-- provenance-backed allocation to the exact immutable ledger fact and parent
-- publisher. This closes the generic varchar sourceType escape hatch without
-- rewriting historical carry-forward allocations.
CREATE FUNCTION "guard_withdrawal_allocation_source_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_publisher_id TEXT;
  source_row RECORD;
  source_debt NUMERIC := 0;
  already_allocated NUMERIC := 0;
  carry_capacity NUMERIC := 0;
  carry_used NUMERIC := 0;
  carry_cutover_at TIMESTAMP;
  carry_currency TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  SELECT "publisherId"
  INTO parent_publisher_id
  FROM "Withdrawal"
  WHERE "id" = NEW."withdrawalId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Withdrawal allocation has no parent withdrawal';
  END IF;

  IF NEW."sourceType" = 'CARRY_FORWARD' THEN
    IF NEW."sourceTransactionId" IS NOT NULL
      OR NEW."settlementId" IS NOT NULL
      OR NEW."orderId" IS NOT NULL
      OR NEW."serviceType" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Carry-forward allocation cannot claim ledger provenance';
    END IF;

    -- PublisherBalance is the stable aggregate lock for legacy carry-forward.
    -- Every carry allocation takes it before reading capacity, so concurrent
    -- inserts cannot both spend the same remaining amount under READ COMMITTED.
    SELECT
      balance."allocationCarryForward",
      balance."allocationCarryForwardUsed",
      balance."allocationCutoverAt",
      balance."currency"
    INTO carry_capacity, carry_used, carry_cutover_at, carry_currency
    FROM "PublisherBalance" balance
    WHERE balance."publisherId" = parent_publisher_id
    FOR UPDATE OF balance;

    IF NOT FOUND
      OR carry_cutover_at IS NULL
      OR carry_currency IS DISTINCT FROM 'USD' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Carry-forward allocation requires a cut-over USD publisher balance';
    END IF;

    SELECT COALESCE(SUM(allocation."amount"), 0)
    INTO already_allocated
    FROM "WithdrawalAllocation" allocation
    JOIN "Withdrawal" withdrawal
      ON withdrawal."id" = allocation."withdrawalId"
    WHERE withdrawal."publisherId" = parent_publisher_id
      AND allocation."sourceType" = 'CARRY_FORWARD'
      AND allocation."releasedAt" IS NULL;

    IF carry_used IS DISTINCT FROM already_allocated
      OR already_allocated + NEW."amount" > carry_capacity THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Carry-forward allocation exceeds or contradicts publisher balance capacity';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."sourceType" NOT IN ('SETTLEMENT_RELEASE', 'PUBLISHER_COMPENSATION')
    OR NEW."sourceTransactionId" IS NULL
    OR NEW."orderId" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Withdrawal allocation source type or identity is unsupported';
  END IF;

  SELECT
    transaction_value."type"::TEXT AS type,
    transaction_value."publisherId" AS publisher_id,
    transaction_value."settlementId" AS settlement_id,
    transaction_value."orderId" AS order_id,
    transaction_value."currency" AS currency,
    transaction_value."amount" AS amount,
    settlement_value."serviceType" AS settlement_service_type,
    order_value."type" AS order_service_type
  INTO source_row
  FROM "Transaction" transaction_value
  LEFT JOIN "Settlement" settlement_value
    ON settlement_value."id" = transaction_value."settlementId"
  LEFT JOIN "Order" order_value
    ON order_value."id" = transaction_value."orderId"
  WHERE transaction_value."id" = NEW."sourceTransactionId"
  FOR UPDATE OF transaction_value;

  IF NOT FOUND
    OR source_row.publisher_id IS DISTINCT FROM parent_publisher_id
    OR source_row.order_id IS DISTINCT FROM NEW."orderId"
    OR source_row.currency IS DISTINCT FROM NEW."currency"
    OR source_row.amount <= 0
    OR NEW."amount" > source_row.amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Withdrawal allocation does not match its ledger source';
  END IF;

  IF NEW."sourceType" = 'SETTLEMENT_RELEASE' THEN
    IF source_row.type IS DISTINCT FROM 'SETTLEMENT_RELEASE'
      OR source_row.settlement_id IS NULL
      OR source_row.settlement_id IS DISTINCT FROM NEW."settlementId"
      OR source_row.settlement_service_type IS DISTINCT FROM NEW."serviceType" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Settlement-release allocation evidence is invalid';
    END IF;

    SELECT COALESCE(SUM(debt."amount"), 0)
    INTO source_debt
    FROM "Transaction" debt
    WHERE debt."type"::TEXT = 'DEBT_REPAYMENT'
      AND debt."settlementId" = source_row.settlement_id;
  ELSE
    IF source_row.type IS DISTINCT FROM 'PUBLISHER_COMPENSATION'
      OR source_row.settlement_id IS NOT NULL
      OR NEW."settlementId" IS NOT NULL
      OR source_row.order_service_type IS DISTINCT FROM NEW."serviceType" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Publisher-compensation allocation evidence is invalid';
    END IF;


    SELECT COALESCE(debt."amount", 0)
    INTO source_debt
    FROM "PublisherCompensation" compensation
    LEFT JOIN "Transaction" debt
      ON debt."id" = compensation."debtRepaymentTransactionId"
    WHERE compensation."compensationTransactionId" = NEW."sourceTransactionId";
  END IF;

  SELECT COALESCE(SUM(allocation."amount"), 0)
  INTO already_allocated
  FROM "WithdrawalAllocation" allocation
  WHERE allocation."sourceTransactionId" = NEW."sourceTransactionId"
    AND allocation."releasedAt" IS NULL;

  IF source_row.amount + source_debt <= 0
    OR already_allocated + NEW."amount" > source_row.amount + source_debt THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Withdrawal allocation exceeds its remaining net ledger source';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "WithdrawalAllocation_source_identity_guard"
BEFORE INSERT ON "WithdrawalAllocation"
FOR EACH ROW EXECUTE FUNCTION "guard_withdrawal_allocation_source_identity"();

-- A direct writer must update PublisherBalance in the same transaction as a
-- carry allocation/release. Check the exact end-of-transaction state from both
-- mutation directions; the BEFORE trigger above provides the serialization
-- lock, while these deferred checks prevent partial direct-SQL commits.
CREATE FUNCTION "assert_publisher_carry_forward_integrity"(
  target_publisher_id TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  balance_row RECORD;
  active_carry NUMERIC := 0;
BEGIN
  SELECT
    balance."allocationCarryForward" AS capacity,
    balance."allocationCarryForwardUsed" AS used
  INTO balance_row
  FROM "PublisherBalance" balance
  WHERE balance."publisherId" = target_publisher_id;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM "WithdrawalAllocation" allocation
      JOIN "Withdrawal" withdrawal
        ON withdrawal."id" = allocation."withdrawalId"
      WHERE withdrawal."publisherId" = target_publisher_id
        AND allocation."sourceType" = 'CARRY_FORWARD'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Carry-forward evidence requires a publisher balance';
    END IF;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(allocation."amount"), 0)
  INTO active_carry
  FROM "WithdrawalAllocation" allocation
  JOIN "Withdrawal" withdrawal
    ON withdrawal."id" = allocation."withdrawalId"
  WHERE withdrawal."publisherId" = target_publisher_id
    AND allocation."sourceType" = 'CARRY_FORWARD'
    AND allocation."releasedAt" IS NULL;

  IF balance_row.used IS DISTINCT FROM active_carry
    OR balance_row.used < 0
    OR balance_row.used > balance_row.capacity THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher carry-forward balance does not equal active allocation evidence';
  END IF;
END;
$$;

CREATE FUNCTION "require_publisher_carry_forward_integrity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_publisher_id TEXT;
  new_publisher_id TEXT;
  target_withdrawal_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'PublisherBalance' THEN
    IF TG_OP <> 'INSERT' THEN
      old_publisher_id := OLD."publisherId";
    END IF;
    IF TG_OP <> 'DELETE' THEN
      new_publisher_id := NEW."publisherId";
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      target_withdrawal_id := OLD."withdrawalId";
    ELSE
      target_withdrawal_id := NEW."withdrawalId";
    END IF;
    SELECT withdrawal."publisherId"
    INTO new_publisher_id
    FROM "Withdrawal" withdrawal
    WHERE withdrawal."id" = target_withdrawal_id;
  END IF;

  IF old_publisher_id IS NOT NULL THEN
    PERFORM "assert_publisher_carry_forward_integrity"(old_publisher_id);
  END IF;
  IF new_publisher_id IS NOT NULL
    AND new_publisher_id IS DISTINCT FROM old_publisher_id THEN
    PERFORM "assert_publisher_carry_forward_integrity"(new_publisher_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "WithdrawalAllocation_carry_forward_commit_guard"
AFTER INSERT OR UPDATE OR DELETE ON "WithdrawalAllocation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_publisher_carry_forward_integrity"();

CREATE CONSTRAINT TRIGGER "PublisherBalance_carry_forward_commit_guard"
AFTER INSERT OR UPDATE OR DELETE ON "PublisherBalance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "require_publisher_carry_forward_integrity"();

COMMIT;
