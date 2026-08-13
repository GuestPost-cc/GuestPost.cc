-- Order SETTLED was advertised as a lifecycle state but no current writer
-- produces it. Settlement approval, return-to-review, and funds release were
-- also collapsed into one SETTLED OrderEvent type. This hard-drain migration
-- removes that ambiguity without discarding historical state.
--
-- Mixed-version compatibility: every API and worker writer must be stopped
-- before this migration. An old image cannot run afterward because it may
-- reference the removed enum values. Roll forward with the matching image;
-- never restart an old writer against the migrated schema.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

LOCK TABLE
  public."Order",
  public."OrderItem",
  public."OrderDispute",
  public."OrderCancellationRequest",
  public."OrderEvent",
  public."Settlement",
  public."Transaction"
IN ACCESS EXCLUSIVE MODE;

-- Fail if a later schema change introduces another enum-typed status column.
-- That column would otherwise remain dependent on the old type or lose its
-- legacy value without an explicit domain decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND udt_name = 'OrderStatus'
      AND (table_name, column_name) NOT IN (
        ('Order', 'status'),
        ('OrderItem', 'status'),
        ('OrderDispute', 'previousStatus'),
        ('OrderCancellationRequest', 'previousOrderStatus')
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: unexpected OrderStatus column exists';
  END IF;
END;
$$;

-- SETTLEMENT_CREATED was also historically reused for platform-owned revenue,
-- where no Settlement exists. Everything else carrying that event must bind
-- to the exact Settlement before the enum is split.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."OrderEvent" event
    LEFT JOIN public."Settlement" settlement
      ON settlement."id" = event."metadata"->>'settlementId'
      AND settlement."orderId" = event."orderId"
    WHERE event."eventType" = 'SETTLEMENT_CREATED'
      AND event."metadata"->>'platformRevenue' IS DISTINCT FROM 'true'
      AND settlement."id" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: settlement-created event lacks an exact settlement/order binding';
  END IF;
END;
$$;

-- A legacy successful terminal state must already have the same exact money
-- and release-event evidence required for COMPLETED publisher orders. Do not
-- turn unexplained/corrupt state into an apparently valid completion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."Order" order_row
    WHERE order_row."status" = 'SETTLED'
      AND (
        (
          SELECT COUNT(*)
          FROM public."Settlement" settlement
          WHERE settlement."orderId" = order_row."id"
            AND settlement."status" = 'RELEASED'
        ) <> 1
        OR (
          SELECT COUNT(*)
          FROM public."Settlement" settlement
          JOIN public."Transaction" release_tx
            ON release_tx."settlementId" = settlement."id"
          WHERE settlement."orderId" = order_row."id"
            AND settlement."status" = 'RELEASED'
            AND release_tx."type" = 'SETTLEMENT_RELEASE'
            AND release_tx."orderId" = order_row."id"
            AND release_tx."publisherId" = settlement."publisherId"
            AND release_tx."amount" = settlement."publisherAmount"
            AND release_tx."currency" = settlement."currency"
            AND release_tx."walletId" IS NULL
            AND release_tx."provider" IS NULL
            AND release_tx."providerRef" IS NULL
        ) <> 1
        OR (
          SELECT COUNT(*)
          FROM public."Settlement" settlement
          JOIN public."OrderEvent" release_event
            ON release_event."orderId" = order_row."id"
            AND release_event."eventType" = 'SETTLED'
            AND release_event."metadata"->>'settlementId' = settlement."id"
            AND (
              release_event."message" LIKE 'Settlement released —%'
              OR release_event."message" LIKE 'Settlement auto-released —%'
              OR release_event."message" LIKE 'Settlement approved —%'
            )
          WHERE settlement."orderId" = order_row."id"
            AND settlement."status" = 'RELEASED'
        ) <> 1
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: legacy SETTLED order lacks exact release evidence';
  END IF;
END;
$$;

-- Historical SETTLED events are safe to reclassify only when their immutable
-- message identifies one of the event meanings emitted by released versions
-- of the application. Unknown evidence stops the cutover for manual review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."OrderEvent"
    WHERE "eventType" = 'SETTLED'
      AND CASE
        WHEN "message" = 'Settlement customer-approved' THEN FALSE
        WHEN "message" LIKE 'Settlement auto-approved —%' THEN FALSE
        WHEN "message" LIKE 'Settlement returned to review:%' THEN FALSE
        WHEN "message" LIKE 'Settlement released —%' THEN FALSE
        WHEN "message" LIKE 'Settlement auto-released —%' THEN FALSE
        WHEN "message" LIKE 'Settlement approved —%' THEN FALSE
        ELSE TRUE
      END
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: unclassified SETTLED OrderEvent exists';
  END IF;
END;
$$;

-- Promote the settlement binding out of JSON metadata before event
-- reclassification. Exact financial evidence must have a relational identity.
ALTER TABLE public."OrderEvent"
  ADD COLUMN "settlementId" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."OrderEvent" event
    LEFT JOIN public."Settlement" settlement
      ON settlement."id" = event."metadata"->>'settlementId'
      AND settlement."orderId" = event."orderId"
    WHERE event."eventType" = 'SETTLED'
      AND settlement."id" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: settlement event lacks an exact settlement/order binding';
  END IF;
END;
$$;

UPDATE public."OrderEvent"
SET "settlementId" = "metadata"->>'settlementId'
WHERE "eventType" = 'SETTLED';

UPDATE public."OrderEvent" event
SET "settlementId" = event."metadata"->>'settlementId'
WHERE event."eventType" = 'SETTLEMENT_CREATED'
  AND EXISTS (
    SELECT 1
    FROM public."Settlement" settlement
    WHERE settlement."id" = event."metadata"->>'settlementId'
      AND settlement."orderId" = event."orderId"
  );

-- Backfill every live and historical OrderStatus column before rebuilding the
-- enum. SETTLED represented the same terminal outcome now named COMPLETED.
UPDATE public."Order"
SET "status" = 'COMPLETED'
WHERE "status" = 'SETTLED';

-- The financial-identity trigger correctly forbids application mutations to a
-- captured item. This table is exclusively locked and all writers are drained,
-- so suspend only that trigger for this one enum-value normalization.
ALTER TABLE public."OrderItem"
  DISABLE TRIGGER "OrderItem_financial_identity_guard";

UPDATE public."OrderItem"
SET "status" = 'COMPLETED'
WHERE "status" = 'SETTLED';

ALTER TABLE public."OrderItem"
  ENABLE TRIGGER "OrderItem_financial_identity_guard";

UPDATE public."OrderDispute"
SET "previousStatus" = 'COMPLETED'
WHERE "previousStatus" = 'SETTLED';

UPDATE public."OrderCancellationRequest"
SET "previousOrderStatus" = 'COMPLETED'
WHERE "previousOrderStatus" = 'SETTLED';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."Order" WHERE "status" = 'SETTLED')
    OR EXISTS (SELECT 1 FROM public."OrderItem" WHERE "status" = 'SETTLED')
    OR EXISTS (
      SELECT 1 FROM public."OrderDispute"
      WHERE "previousStatus" = 'SETTLED'
    )
    OR EXISTS (
      SELECT 1 FROM public."OrderCancellationRequest"
      WHERE "previousOrderStatus" = 'SETTLED'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: SETTLED OrderStatus backfill incomplete';
  END IF;
END;
$$;

-- Earlier financial migrations install initially-deferred row constraint
-- triggers on Order and OrderEvent. Flush their queued checks while the old
-- enum types still exist; PostgreSQL otherwise rejects the following ALTER
-- TABLE operations because those tables have pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE public."Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE public."OrderItem" ALTER COLUMN "status" DROP DEFAULT;

ALTER TYPE public."OrderStatus" RENAME TO "OrderStatus_before_settled_removal";

CREATE TYPE public."OrderStatus" AS ENUM (
  'DRAFT',
  'PENDING_PAYMENT',
  'PAID',
  'SUBMITTED',
  'ACCEPTED',
  'CONTENT_REQUESTED',
  'CONTENT_CREATION',
  'CONTENT_READY',
  'CUSTOMER_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'VERIFIED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'DISPUTED'
);

ALTER TABLE public."Order"
  ALTER COLUMN "status" TYPE public."OrderStatus"
  USING ("status"::text::public."OrderStatus");
ALTER TABLE public."OrderItem"
  ALTER COLUMN "status" TYPE public."OrderStatus"
  USING ("status"::text::public."OrderStatus");
ALTER TABLE public."OrderDispute"
  ALTER COLUMN "previousStatus" TYPE public."OrderStatus"
  USING ("previousStatus"::text::public."OrderStatus");
ALTER TABLE public."OrderCancellationRequest"
  ALTER COLUMN "previousOrderStatus" TYPE public."OrderStatus"
  USING ("previousOrderStatus"::text::public."OrderStatus");

ALTER TABLE public."Order"
  ALTER COLUMN "status" SET DEFAULT 'DRAFT'::public."OrderStatus";
ALTER TABLE public."OrderItem"
  ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT'::public."OrderStatus";

DROP TYPE public."OrderStatus_before_settled_removal";

-- Rebuild the event enum in one transaction so historical SETTLED evidence is
-- atomically split into the three explicit settlement meanings used by current
-- writers, while platform-owned revenue receives its own event identity.
ALTER TYPE public."OrderEventType"
  RENAME TO "OrderEventType_before_settled_split";

CREATE TYPE public."OrderEventType" AS ENUM (
  'ORDER_CREATED',
  'ITEM_ADDED',
  'ITEM_REMOVED',
  'PAYMENT_SUBMITTED',
  'ORDER_SUBMITTED',
  'PAYMENT_CAPTURED',
  'ORDER_ACCEPTED',
  'CONTENT_REQUESTED',
  'CONTENT_SUBMITTED',
  'CONTENT_MARKED_READY',
  'CONTENT_SUBMITTED_FOR_REVIEW',
  'CONTENT_APPROVED',
  'REVISION_REQUESTED',
  'PUBLICATION_MARKED',
  'VERIFIED_AUTO',
  'VERIFIED_MANUAL',
  'DELIVERY_CONFIRMED',
  'DISPUTE_OPENED',
  'DISPUTE_RESOLVED',
  'ORDER_CANCELLED',
  'REFUND_ISSUED',
  'SETTLEMENT_CREATED',
  'PLATFORM_REVENUE_RECOGNIZED',
  'SETTLEMENT_CUSTOMER_APPROVED',
  'SETTLEMENT_RETURNED_TO_REVIEW',
  'SETTLEMENT_RELEASED',
  'REFUNDED',
  'VERIFICATION_ESCALATED',
  'AUTO_ACCEPTED',
  'REVIEW_REMINDER',
  'CANCELLATION_REQUESTED',
  'CANCELLATION_RESPONDED',
  'CANCELLATION_RESOLVED',
  'ORDER_DECLINED',
  'PUBLISHER_COMPENSATION_RECORDED'
);

ALTER TABLE public."OrderEvent"
  ALTER COLUMN "eventType" TYPE public."OrderEventType"
  USING (
    CASE
      WHEN "eventType"::text = 'SETTLEMENT_CREATED'
        AND "metadata"->>'platformRevenue' = 'true'
        THEN 'PLATFORM_REVENUE_RECOGNIZED'
      WHEN "eventType"::text <> 'SETTLED' THEN "eventType"::text
      WHEN "message" = 'Settlement customer-approved'
        OR "message" LIKE 'Settlement auto-approved —%'
        THEN 'SETTLEMENT_CUSTOMER_APPROVED'
      WHEN "message" LIKE 'Settlement returned to review:%'
        THEN 'SETTLEMENT_RETURNED_TO_REVIEW'
      ELSE 'SETTLEMENT_RELEASED'
    END::public."OrderEventType"
  );

DROP TYPE public."OrderEventType_before_settled_split";

ALTER TABLE public."OrderEvent"
  ADD CONSTRAINT "OrderEvent_settlementId_fkey"
  FOREIGN KEY ("settlementId") REFERENCES public."Settlement"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrderEvent_settlementId_idx"
  ON public."OrderEvent"("settlementId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."Settlement" settlement
    WHERE (
        settlement."status" = 'RELEASED'
        OR (
          settlement."status" = 'CANCELLED'
          AND settlement."settledAt" IS NOT NULL
        )
      )
      AND (
        settlement."settledAt" IS NULL
        OR (
          SELECT COUNT(*)
          FROM public."OrderEvent" release_event
          WHERE release_event."settlementId" = settlement."id"
            AND release_event."orderId" = settlement."orderId"
            AND release_event."eventType" = 'SETTLEMENT_RELEASED'
        ) <> 1
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order lifecycle migration blocked: released settlement lacks one exact release event';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "OrderEvent_settlementId_released_key"
  ON public."OrderEvent"("settlementId")
  WHERE "eventType" = 'SETTLEMENT_RELEASED';

-- Workflow events must bind to the same Order as their relational Settlement.
-- Release events are insert-only evidence; later history is always appended.
CREATE FUNCTION public."guard_settlement_order_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  settlement_order_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."eventType" IN (
      'SETTLEMENT_CREATED',
      'PLATFORM_REVENUE_RECOGNIZED',
      'SETTLEMENT_CUSTOMER_APPROVED',
      'SETTLEMENT_RETURNED_TO_REVIEW',
      'SETTLEMENT_RELEASED'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement and revenue event evidence is append-only';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD."eventType" IN (
      'SETTLEMENT_CREATED',
      'PLATFORM_REVENUE_RECOGNIZED',
      'SETTLEMENT_CUSTOMER_APPROVED',
      'SETTLEMENT_RETURNED_TO_REVIEW',
      'SETTLEMENT_RELEASED'
    )
    OR NEW."eventType" IN (
      'SETTLEMENT_CREATED',
      'PLATFORM_REVENUE_RECOGNIZED',
      'SETTLEMENT_CUSTOMER_APPROVED',
      'SETTLEMENT_RETURNED_TO_REVIEW',
      'SETTLEMENT_RELEASED'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement and revenue event evidence is insert-only and append-only';
  END IF;

  IF NEW."eventType" IN (
    'SETTLEMENT_CREATED',
    'SETTLEMENT_CUSTOMER_APPROVED',
    'SETTLEMENT_RETURNED_TO_REVIEW',
    'SETTLEMENT_RELEASED'
  ) THEN
    IF NEW."settlementId" IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement order event requires a settlement identity';
    END IF;

    SELECT settlement."orderId"
    INTO settlement_order_id
    FROM public."Settlement" settlement
    WHERE settlement."id" = NEW."settlementId";

    IF settlement_order_id IS NULL
       OR settlement_order_id IS DISTINCT FROM NEW."orderId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement order event identity does not match its settlement';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "OrderEvent_settlement_identity_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."OrderEvent"
  FOR EACH ROW
  EXECUTE FUNCTION public."guard_settlement_order_event"();

-- Extend the existing deferred release pair to require the third exact fact:
-- one release event bound to the same settlement and order.
CREATE OR REPLACE FUNCTION public."require_settlement_release_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (
      NEW."status" = 'RELEASED'
      OR (NEW."status" = 'CANCELLED' AND NEW."settledAt" IS NOT NULL)
    )
    AND (
      NEW."settledAt" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public."Transaction" ledger
        WHERE ledger."settlementId" = NEW."id"
          AND ledger."type" = 'SETTLEMENT_RELEASE'
          AND ledger."amount" = NEW."publisherAmount"
          AND ledger."currency" = NEW."currency"
          AND ledger."orderId" = NEW."orderId"
          AND ledger."publisherId" = NEW."publisherId"
          AND ledger."walletId" IS NULL
          AND ledger."provider" IS NULL
          AND ledger."providerRef" IS NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM public."OrderEvent" release_event
        WHERE release_event."settlementId" = NEW."id"
          AND release_event."orderId" = NEW."orderId"
          AND release_event."eventType" = 'SETTLEMENT_RELEASED'
      )
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'released settlement requires exact release ledger and event evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public."require_released_settlement_for_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."eventType" = 'SETTLEMENT_RELEASED'
     AND NOT EXISTS (
       SELECT 1
       FROM public."Settlement" settlement
       WHERE settlement."id" = NEW."settlementId"
         AND settlement."orderId" = NEW."orderId"
         AND settlement."settledAt" IS NOT NULL
         AND settlement."status" IN ('RELEASED', 'CANCELLED')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release event requires a released settlement';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "OrderEvent_released_settlement_required"
  AFTER INSERT OR UPDATE ON public."OrderEvent"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."eventType" = 'SETTLEMENT_RELEASED')
  EXECUTE FUNCTION public."require_released_settlement_for_event"();

COMMENT ON TYPE public."OrderStatus" IS
  'Order lifecycle; COMPLETED is the sole successful terminal state after delivery.';
COMMENT ON TYPE public."OrderEventType" IS
  'Append-only order audit events; settlement approval, review return, and release are distinct evidence.';

COMMIT;
