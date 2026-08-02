-- Settlement eligibility is a financial invariant, not a worker convention.
-- Serialize every blocker writer through the parent Order row and re-check the
-- relational predicate when a settlement is created or released.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE
  "DeliveryFraudFlag",
  "ListingService",
  "MarketplaceListing",
  "Order",
  "OrderItem",
  "OrderCancellationRequest",
  "OrderDeliveryVersion",
  "OrderDispute",
  "PlatformRevenue",
  "PlatformSettings",
  "Revision",
  "Settlement",
  "Transaction",
  "Wallet",
  "Website"
IN SHARE MODE;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "PlatformSettings") > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: PlatformSettings is not a singleton';
  END IF;
END
$$;

ALTER TABLE "Order"
  ADD COLUMN "settlementGateVersion" INTEGER NOT NULL DEFAULT 0;

-- A paid order's header is only valid when it is backed by at least one
-- checkout-ready line item with the same exact total and website identity.
-- Historical mismatches require reconciliation; this migration never rounds
-- or invents line-item evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" order_row
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*) AS item_count,
        SUM(item."price") AS item_total,
        COUNT(*) FILTER (
          WHERE item."status" <> 'PENDING_PAYMENT'
            OR item."websiteId" IS DISTINCT FROM order_row."websiteId"
        ) AS invalid_item_count
      FROM "OrderItem" item
      WHERE item."orderId" = order_row."id"
    ) item_facts
    WHERE (
        order_row."paymentStatus" = 'PAID'
        OR EXISTS (
          SELECT 1 FROM "Transaction" purchase
          WHERE purchase."orderId" = order_row."id"
            AND purchase."type" = 'PURCHASE'
        )
        OR EXISTS (
          SELECT 1 FROM "Settlement" settlement
          WHERE settlement."orderId" = order_row."id"
        )
      )
      AND (
        order_row."websiteId" IS NULL
        OR item_facts.item_count = 0
        OR item_facts.item_total IS DISTINCT FROM order_row."amount"
        OR item_facts.invalid_item_count > 0
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: paid order item identity or total is invalid';
  END IF;
END
$$;

-- Every captured liability must be attributable through one canonical catalog
-- chain. A self-consistent Order/OrderItem website pair is insufficient: a
-- stale or corrupt writer could otherwise buy service A while crediting the
-- publisher attached to website B.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Order" order_row
    LEFT JOIN "ListingService" service
      ON service."id" = order_row."listingServiceId"
    LEFT JOIN "MarketplaceListing" listing
      ON listing."id" = service."listingId"
    LEFT JOIN "Website" website
      ON website."id" = listing."websiteId"
    WHERE (
        order_row."paymentStatus" IN ('PAID', 'REFUNDED')
        OR EXISTS (
          SELECT 1 FROM "Transaction" purchase
          WHERE purchase."orderId" = order_row."id"
            AND purchase."type" = 'PURCHASE'
        )
        OR EXISTS (
          SELECT 1 FROM "Settlement" settlement
          WHERE settlement."orderId" = order_row."id"
        )
      )
      AND (
        service."id" IS NULL
        OR listing."id" IS NULL
        OR website."id" IS NULL
        OR order_row."listingId" IS DISTINCT FROM service."listingId"
        OR listing."id" IS DISTINCT FROM order_row."listingId"
        OR listing."websiteId" IS DISTINCT FROM order_row."websiteId"
        OR website."id" IS DISTINCT FROM order_row."websiteId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: captured order catalog attribution is invalid';
  END IF;
END
$$;

ALTER TABLE "PlatformSettings"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

INSERT INTO "PlatformSettings" (
  "id", "platformFeePct", "version", "createdAt", "updatedAt"
)
SELECT
  'platform-settings-default', 20, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "PlatformSettings");

CREATE UNIQUE INDEX "PlatformSettings_singleton_key"
  ON "PlatformSettings" ((TRUE));

ALTER TABLE "PlatformSettings"
  ADD CONSTRAINT "PlatformSettings_fee_policy_check" CHECK (
    "platformFeePct" >= 0
    AND "platformFeePct" <= 100
    AND "platformFeePct" * 100 = TRUNC("platformFeePct" * 100)
    AND "version" > 0
  );

ALTER TABLE "Settlement"
  ADD COLUMN "platformFeeBps" INTEGER,
  ADD COLUMN "feePolicyVersion" VARCHAR(128);

ALTER TABLE "PlatformRevenue"
  ADD COLUMN "platformFeeBps" INTEGER,
  ADD COLUMN "feePolicyVersion" VARCHAR(128);

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_fee_policy_snapshot_check" CHECK (
    (
      "platformFeeBps" IS NULL
      AND "feePolicyVersion" IS NULL
    )
    OR (
      "platformFeeBps" IS NOT NULL
      AND "feePolicyVersion" IS NOT NULL
      AND "platformFeeBps" BETWEEN 0 AND 10000
      AND LENGTH("feePolicyVersion") BETWEEN 1 AND 128
      AND "platformFee" = ROUND(
        "grossAmount" * "platformFeeBps"::NUMERIC / 10000,
        2
      )
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Transaction"
    WHERE "type" = 'SETTLEMENT_RELEASE'
      AND "settlementId" IS NOT NULL
    GROUP BY "settlementId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: duplicate release ledger rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Transaction" ledger
    LEFT JOIN "Settlement" settlement ON settlement."id" = ledger."settlementId"
    WHERE ledger."type" = 'SETTLEMENT_RELEASE'
      AND (
        settlement."id" IS NULL
        OR NOT (
          settlement."status" = 'RELEASED'
          OR (
            settlement."status" = 'CANCELLED'
            AND settlement."settledAt" IS NOT NULL
          )
        )
        OR ledger."amount" IS DISTINCT FROM settlement."publisherAmount"
        OR ledger."currency" IS DISTINCT FROM settlement."currency"
        OR ledger."orderId" IS DISTINCT FROM settlement."orderId"
        OR ledger."publisherId" IS DISTINCT FROM settlement."publisherId"
        OR ledger."walletId" IS NOT NULL
        OR ledger."provider" IS NOT NULL
        OR ledger."providerRef" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: release ledger identity does not match its settlement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Settlement" settlement
    WHERE (
        settlement."status" = 'RELEASED'
        OR (settlement."status" = 'CANCELLED' AND settlement."settledAt" IS NOT NULL)
      )
      AND (
        settlement."settledAt" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "Transaction" ledger
          WHERE ledger."settlementId" = settlement."id"
            AND ledger."type" = 'SETTLEMENT_RELEASE'
            AND ledger."amount" = settlement."publisherAmount"
            AND ledger."currency" = settlement."currency"
            AND ledger."orderId" = settlement."orderId"
            AND ledger."publisherId" = settlement."publisherId"
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: released settlement lacks matching release evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Settlement" settlement
    LEFT JOIN "Order" order_row ON order_row."id" = settlement."orderId"
    LEFT JOIN "Website" website ON website."id" = order_row."websiteId"
    WHERE order_row."id" IS NULL
      OR website."id" IS NULL
      OR settlement."grossAmount" <= 0
      OR settlement."platformFee" < 0
      OR settlement."publisherAmount" <= 0
      OR settlement."grossAmount" * 100 <> TRUNC(settlement."grossAmount" * 100)
      OR settlement."platformFee" * 100 <> TRUNC(settlement."platformFee" * 100)
      OR settlement."publisherAmount" * 100 <> TRUNC(settlement."publisherAmount" * 100)
      OR settlement."grossAmount" <> settlement."platformFee" + settlement."publisherAmount"
      OR settlement."grossAmount" IS DISTINCT FROM order_row."amount"
      OR settlement."publisherId" IS DISTINCT FROM website."publisherId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: settlement amount or publisher attribution does not match its order';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag"
    GROUP BY "deliveryVersionId", "type"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: duplicate delivery fraud evidence exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag" flag
    LEFT JOIN "OrderDeliveryVersion" delivery
      ON delivery."id" = flag."deliveryVersionId"
    WHERE delivery."id" IS NULL
      OR flag."orderId" IS DISTINCT FROM delivery."orderId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: fraud evidence does not match its delivery order';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Transaction" purchase
    LEFT JOIN "Order" order_row ON order_row."id" = purchase."orderId"
    LEFT JOIN "Wallet" wallet ON wallet."id" = purchase."walletId"
    WHERE purchase."type" = 'PURCHASE'
      AND (
        order_row."id" IS NULL
        OR wallet."id" IS NULL
        OR purchase."currency" <> 'USD'
        OR purchase."amount" >= 0
        OR purchase."amount" * 100 <> TRUNC(purchase."amount" * 100)
        OR purchase."amount" IS DISTINCT FROM -order_row."amount"
        OR order_row."paymentStatus" NOT IN ('PAID', 'REFUNDED')
        OR wallet."currency" <> order_row."currency"
        OR wallet."organizationId" IS DISTINCT FROM order_row."organizationId"
        OR purchase."publisherId" IS NOT NULL
        OR purchase."settlementId" IS NOT NULL
        OR purchase."provider" IS NOT NULL
        OR purchase."providerRef" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: purchase ledger identity is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Transaction"
    WHERE "type" = 'PURCHASE' AND "orderId" IS NOT NULL
    GROUP BY "orderId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: duplicate purchase ledger rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Order" order_row
    LEFT JOIN "Transaction" purchase
      ON purchase."orderId" = order_row."id"
     AND purchase."type" = 'PURCHASE'
    WHERE order_row."paymentStatus" IN ('PAID', 'REFUNDED')
    GROUP BY order_row."id", order_row."amount"
    HAVING COUNT(purchase."id") <> 1
      OR MIN(purchase."amount") IS DISTINCT FROM -order_row."amount"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: paid order lacks one exact purchase ledger row';
  END IF;
END
$$;

DO $$
DECLARE
  policy "PlatformSettings"%ROWTYPE;
BEGIN
  SELECT * INTO STRICT policy FROM "PlatformSettings";
  IF LENGTH(format('platform-settings:%s:v%s', policy."id", policy."version")) > 128 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: fee policy identity exceeds 128 characters';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "Settlement" settlement
    WHERE settlement."status" NOT IN ('RELEASED', 'CANCELLED')
      AND settlement."platformFee" IS DISTINCT FROM ROUND(
        settlement."grossAmount" * policy."platformFeePct" / 100,
        2
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: active settlement split does not match the singleton fee policy';
  END IF;

  -- PlatformRevenue is internal recognition, but it is still money evidence.
  -- Existing rows must already have an exact paid-order PURCHASE and an
  -- explicit PLATFORM channel. Missing evidence blocks rollout; this migration
  -- never creates a synthetic ledger row to make history appear complete.
  IF EXISTS (
    SELECT 1
    FROM "PlatformRevenue" revenue
    LEFT JOIN "Order" order_row ON order_row."id" = revenue."orderId"
    WHERE order_row."id" IS NULL
      OR revenue."currency" <> 'USD'
      OR order_row."currency" <> 'USD'
      OR revenue."amount" <= 0
      OR revenue."platformFee" < 0
      OR revenue."netRevenue" < 0
      OR revenue."amount" * 100 <> TRUNC(revenue."amount" * 100)
      OR revenue."platformFee" * 100 <> TRUNC(revenue."platformFee" * 100)
      OR revenue."netRevenue" * 100 <> TRUNC(revenue."netRevenue" * 100)
      OR revenue."amount" <> revenue."platformFee" + revenue."netRevenue"
      OR revenue."amount" IS DISTINCT FROM order_row."amount"
      OR order_row."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM'
      OR revenue."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM'
      OR (revenue."reversedAt" IS NULL AND order_row."paymentStatus" <> 'PAID')
      OR (
        revenue."reversedAt" IS NOT NULL
        AND order_row."paymentStatus" NOT IN ('PAID', 'REFUNDED')
      )
      OR (
        revenue."reversedAt" IS NOT NULL
        AND revenue."reversedAt" < revenue."recordedAt"
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "Transaction" purchase
        JOIN "Wallet" wallet ON wallet."id" = purchase."walletId"
        WHERE purchase."orderId" = revenue."orderId"
          AND purchase."type" = 'PURCHASE'
          AND purchase."amount" = -revenue."amount"
          AND purchase."currency" = 'USD'
          AND purchase."publisherId" IS NULL
          AND purchase."settlementId" IS NULL
          AND purchase."provider" IS NULL
          AND purchase."providerRef" IS NULL
          AND wallet."currency" = 'USD'
          AND wallet."organizationId" IS NOT DISTINCT FROM order_row."organizationId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: platform revenue lacks exact immutable order funding evidence';
  END IF;

  -- Only live historical recognition is attributed to the current singleton
  -- policy, and only after proving the split matches it exactly. Reversed rows
  -- remain honestly unversioned because their original policy is not safely
  -- reconstructable from the current singleton.
  IF EXISTS (
    SELECT 1
    FROM "PlatformRevenue" revenue
    WHERE revenue."reversedAt" IS NULL
      AND revenue."platformFee" IS DISTINCT FROM ROUND(
        revenue."amount" * policy."platformFeePct" / 100,
        2
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement eligibility migration blocked: active platform revenue split does not match the singleton fee policy';
  END IF;
END
$$;

UPDATE "Settlement" settlement
SET
  "platformFeeBps" = (policy."platformFeePct" * 100)::INTEGER,
  "feePolicyVersion" = format(
    'platform-settings:%s:v%s',
    policy."id",
    policy."version"
  )
FROM "PlatformSettings" policy
WHERE settlement."status" NOT IN ('RELEASED', 'CANCELLED');

UPDATE "PlatformRevenue" revenue
SET
  "platformFeeBps" = (policy."platformFeePct" * 100)::INTEGER,
  "feePolicyVersion" = format(
    'platform-settings:%s:v%s',
    policy."id",
    policy."version"
  )
FROM "PlatformSettings" policy
WHERE revenue."reversedAt" IS NULL;

CREATE UNIQUE INDEX "Transaction_settlement_release_unique"
  ON "Transaction"("settlementId")
  WHERE "type" = 'SETTLEMENT_RELEASE' AND "settlementId" IS NOT NULL;

CREATE UNIQUE INDEX "Transaction_purchase_order_unique"
  ON "Transaction"("orderId")
  WHERE "type" = 'PURCHASE' AND "orderId" IS NOT NULL;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_settlement_release_identity_check" CHECK (
    "type" <> 'SETTLEMENT_RELEASE'
    OR (
      "settlementId" IS NOT NULL
      AND "orderId" IS NOT NULL
      AND "publisherId" IS NOT NULL
      AND "walletId" IS NULL
      AND "provider" IS NULL
      AND "providerRef" IS NULL
      AND "currency" = 'USD'
      AND "amount" > 0
      AND "amount" * 100 = TRUNC("amount" * 100)
    )
  );

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_purchase_identity_check" CHECK (
    "type" <> 'PURCHASE'
    OR (
      "walletId" IS NOT NULL
      AND "orderId" IS NOT NULL
      AND "publisherId" IS NULL
      AND "settlementId" IS NULL
      AND "provider" IS NULL
      AND "providerRef" IS NULL
      AND "currency" = 'USD'
      AND "amount" < 0
      AND "amount" * 100 = TRUNC("amount" * 100)
    )
  );

ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_amount_split_check" CHECK (
    "grossAmount" > 0
    AND "platformFee" >= 0
    AND "publisherAmount" > 0
    AND "grossAmount" * 100 = TRUNC("grossAmount" * 100)
    AND "platformFee" * 100 = TRUNC("platformFee" * 100)
    AND "publisherAmount" * 100 = TRUNC("publisherAmount" * 100)
    AND "grossAmount" = "platformFee" + "publisherAmount"
  );

ALTER TABLE "PlatformRevenue"
  ADD CONSTRAINT "PlatformRevenue_amount_split_check" CHECK (
    "amount" > 0
    AND "platformFee" >= 0
    AND "netRevenue" >= 0
    AND "amount" * 100 = TRUNC("amount" * 100)
    AND "platformFee" * 100 = TRUNC("platformFee" * 100)
    AND "netRevenue" * 100 = TRUNC("netRevenue" * 100)
    AND "amount" = "platformFee" + "netRevenue"
    AND ("reversedAt" IS NULL OR "reversedAt" >= "recordedAt")
  ),
  ADD CONSTRAINT "PlatformRevenue_fee_policy_snapshot_check" CHECK (
    (
      "reversedAt" IS NOT NULL
      AND "platformFeeBps" IS NULL
      AND "feePolicyVersion" IS NULL
    )
    OR (
      "platformFeeBps" IS NOT NULL
      AND "feePolicyVersion" IS NOT NULL
      AND "platformFeeBps" BETWEEN 0 AND 10000
      AND LENGTH("feePolicyVersion") BETWEEN 1 AND 128
      AND "platformFee" = ROUND(
        "amount" * "platformFeeBps"::NUMERIC / 10000,
        2
      )
    )
  );

ALTER TABLE "DeliveryFraudFlag"
  ADD CONSTRAINT "DeliveryFraudFlag_deliveryVersionId_type_key"
  UNIQUE ("deliveryVersionId", "type");

CREATE FUNCTION "guard_platform_fee_policy"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform fee policy evidence cannot be deleted';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform fee policy identity is immutable';
  END IF;
  IF NEW."platformFeePct" IS DISTINCT FROM OLD."platformFeePct" THEN
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform fee policy change must increment version exactly once';
    END IF;
  ELSIF NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform fee policy version cannot change without a fee change';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PlatformSettings_fee_policy_guard"
  BEFORE UPDATE OR DELETE ON "PlatformSettings"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_platform_fee_policy"();

CREATE FUNCTION "lock_settlement_blocker_order"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_order_id := OLD."orderId";
  ELSE
    IF TG_OP = 'UPDATE' AND NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement blocker order identity is immutable';
    END IF;
    parent_order_id := NEW."orderId";
  END IF;

  -- A row lock alone is insufficient under SERIALIZABLE: a waiter can keep a
  -- snapshot taken before the blocker committed. Updating a dedicated fence
  -- forces that waiter to abort/retry and rebuild eligibility from fresh data.
  UPDATE "Order"
  SET "settlementGateVersion" = "settlementGateVersion" + 1
  WHERE "id" = parent_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'settlement blocker order does not exist';
  END IF;
  IF TG_TABLE_NAME = 'DeliveryFraudFlag' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery fraud evidence is append-only';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery fraud evidence is insert-only and append-only';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "OrderDeliveryVersion" delivery
      WHERE delivery."id" = NEW."deliveryVersionId"
        AND delivery."orderId" = parent_order_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery fraud evidence does not match its order';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- Stable lock ordering closes release-vs-dispute/revision/fraud/cancellation/
-- delivery races. Whichever transaction obtains Order first becomes visible to
-- the other transaction's eligibility decision.
CREATE TRIGGER "OrderDispute_settlement_order_lock" BEFORE INSERT OR UPDATE OR DELETE ON "OrderDispute" FOR EACH ROW EXECUTE FUNCTION "lock_settlement_blocker_order"();
CREATE TRIGGER "Revision_settlement_order_lock" BEFORE INSERT OR UPDATE OR DELETE ON "Revision" FOR EACH ROW EXECUTE FUNCTION "lock_settlement_blocker_order"();
CREATE TRIGGER "DeliveryFraudFlag_settlement_order_lock" BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryFraudFlag" FOR EACH ROW EXECUTE FUNCTION "lock_settlement_blocker_order"();
CREATE TRIGGER "OrderCancellationRequest_settlement_order_lock" BEFORE INSERT OR UPDATE OR DELETE ON "OrderCancellationRequest" FOR EACH ROW EXECUTE FUNCTION "lock_settlement_blocker_order"();
CREATE TRIGGER "OrderDeliveryVersion_settlement_order_lock" BEFORE INSERT OR UPDATE OR DELETE ON "OrderDeliveryVersion" FOR EACH ROW EXECUTE FUNCTION "lock_settlement_blocker_order"();

-- PURCHASE is the canonical proof that the buyer wallet funded the exact Order
-- amount. It is insert-only, unique per Order, bound to that Order's USD amount
-- and organization wallet, and cannot be repurposed or erased later.
CREATE FUNCTION "guard_purchase_ledger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order RECORD;
  source_wallet RECORD;
BEGIN
  IF TG_OP = 'DELETE' AND OLD."type" = 'PURCHASE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'purchase ledger evidence is append-only';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD."type" = 'PURCHASE' OR NEW."type" = 'PURCHASE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'purchase ledger evidence is insert-only and append-only';
  END IF;
  IF TG_OP <> 'INSERT' OR NEW."type" <> 'PURCHASE' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT
    order_row."id",
    order_row."amount",
    order_row."currency",
    order_row."organizationId",
    order_row."paymentStatus"
  INTO parent_order
  FROM "Order" order_row
  WHERE order_row."id" = NEW."orderId"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'purchase ledger order does not exist';
  END IF;

  SELECT wallet."id", wallet."currency", wallet."organizationId"
  INTO source_wallet
  FROM "Wallet" wallet
  WHERE wallet."id" = NEW."walletId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'purchase ledger wallet does not exist';
  END IF;

  IF parent_order."paymentStatus" <> 'PAID'
     OR parent_order."currency" <> 'USD'
     OR NEW."currency" <> 'USD'
     OR NEW."amount" IS DISTINCT FROM -parent_order."amount"
     OR source_wallet."currency" IS DISTINCT FROM parent_order."currency"
     OR source_wallet."organizationId" IS DISTINCT FROM parent_order."organizationId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'purchase ledger identity does not match its paid order and organization wallet';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Transaction_purchase_evidence_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Transaction"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_purchase_ledger"();

-- The row-level PURCHASE guard proves one direction at insert time. This
-- deferred assertion proves the complete final transaction state: a captured
-- order has exactly one matching PURCHASE, and PURCHASE evidence cannot remain
-- attached to an order rewritten as unpaid/failed. Deferral is required because
-- production claims the Order and appends the ledger row in the same tx.
CREATE FUNCTION "assert_order_purchase_evidence_at_commit"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id TEXT;
  parent_order RECORD;
  purchase_count INTEGER;
  exact_purchase_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'Transaction' THEN
    IF TG_OP = 'INSERT' AND NEW."type" <> 'PURCHASE' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD."type" <> 'PURCHASE'
       AND NEW."type" <> 'PURCHASE' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND OLD."type" <> 'PURCHASE' THEN
      RETURN OLD;
    END IF;
    parent_order_id := CASE
      WHEN TG_OP = 'DELETE' THEN OLD."orderId"
      ELSE NEW."orderId"
    END;
  ELSE
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    parent_order_id := NEW."id";
  END IF;

  SELECT
    order_row."id",
    order_row."amount",
    order_row."currency",
    order_row."organizationId",
    order_row."paymentStatus"
  INTO parent_order
  FROM "Order" order_row
  WHERE order_row."id" = parent_order_id;

  IF NOT FOUND THEN
    IF TG_TABLE_NAME = 'Transaction' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'purchase ledger requires an existing captured order';
    END IF;
    RETURN OLD;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE purchase."amount" IS NOT DISTINCT FROM -parent_order."amount"
        AND purchase."currency" = 'USD'
        AND purchase."publisherId" IS NULL
        AND purchase."settlementId" IS NULL
        AND purchase."provider" IS NULL
        AND purchase."providerRef" IS NULL
        AND wallet."id" IS NOT NULL
        AND wallet."currency" IS NOT DISTINCT FROM parent_order."currency"
        AND wallet."organizationId" IS NOT DISTINCT FROM parent_order."organizationId"
    )
  INTO purchase_count, exact_purchase_count
  FROM "Transaction" purchase
  LEFT JOIN "Wallet" wallet ON wallet."id" = purchase."walletId"
  WHERE purchase."orderId" = parent_order_id
    AND purchase."type" = 'PURCHASE';

  IF parent_order."paymentStatus" IN ('PAID', 'REFUNDED') THEN
    IF parent_order."currency" <> 'USD'
       OR purchase_count <> 1
       OR exact_purchase_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'captured order requires exactly one matching purchase ledger row';
    END IF;
  ELSIF purchase_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'purchase ledger cannot remain attached to an uncaptured order';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Order_purchase_evidence_commit_guard"
  AFTER INSERT OR UPDATE ON "Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "assert_order_purchase_evidence_at_commit"();

CREATE CONSTRAINT TRIGGER "Transaction_purchase_order_state_commit_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "Transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "assert_order_purchase_evidence_at_commit"();

-- Payment capture is the single point at which the mutable cart becomes an
-- immutable purchased contract. Direct SQL and an old application image must
-- prove the same exact item count/total/status/website facts as the API.
CREATE FUNCTION "assert_order_capture_items"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  item_facts RECORD;
  catalog_contract RECORD;
  catalog_price_mismatch_count INTEGER;
BEGIN
  IF NEW."paymentStatus" <> 'PAID' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."paymentStatus" = 'PAID' THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*) AS item_count,
    SUM(item."price") AS item_total,
    COUNT(*) FILTER (
      WHERE item."status" <> 'PENDING_PAYMENT'
        OR item."websiteId" IS DISTINCT FROM NEW."websiteId"
    ) AS invalid_item_count
  INTO item_facts
  FROM "OrderItem" item
  WHERE item."orderId" = NEW."id";

  IF NEW."websiteId" IS NULL
     OR item_facts.item_count = 0
     OR item_facts.item_total IS DISTINCT FROM NEW."amount"
     OR item_facts.invalid_item_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order capture requires exact pending item total and website identity';
  END IF;

  SELECT
    service."listingId" AS "serviceListingId",
    service."serviceType",
    service."price",
    service."currency" AS "serviceCurrency",
    service."availability",
    listing."id" AS "listingId",
    listing."websiteId",
    listing."currency" AS "listingCurrency",
    listing."status" AS "listingStatus",
    listing."ownerType",
    website."id" AS "websiteRowId",
    website."isActive",
    website."verificationStatus"
  INTO catalog_contract
  FROM "ListingService" service
  JOIN "MarketplaceListing" listing
    ON listing."id" = service."listingId"
  JOIN "Website" website
    ON website."id" = listing."websiteId"
  WHERE service."id" = NEW."listingServiceId"
  FOR SHARE OF service, listing, website;

  IF NOT FOUND
     OR NEW."listingId" IS NULL
     OR catalog_contract."serviceListingId" IS DISTINCT FROM NEW."listingId"
     OR catalog_contract."listingId" IS DISTINCT FROM NEW."listingId"
     OR catalog_contract."websiteId" IS DISTINCT FROM NEW."websiteId"
     OR catalog_contract."websiteRowId" IS DISTINCT FROM NEW."websiteId"
     OR catalog_contract."serviceType" IS DISTINCT FROM NEW."type"
     OR catalog_contract."serviceCurrency" <> 'USD'
     OR catalog_contract."listingCurrency" <> 'USD'
     OR catalog_contract."availability" <> 'AVAILABLE'
     OR catalog_contract."listingStatus" <> 'APPROVED'
     OR catalog_contract."isActive" IS DISTINCT FROM TRUE
     OR catalog_contract."verificationStatus" <> 'VERIFIED'
     OR NEW."fulfillmentChannel" IS DISTINCT FROM (
       CASE
       WHEN catalog_contract."ownerType" = 'PLATFORM'
         THEN 'PLATFORM'::"FulfillmentChannel"
       ELSE 'PUBLISHER'::"FulfillmentChannel"
       END
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order capture requires an approved verified catalog contract';
  END IF;

  SELECT COUNT(*)
    INTO catalog_price_mismatch_count
  FROM "OrderItem" item
  WHERE item."orderId" = NEW."id"
    AND item."price" IS DISTINCT FROM catalog_contract."price";

  IF catalog_price_mismatch_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order capture item prices do not match the selected catalog service';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Order_capture_items_guard"
  BEFORE INSERT OR UPDATE OF "paymentStatus", "amount", "websiteId" ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION "assert_order_capture_items"();

-- Cart rows may change only while the parent is an unpaid draft. The parent
-- Order lock is acquired before deciding so item mutation and capture have one
-- deterministic winner. PURCHASE and Settlement evidence independently keep
-- the freeze closed even if a corrupt caller rewrites paymentStatus.
CREATE FUNCTION "guard_order_item_financial_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order_id TEXT;
  is_protected BOOLEAN;
BEGIN
  parent_order_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."orderId" ELSE OLD."orderId" END;

  PERFORM 1 FROM "Order" WHERE "id" = parent_order_id FOR UPDATE;

  IF TG_OP = 'UPDATE' AND NEW."orderId" IS DISTINCT FROM OLD."orderId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order item parent identity is immutable';
  END IF;

  SELECT (
    order_row."paymentStatus" = 'PAID'
    OR EXISTS (
      SELECT 1 FROM "Transaction" purchase
      WHERE purchase."orderId" = order_row."id"
        AND purchase."type" = 'PURCHASE'
    )
    OR EXISTS (
      SELECT 1 FROM "Settlement" settlement
      WHERE settlement."orderId" = order_row."id"
    )
  )
  INTO is_protected
  FROM "Order" order_row
  WHERE order_row."id" = parent_order_id;

  IF COALESCE(is_protected, FALSE) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order item identity is immutable after payment capture';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "OrderItem_financial_identity_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "OrderItem"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_order_item_financial_identity"();

-- Kept behind a helper so a later migration can add immutable resolution
-- evidence without replacing the entire settlement transition state machine.
CREATE FUNCTION "has_unresolved_delivery_fraud"(parent_order_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag"
    WHERE "orderId" = parent_order_id
  )
$$;

-- PlatformRevenue is immutable accounting evidence. A refund appends one
-- reversal timestamp; it never rewrites or deletes the recognition row. Every
-- insertion locks Order first, then proves the canonical settlement gate,
-- channel, amount, PURCHASE, and active singleton fee policy.
CREATE FUNCTION "guard_platform_revenue_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order RECORD;
  delivery RECORD;
  fee_policy RECORD;
  parent_order_id TEXT;
BEGIN
  parent_order_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."orderId" ELSE OLD."orderId" END;
  PERFORM 1 FROM "Order" WHERE "id" = parent_order_id FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue evidence is append-only; reverse it instead of deleting it';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."amount" IS DISTINCT FROM OLD."amount"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."platformFee" IS DISTINCT FROM OLD."platformFee"
       OR NEW."netRevenue" IS DISTINCT FROM OLD."netRevenue"
       OR NEW."platformFeeBps" IS DISTINCT FROM OLD."platformFeeBps"
       OR NEW."feePolicyVersion" IS DISTINCT FROM OLD."feePolicyVersion"
       OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt"
       OR NEW."listingServiceId" IS DISTINCT FROM OLD."listingServiceId"
       OR NEW."serviceType" IS DISTINCT FROM OLD."serviceType"
       OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
       OR NEW."fulfillmentChannel" IS DISTINCT FROM OLD."fulfillmentChannel"
       OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'platform revenue financial identity and policy evidence are immutable';
    END IF;
    IF OLD."reversedAt" IS NOT NULL
       AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'platform revenue reversal evidence is append-only';
    END IF;
    IF OLD."reversedAt" IS NULL
       AND NEW."reversedAt" IS NOT NULL
       AND NEW."reversedAt" < OLD."recordedAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'platform revenue reversal cannot predate recognition';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."reversedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue cannot originate in a reversed state';
  END IF;

  SELECT
    order_row."id",
    order_row."status",
    order_row."paymentStatus",
    order_row."amount",
    order_row."currency",
    order_row."organizationId",
    order_row."fulfillmentChannel",
    order_row."activeDeliveryVersionId"
  INTO parent_order
  FROM "Order" order_row
  WHERE order_row."id" = NEW."orderId";

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'platform revenue order does not exist';
  END IF;
  IF parent_order."status" <> 'DELIVERED'
     OR parent_order."paymentStatus" <> 'PAID'
     OR parent_order."currency" <> 'USD'
     OR NEW."currency" <> 'USD'
     OR NEW."amount" IS DISTINCT FROM parent_order."amount"
     OR parent_order."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM'
     OR NEW."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue identity does not match its paid delivered PLATFORM order';
  END IF;

  IF parent_order."activeDeliveryVersionId" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: no active delivery';
  END IF;
  SELECT
    version_row."orderId",
    version_row."verificationStatus",
    version_row."interventionStatus",
    version_row."supersededByVersion"
  INTO delivery
  FROM "OrderDeliveryVersion" version_row
  WHERE version_row."id" = parent_order."activeDeliveryVersionId";
  IF NOT FOUND OR delivery."orderId" <> NEW."orderId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active delivery identity mismatch';
  END IF;
  IF delivery."supersededByVersion" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active delivery is superseded';
  END IF;
  IF delivery."interventionStatus" = 'REJECTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active delivery was rejected';
  END IF;
  IF delivery."verificationStatus" <> 'VERIFIED'
     AND delivery."interventionStatus" NOT IN ('APPROVED', 'OVERRIDDEN') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active delivery is not verified';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "OrderDispute"
    WHERE "orderId" = NEW."orderId"
      AND "status" NOT IN ('RESOLVED_REJECTED', 'RESOLVED_RESTORED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: dispute is not settlement-safe';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "Revision"
    WHERE "orderId" = NEW."orderId"
      AND "status" NOT IN ('APPROVED', 'REJECTED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active revision';
  END IF;
  IF "has_unresolved_delivery_fraud"(NEW."orderId") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: unresolved fraud flag';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "OrderCancellationRequest"
    WHERE "orderId" = NEW."orderId"
      AND (
        "status" NOT IN ('REJECTED', 'WITHDRAWN', 'APPROVED')
        OR (
          "status" = 'APPROVED'
          AND "resolution" IS DISTINCT FROM 'CONTINUE_ORDER'
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue eligibility blocked: active cancellation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "Transaction" purchase
    JOIN "Wallet" wallet ON wallet."id" = purchase."walletId"
    WHERE purchase."orderId" = NEW."orderId"
      AND purchase."type" = 'PURCHASE'
      AND purchase."amount" = -NEW."amount"
      AND purchase."currency" = 'USD'
      AND purchase."publisherId" IS NULL
      AND purchase."settlementId" IS NULL
      AND purchase."provider" IS NULL
      AND purchase."providerRef" IS NULL
      AND wallet."currency" = 'USD'
      AND wallet."organizationId" IS NOT DISTINCT FROM parent_order."organizationId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue requires exact canonical purchase evidence';
  END IF;

  SELECT settings."id", settings."platformFeePct", settings."version"
  INTO fee_policy
  FROM "PlatformSettings" settings
  FOR SHARE;
  IF NOT FOUND
     OR NEW."platformFeeBps" IS NULL
     OR NEW."feePolicyVersion" IS NULL
     OR NEW."platformFeeBps" IS DISTINCT FROM (fee_policy."platformFeePct" * 100)::INTEGER
     OR NEW."feePolicyVersion" IS DISTINCT FROM format(
       'platform-settings:%s:v%s',
       fee_policy."id",
       fee_policy."version"
     )
     OR NEW."platformFee" IS DISTINCT FROM ROUND(
       NEW."amount" * fee_policy."platformFeePct" / 100,
       2
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'platform revenue fee split lacks the active versioned policy';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "PlatformRevenue_evidence_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "PlatformRevenue"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_platform_revenue_evidence"();

CREATE FUNCTION "assert_settlement_eligibility"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_order RECORD;
  delivery RECORD;
  admin_approval RECORD;
  latest_delivery_evidence RECORD;
  must_check BOOLEAN;
  fee_policy RECORD;
  website_publisher_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
    OR NEW."grossAmount" IS DISTINCT FROM OLD."grossAmount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."platformFee" IS DISTINCT FROM OLD."platformFee"
    OR NEW."publisherAmount" IS DISTINCT FROM OLD."publisherAmount"
    OR NEW."platformFeeBps" IS DISTINCT FROM OLD."platformFeeBps"
    OR NEW."feePolicyVersion" IS DISTINCT FROM OLD."feePolicyVersion"
    OR NEW."reviewEndsAt" IS DISTINCT FROM OLD."reviewEndsAt"
    OR NEW."releasePolicy" IS DISTINCT FROM OLD."releasePolicy"
    OR NEW."listingServiceId" IS DISTINCT FROM OLD."listingServiceId"
    OR NEW."serviceType" IS DISTINCT FROM OLD."serviceType"
    OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
    OR NEW."fulfillmentChannel" IS DISTINCT FROM OLD."fulfillmentChannel"
    OR NEW."unitPrice" IS DISTINCT FROM OLD."unitPrice"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement financial identity and policy snapshots are immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."status" = 'CANCELLED'
     AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cancelled settlement is terminal; create a new reviewed settlement instead';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."settledAt" IS NOT NULL
     AND NEW."settledAt" IS DISTINCT FROM OLD."settledAt" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release timestamp is append-only';
  END IF;
  IF NEW."settledAt" IS NOT NULL
     AND NEW."status" NOT IN ('RELEASED', 'CANCELLED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release timestamp requires a released or post-release cancelled state';
  END IF;
  IF TG_OP = 'INSERT'
     AND NEW."settledAt" IS NOT NULL
     AND NEW."status" <> 'RELEASED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release timestamp can only originate on a RELEASED transition';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."settledAt" IS NULL
     AND NEW."settledAt" IS NOT NULL
     AND NEW."status" <> 'RELEASED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release timestamp can only originate on a RELEASED transition';
  END IF;

  must_check :=
    TG_OP = 'INSERT'
    OR (
      TG_OP = 'UPDATE'
      AND (
        (OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED')
        OR (OLD."status" <> 'RELEASED' AND NEW."status" = 'RELEASED')
      )
    );

  IF NOT must_check THEN
    RETURN NEW;
  END IF;

  SELECT
    order_row."id",
    order_row."status",
    order_row."paymentStatus",
    order_row."currency",
    order_row."activeDeliveryVersionId",
    order_row."amount",
    order_row."websiteId"
  INTO parent_order
  FROM "Order" order_row
  WHERE order_row."id" = NEW."orderId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'settlement order does not exist';
  END IF;

  IF parent_order."status" <> 'DELIVERED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: order is not DELIVERED';
  END IF;
  IF parent_order."paymentStatus" <> 'PAID' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: order is not paid';
  END IF;
  IF parent_order."currency" <> 'USD' OR NEW."currency" <> parent_order."currency" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: currency is not exact USD';
  END IF;
  IF NEW."grossAmount" IS DISTINCT FROM parent_order."amount" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement identity blocked: gross amount does not match order';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "Transaction" purchase
    WHERE purchase."orderId" = NEW."orderId"
      AND purchase."type" = 'PURCHASE'
      AND purchase."walletId" IS NOT NULL
      AND purchase."currency" = 'USD'
      AND purchase."amount" = -NEW."grossAmount"
      AND purchase."publisherId" IS NULL
      AND purchase."settlementId" IS NULL
      AND purchase."provider" IS NULL
      AND purchase."providerRef" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: exact purchase ledger evidence is missing';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
      settings."id",
      settings."platformFeePct",
      settings."version"
    INTO fee_policy
    FROM "PlatformSettings" settings
    FOR SHARE;
    IF NOT FOUND
       OR NEW."platformFeeBps" IS NULL
       OR NEW."feePolicyVersion" IS NULL
       OR NEW."platformFeeBps" IS DISTINCT FROM (fee_policy."platformFeePct" * 100)::INTEGER
       OR NEW."feePolicyVersion" IS DISTINCT FROM format(
         'platform-settings:%s:v%s',
         fee_policy."id",
         fee_policy."version"
       )
       OR NEW."platformFee" IS DISTINCT FROM ROUND(
         NEW."grossAmount" * fee_policy."platformFeePct" / 100,
         2
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement identity blocked: fee split lacks the active versioned policy';
    END IF;
  END IF;

  -- Publisher liability is derived only from the canonical Website referenced
  -- by the locked Order. OrderItem is immutable after capture but is not the
  -- accounting attribution source. The share lock closes a concurrent website
  -- reassignment race during insertion; later reassignments do not rewrite the
  -- already-frozen settlement publisher.
  IF TG_OP = 'INSERT' THEN
    SELECT website."publisherId" INTO website_publisher_id
    FROM "Website" website
    WHERE website."id" = parent_order."websiteId"
    FOR SHARE;
    IF NOT FOUND
       OR website_publisher_id IS NULL
       OR NEW."publisherId" IS DISTINCT FROM website_publisher_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement identity blocked: publisher does not match order website';
    END IF;
  END IF;

  -- A cancelled row remains immutable evidence but carries no payable state.
  IF NEW."status" = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  IF parent_order."activeDeliveryVersionId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: no active delivery';
  END IF;

  SELECT
    version_row."orderId",
    version_row."verificationStatus",
    version_row."interventionStatus",
    version_row."supersededByVersion"
  INTO delivery
  FROM "OrderDeliveryVersion" version_row
  WHERE version_row."id" = parent_order."activeDeliveryVersionId";

  IF NOT FOUND OR delivery."orderId" <> NEW."orderId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active delivery identity mismatch';
  END IF;
  IF delivery."supersededByVersion" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active delivery is superseded';
  END IF;
  IF delivery."interventionStatus" = 'REJECTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active delivery was rejected';
  END IF;
  IF delivery."verificationStatus" <> 'VERIFIED'
     AND delivery."interventionStatus" NOT IN ('APPROVED', 'OVERRIDDEN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active delivery is not verified';
  END IF;

  -- Every release carries durable ADMIN approval evidence. That row also
  -- distinguishes an automated system release from the separately-authorized
  -- human path without trusting a mutable process-local flag.
  IF NEW."status" = 'RELEASED' THEN
    SELECT approval."approvedBy", approval."roleAtTime"
    INTO admin_approval
    FROM "SettlementApproval" approval
    WHERE approval."settlementId" = NEW."id"
      AND approval."type" = 'ADMIN';

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement release blocked: admin approval evidence is missing';
    END IF;

    IF admin_approval."approvedBy" = 'SYSTEM_AUTO_RELEASE'
       OR admin_approval."roleAtTime" = 'SYSTEM' THEN
      IF admin_approval."approvedBy" <> 'SYSTEM_AUTO_RELEASE'
         OR admin_approval."roleAtTime" <> 'SYSTEM'
         OR NEW."releasePolicy" <> 'AUTO' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'automated settlement release blocked: system approval identity is invalid';
      END IF;

      -- The hold sweep runs every six hours. One missed-run margin is allowed,
      -- but automated money release requires the newest immutable observation
      -- for the currently-active delivery to be no more than twelve hours old.
      -- Selecting a future-dated newest row and rejecting it prevents an older
      -- success from being used as a fallback.
      SELECT
        evidence."checkedAt",
        evidence."createdAt",
        evidence."httpStatus",
        evidence."linkFound",
        evidence."targetUrlMatched",
        evidence."anchorFound"
      INTO latest_delivery_evidence
      FROM "DeliveryVerificationEvidence" evidence
      WHERE evidence."deliveryVersionId" = parent_order."activeDeliveryVersionId"
      ORDER BY evidence."checkedAt" DESC,
               evidence."createdAt" DESC,
               evidence."id" DESC
      LIMIT 1;

      IF NOT FOUND
         OR latest_delivery_evidence."checkedAt" < NEW."settledAt" - INTERVAL '12 hours'
         OR latest_delivery_evidence."checkedAt" > NEW."settledAt"
         OR latest_delivery_evidence."createdAt" > NEW."settledAt"
         OR latest_delivery_evidence."httpStatus" NOT IN (200, 301, 302)
         OR NOT latest_delivery_evidence."linkFound"
         OR NOT latest_delivery_evidence."targetUrlMatched"
         OR NOT latest_delivery_evidence."anchorFound" THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'automated settlement release blocked: fresh successful link-recheck evidence is missing';
      END IF;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "OrderDispute"
    WHERE "orderId" = NEW."orderId"
      AND "status" NOT IN ('RESOLVED_REJECTED', 'RESOLVED_RESTORED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: dispute is not settlement-safe';
  END IF;

  -- Terminal allowlist: new revision states fail closed automatically.
  IF EXISTS (
    SELECT 1 FROM "Revision"
    WHERE "orderId" = NEW."orderId" AND "status" NOT IN ('APPROVED', 'REJECTED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active revision';
  END IF;

  IF "has_unresolved_delivery_fraud"(NEW."orderId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: unresolved fraud flag';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "OrderCancellationRequest"
    WHERE "orderId" = NEW."orderId"
      AND (
        "status" NOT IN ('REJECTED', 'WITHDRAWN', 'APPROVED')
        OR (
          "status" = 'APPROVED'
          AND "resolution" IS DISTINCT FROM 'CONTINUE_ORDER'
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement eligibility blocked: active cancellation';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Settlement_eligibility_guard"
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW
  EXECUTE FUNCTION "assert_settlement_eligibility"();

-- Once a settlement exists, the Order remains operationally transitionable,
-- but the contract fields that define liability and publisher attribution are
-- frozen. This also makes the amount check above durable after insertion.
CREATE FUNCTION "guard_order_settlement_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."websiteId" IS DISTINCT FROM OLD."websiteId"
    OR NEW."listingId" IS DISTINCT FROM OLD."listingId"
    OR NEW."listingServiceId" IS DISTINCT FROM OLD."listingServiceId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."fulfillmentChannel" IS DISTINCT FROM OLD."fulfillmentChannel"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
  ) AND (
    OLD."paymentStatus" = 'PAID'
    OR EXISTS (
      SELECT 1 FROM "Transaction" purchase
      WHERE purchase."orderId" = OLD."id" AND purchase."type" = 'PURCHASE'
    )
    OR EXISTS (
      SELECT 1 FROM "Settlement" settlement
      WHERE settlement."orderId" = OLD."id"
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order financial and publisher-attribution snapshot is immutable after payment capture';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Order_settlement_identity_guard"
  BEFORE UPDATE ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_order_settlement_identity"();

-- A Website publisher/ownership transfer is a reviewed accounting operation,
-- not a generic row update. Once any Order references the Website, changing
-- those fields could redirect a future liability. Freeze them until a durable
-- Order.publisherId snapshot and explicit transfer workflow are introduced.
CREATE FUNCTION "guard_ordered_website_publisher_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
    OR NEW."ownershipType" IS DISTINCT FROM OLD."ownershipType"
  ) AND EXISTS (
    SELECT 1 FROM "Order" order_row WHERE order_row."websiteId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'website publisher and ownership identity is immutable after order creation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Website_ordered_publisher_identity_guard"
  BEFORE UPDATE OF "publisherId", "ownershipType" ON "Website"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_ordered_website_publisher_identity"();

CREATE FUNCTION "lock_order_website_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."websiteId" IS NOT NULL THEN
    PERFORM 1 FROM "Website" WHERE "id" = NEW."websiteId" FOR SHARE;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Order_website_identity_lock"
  BEFORE INSERT OR UPDATE OF "websiteId" ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION "lock_order_website_identity"();

CREATE FUNCTION "forbid_settlement_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'settlement evidence is append-only; cancel it instead of deleting it';
END
$$;

CREATE TRIGGER "Settlement_delete_guard"
  BEFORE DELETE ON "Settlement"
  FOR EACH ROW
  EXECUTE FUNCTION "forbid_settlement_delete"();

-- Release ledger rows are immutable evidence and must match the frozen
-- settlement identity exactly. The deferred pair checks allow the application
-- to write settlement state and ledger in either order inside one transaction,
-- while making a partial direct-SQL release impossible to commit.
CREATE FUNCTION "guard_settlement_release_ledger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent "Settlement"%ROWTYPE;
  parent_order_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'SETTLEMENT_RELEASE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement release ledger evidence is append-only';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD."type" = 'SETTLEMENT_RELEASE' OR NEW."type" = 'SETTLEMENT_RELEASE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'settlement release ledger evidence is insert-only and append-only';
  END IF;

  IF NEW."type" = 'SETTLEMENT_RELEASE' THEN
    IF NEW."walletId" IS NOT NULL
       OR NEW."provider" IS NOT NULL
       OR NEW."providerRef" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'settlement release ledger cannot carry wallet or provider identity';
    END IF;
    IF NEW."settlementId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement release ledger requires a settlement';
    END IF;

    -- Preserve the canonical Order -> Settlement -> ledger lock order even if
    -- a direct writer inserts the deferred ledger pair before changing status.
    SELECT "orderId" INTO parent_order_id
    FROM "Settlement"
    WHERE "id" = NEW."settlementId";
    IF parent_order_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement release ledger identity does not match its settlement';
    END IF;
    PERFORM 1 FROM "Order" WHERE "id" = parent_order_id FOR UPDATE;
    SELECT * INTO parent
    FROM "Settlement"
    WHERE "id" = NEW."settlementId"
    FOR UPDATE;
    IF NOT FOUND
       OR parent."orderId" IS DISTINCT FROM parent_order_id
       OR NEW."amount" IS DISTINCT FROM parent."publisherAmount"
       OR NEW."currency" IS DISTINCT FROM parent."currency"
       OR NEW."orderId" IS DISTINCT FROM parent."orderId"
       OR NEW."publisherId" IS DISTINCT FROM parent."publisherId"
       OR NEW."walletId" IS NOT NULL
       OR NEW."provider" IS NOT NULL
       OR NEW."providerRef" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement release ledger identity does not match its settlement';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Transaction_settlement_release_evidence_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Transaction"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_settlement_release_ledger"();

CREATE FUNCTION "require_settlement_release_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
      NEW."status" = 'RELEASED'
      OR (NEW."status" = 'CANCELLED' AND NEW."settledAt" IS NOT NULL)
    )
    AND (
      NEW."settledAt" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "Transaction" ledger
        WHERE ledger."settlementId" = NEW."id"
          AND ledger."type" = 'SETTLEMENT_RELEASE'
          AND ledger."amount" = NEW."publisherAmount"
          AND ledger."currency" = NEW."currency"
          AND ledger."orderId" = NEW."orderId"
          AND ledger."publisherId" = NEW."publisherId"
      )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'released settlement requires matching release ledger evidence';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Settlement_release_evidence_required"
  AFTER INSERT OR UPDATE ON "Settlement"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "require_settlement_release_evidence"();

CREATE FUNCTION "require_released_settlement_for_ledger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."type" = 'SETTLEMENT_RELEASE' AND NOT EXISTS (
    SELECT 1 FROM "Settlement" settlement
    WHERE settlement."id" = NEW."settlementId"
      AND (
        settlement."status" = 'RELEASED'
        OR (
          settlement."status" = 'CANCELLED'
          AND settlement."settledAt" IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement release ledger requires a released settlement';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Transaction_released_settlement_required"
  AFTER INSERT OR UPDATE ON "Transaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."type" = 'SETTLEMENT_RELEASE')
  EXECUTE FUNCTION "require_released_settlement_for_ledger"();

COMMIT;
