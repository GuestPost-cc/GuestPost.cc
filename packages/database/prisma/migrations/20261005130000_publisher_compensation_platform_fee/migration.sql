BEGIN;

ALTER TABLE public."PublisherCompensation"
  ADD COLUMN "platformFeeAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN "platformFeeBps" INTEGER,
  ADD COLUMN "platformFeePolicyVersion" VARCHAR(128),
  ADD CONSTRAINT "PublisherCompensation_platformFeeAmount_check" CHECK (
    "platformFeeAmount" >= 0
    AND "platformFeeAmount" * 100 = TRUNC("platformFeeAmount" * 100)
  ),
  ADD CONSTRAINT "PublisherCompensation_platformFeePolicy_check" CHECK (
    ("platformFeeBps" IS NULL AND "platformFeePolicyVersion" IS NULL)
    OR (
      "platformFeeBps" BETWEEN 0 AND 10000
      AND "platformFeePolicyVersion" IS NOT NULL
      AND LENGTH(BTRIM("platformFeePolicyVersion")) BETWEEN 1 AND 128
    )
  );

CREATE OR REPLACE FUNCTION public.guard_publisher_compensation_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  order_row RECORD;
  refund_row public."Transaction"%ROWTYPE;
  credit_row public."Transaction"%ROWTYPE;
  debt_row public."Transaction"%ROWTYPE;
  force_cancel_reference BOOLEAN;
  cancellation_reference BOOLEAN;
  offset_reference BOOLEAN;
  refund_found BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Publisher compensation evidence is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
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
    settlement."id" AS settlement_id,
    settlement."grossAmount" AS settlement_gross,
    settlement."publisherAmount" AS settlement_publisher_amount,
    settlement."platformFee" AS settlement_platform_fee,
    settlement."platformFeeBps" AS settlement_fee_bps,
    settlement."feePolicyVersion" AS settlement_fee_policy_version
  INTO order_row
  FROM public."Order" order_value
  LEFT JOIN public."Website" website ON website."id" = order_value."websiteId"
  LEFT JOIN LATERAL (
    SELECT
      settlement_value."id",
      settlement_value."publisherId",
      settlement_value."grossAmount",
      settlement_value."publisherAmount",
      settlement_value."platformFee",
      settlement_value."platformFeeBps",
      settlement_value."feePolicyVersion"
    FROM public."Settlement" settlement_value
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
    OR order_row.publisher_id IS DISTINCT FROM NEW."publisherId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Publisher compensation does not match the terminal refunded publisher order';
  END IF;

  SELECT * INTO refund_row
  FROM public."Transaction"
  WHERE "id" = NEW."refundTransactionId";
  refund_found := FOUND;
  force_cancel_reference := refund_found
    AND refund_row."reference" IS NOT NULL
    AND left(refund_row."reference", length('force-cancel:' || NEW."orderId" || ':'))
      = 'force-cancel:' || NEW."orderId" || ':';
  cancellation_reference := refund_found
    AND refund_row."reference" IS NOT NULL
    AND left(refund_row."reference", length('cancellation-request:'))
      = 'cancellation-request:';
  offset_reference := force_cancel_reference OR cancellation_reference;

  -- Preserve the historical publisher-allocation cap for refund paths that do
  -- not offset publisher compensation from the customer refund.
  IF NOT offset_reference AND NEW."amount" > COALESCE(
    order_row.settlement_publisher_amount, order_row.amount
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Publisher compensation exceeds the order publisher allocation';
  END IF;

  IF NOT refund_found
    OR refund_row."type"::TEXT IS DISTINCT FROM 'REFUND'
    OR refund_row."orderId" IS DISTINCT FROM NEW."orderId"
    OR refund_row."currency" IS DISTINCT FROM NEW."currency"
    OR NEW."platformFeeAmount" > order_row.amount
    OR (
      NEW."amount" > 0
      AND offset_reference
      AND (
        NEW."platformFeeBps" IS NULL
        OR NEW."platformFeePolicyVersion" IS NULL
        OR NEW."amount" > order_row.amount - NEW."platformFeeAmount"
        OR NEW."platformFeeAmount" IS DISTINCT FROM ROUND(
          order_row.amount * NEW."platformFeeBps"::NUMERIC / 10000, 2
        )
      )
    )
    OR (
      NEW."amount" = 0
      AND offset_reference
      AND (NEW."platformFeeAmount" <> 0 OR NEW."platformFeeBps" IS NOT NULL
        OR NEW."platformFeePolicyVersion" IS NOT NULL)
    )
    OR (
      NEW."amount" > 0 AND offset_reference
      AND NOT (
        COALESCE(
          order_row.settlement_gross = order_row.amount
          AND order_row.settlement_publisher_amount + order_row.settlement_platform_fee
            = order_row.amount
          AND NEW."platformFeeAmount" = order_row.settlement_platform_fee
          AND NEW."platformFeeBps" = order_row.settlement_fee_bps
          AND NEW."platformFeePolicyVersion" = order_row.settlement_fee_policy_version,
          FALSE
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public."PlatformSettings" settings
        WHERE NEW."platformFeeBps" = (settings."platformFeePct" * 100)::INTEGER
          AND NEW."platformFeeAmount" = ROUND(
            order_row.amount * settings."platformFeePct" / 100, 2
          )
          AND NEW."platformFeePolicyVersion" =
            'platform-settings:' || settings."id" || ':v' || settings."version"::TEXT
        FOR SHARE
      )
    )
    OR order_row.amount IS NULL
    OR (
      offset_reference
      AND refund_row."amount" + NEW."amount" + NEW."platformFeeAmount"
        IS DISTINCT FROM order_row.amount
    )
    OR (
      NOT offset_reference
      AND (
        NEW."platformFeeAmount" <> 0
        OR NEW."platformFeeBps" IS NOT NULL
        OR NEW."platformFeePolicyVersion" IS NOT NULL
        OR refund_row."amount" IS DISTINCT FROM order_row.amount
      )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Publisher compensation, platform fee, and customer refund do not match the approved order allocation';
  END IF;

  IF NEW."compensationTransactionId" IS NOT NULL THEN
    SELECT * INTO credit_row FROM public."Transaction"
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
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Publisher compensation credit transaction evidence is invalid';
    END IF;
  END IF;

  IF NEW."debtRepaymentTransactionId" IS NOT NULL THEN
    SELECT * INTO debt_row FROM public."Transaction"
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
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Publisher compensation debt-repayment transaction evidence is invalid';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

COMMIT;
