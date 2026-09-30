-- Force-cancel compensation is allocated from the captured order payment.
-- Preserve legacy non-force-cancel refund-plus-compensation decisions, while
-- preventing force-cancel writers from paying out more than the order gross.
CREATE OR REPLACE FUNCTION "guard_publisher_compensation_evidence"()
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
  force_cancel_reference BOOLEAN;
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
  force_cancel_reference := FOUND
    AND refund_row."reference" IS NOT NULL
    AND left(
      refund_row."reference",
      length('force-cancel:' || NEW."orderId" || ':')
    ) = 'force-cancel:' || NEW."orderId" || ':';

  IF NOT FOUND
    OR refund_row."type"::TEXT IS DISTINCT FROM 'REFUND'
    OR refund_row."orderId" IS DISTINCT FROM NEW."orderId"
    OR refund_row."currency" IS DISTINCT FROM NEW."currency"
    OR (
      force_cancel_reference
      AND (refund_row."amount" + NEW."amount") IS DISTINCT FROM order_row.amount
    )
    OR (
      NOT force_cancel_reference
      AND refund_row."amount" IS DISTINCT FROM order_row.amount
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Publisher compensation refund transaction does not conserve captured order value';
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
        MESSAGE = 'Publisher compensation debt-repayment transaction evidence is invalid';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
