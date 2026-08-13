-- Record cancellation-driven reservation releases without treating the
-- available/reserved bucket transfer as new wallet cash.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

LOCK TABLE
  public."Transaction",
  public."Order",
  public."OrderEvent",
  public."Wallet"
IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."Transaction" reservation
    WHERE reservation."type" = 'RESERVATION'
      AND reservation."orderId" IS NOT NULL
    GROUP BY reservation."orderId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release migration blocked: duplicate order reservations exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."Transaction" reservation
    WHERE reservation."type" = 'RESERVATION'
      AND reservation."orderId" IS NOT NULL
      AND (
        reservation."walletId" IS NULL
        OR reservation."publisherId" IS NOT NULL
        OR reservation."settlementId" IS NOT NULL
        OR reservation."provider" IS NOT NULL
        OR reservation."providerRef" IS NOT NULL
        OR reservation."currency" <> 'USD'
        OR reservation."amount" >= 0
        OR reservation."amount" * 100 <> TRUNC(reservation."amount" * 100)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release migration blocked: order reservation identity is invalid';
  END IF;
END;
$$;

CREATE UNIQUE INDEX "Transaction_reservation_release_order_unique"
  ON public."Transaction"("orderId")
  WHERE "type" = 'RELEASE'::public."TransactionType" AND "orderId" IS NOT NULL;

CREATE UNIQUE INDEX "Transaction_reservation_order_unique"
  ON public."Transaction"("orderId")
  WHERE "type" = 'RESERVATION'::public."TransactionType" AND "orderId" IS NOT NULL;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_reservation_release_identity_check" CHECK (
    "type"::TEXT <> 'RELEASE'
    OR (
      "walletId" IS NOT NULL
      AND "orderId" IS NOT NULL
      AND "publisherId" IS NULL
      AND "settlementId" IS NULL
      AND "provider" IS NULL
      AND "providerRef" IS NULL
      AND "currency" = 'USD'
      AND "amount" > 0
      AND "amount" * 100 = TRUNC("amount" * 100)
      AND "reference" = 'reservation-release:' || "orderId"
    )
  );

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_order_reservation_identity_check" CHECK (
    "type"::TEXT <> 'RESERVATION'
    OR "orderId" IS NULL
    OR (
      "walletId" IS NOT NULL
      AND "publisherId" IS NULL
      AND "settlementId" IS NULL
      AND "provider" IS NULL
      AND "providerRef" IS NULL
      AND "currency" = 'USD'
      AND "amount" < 0
      AND "amount" * 100 = TRUNC("amount" * 100)
    )
  );

CREATE FUNCTION public."guard_reservation_release_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  total_reservation_count BIGINT;
  reservation_count BIGINT;
  purchase_count BIGINT;
  reservation_id TEXT;
  order_status TEXT;
  payment_status TEXT;
  order_organization_id TEXT;
  wallet_organization_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' AND OLD."type" = 'RELEASE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release evidence is append-only';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (OLD."type" = 'RELEASE' OR NEW."type" = 'RELEASE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release evidence is immutable';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD."type" = 'RESERVATION'
     AND EXISTS (
       SELECT 1
       FROM "Transaction" release
       WHERE release."type" = 'RELEASE'
         AND release."orderId" = OLD."orderId"
         AND release."walletId" = OLD."walletId"
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'released reservation evidence is immutable';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW."type" = 'RESERVATION'
     AND EXISTS (
       SELECT 1
       FROM "Transaction" release
       WHERE release."type" = 'RELEASE'
         AND release."orderId" = NEW."orderId"
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'cancelled order cannot acquire another reservation';
  END IF;
  IF TG_OP <> 'INSERT' OR NEW."type" <> 'RELEASE' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE ledger."type" = 'RESERVATION'),
    COUNT(*) FILTER (
      WHERE ledger."type" = 'RESERVATION'
        AND ledger."amount" = -NEW."amount"
        AND ledger."currency" = NEW."currency"
        AND ledger."publisherId" IS NULL
        AND ledger."settlementId" IS NULL
        AND ledger."provider" IS NULL
        AND ledger."providerRef" IS NULL
    ),
    COUNT(*) FILTER (WHERE ledger."type" = 'PURCHASE'),
    MIN(ledger."id") FILTER (WHERE ledger."type" = 'RESERVATION')
  INTO total_reservation_count, reservation_count, purchase_count, reservation_id
  FROM "Transaction" ledger
  WHERE ledger."orderId" = NEW."orderId"
    AND ledger."walletId" = NEW."walletId"
    AND ledger."type" IN ('RESERVATION', 'PURCHASE', 'RELEASE');

  IF total_reservation_count <> 1
     OR reservation_count <> 1
     OR purchase_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release requires one exact unconsumed reservation';
  END IF;
  PERFORM 1 FROM "Transaction" WHERE "id" = reservation_id FOR SHARE;

  SELECT "status"::TEXT, "paymentStatus"::TEXT, "organizationId"
    INTO order_status, payment_status, order_organization_id
  FROM "Order"
  WHERE "id" = NEW."orderId"
  FOR SHARE;
  SELECT "organizationId" INTO wallet_organization_id
  FROM "Wallet"
  WHERE "id" = NEW."walletId"
  FOR SHARE;
  IF order_status IS DISTINCT FROM 'PENDING_PAYMENT'
     OR payment_status IS DISTINCT FROM 'PENDING'
     OR order_organization_id IS NULL
     OR wallet_organization_id IS DISTINCT FROM order_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release does not match a pending order wallet';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Transaction_reservation_release_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON public."Transaction"
FOR EACH ROW EXECUTE FUNCTION public."guard_reservation_release_evidence"();

CREATE FUNCTION public."guard_reservation_release_wallet_identity"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1
    FROM public."Transaction" release
    WHERE release."type" = 'RELEASE'
      AND release."walletId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release wallet identity is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    ) AND EXISTS (
      SELECT 1
      FROM public."Transaction" release
      WHERE release."type" = 'RELEASE'
        AND release."walletId" IN (OLD."id", NEW."id")
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release wallet identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Wallet_reservation_release_identity_guard"
BEFORE UPDATE OR DELETE ON public."Wallet"
FOR EACH ROW EXECUTE FUNCTION public."guard_reservation_release_wallet_identity"();

-- Prove both directions of the evidence chain at commit. The RELEASE insert is
-- not the only mutation that can invalidate the invariant: a later Order,
-- OrderEvent, or source RESERVATION update must re-run the same assertion.
CREATE FUNCTION public."assert_reservation_release_integrity"(target_order_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  release_count BIGINT;
  release_row RECORD;
  order_row RECORD;
  wallet_organization_id TEXT;
  reservation_count BIGINT;
  exact_reservation_count BIGINT;
  purchase_count BIGINT;
  cancellation_event_count BIGINT;
BEGIN
  IF target_order_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COUNT(*)
  INTO release_count
  FROM "Transaction" release
  WHERE release."orderId" = target_order_id
    AND release."type" = 'RELEASE';
  IF release_count = 0 THEN
    RETURN;
  END IF;
  IF release_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'cancelled order requires one exact reservation release';
  END IF;

  SELECT release.*
  INTO STRICT release_row
  FROM "Transaction" release
  WHERE release."orderId" = target_order_id
    AND release."type" = 'RELEASE';

  SELECT
    order_value."status"::TEXT AS status,
    order_value."paymentStatus"::TEXT AS payment_status,
    order_value."organizationId" AS organization_id
  INTO order_row
  FROM "Order" order_value
  WHERE order_value."id" = target_order_id;

  SELECT wallet."organizationId"
  INTO wallet_organization_id
  FROM "Wallet" wallet
  WHERE wallet."id" = release_row."walletId";

  SELECT
    COUNT(*) FILTER (WHERE ledger."type" = 'RESERVATION'),
    COUNT(*) FILTER (
      WHERE ledger."type" = 'RESERVATION'
        AND ledger."walletId" = release_row."walletId"
        AND ledger."amount" = -release_row."amount"
        AND ledger."currency" = release_row."currency"
        AND ledger."publisherId" IS NULL
        AND ledger."settlementId" IS NULL
        AND ledger."provider" IS NULL
        AND ledger."providerRef" IS NULL
    ),
    COUNT(*) FILTER (WHERE ledger."type" = 'PURCHASE')
  INTO reservation_count, exact_reservation_count, purchase_count
  FROM "Transaction" ledger
  WHERE ledger."orderId" = target_order_id;

  SELECT COUNT(*)
  INTO cancellation_event_count
  FROM "OrderEvent" event
  WHERE event."orderId" = target_order_id
    AND event."eventType" = 'ORDER_CANCELLED'
    AND event."metadata"->>'reservationReleaseTransactionId' = release_row."id";

  IF order_row IS NULL
     OR order_row.status IS DISTINCT FROM 'CANCELLED'
     OR order_row.payment_status IS DISTINCT FROM 'PENDING'
     OR wallet_organization_id IS NULL
     OR wallet_organization_id IS DISTINCT FROM order_row.organization_id
     OR reservation_count <> 1
     OR exact_reservation_count <> 1
     OR purchase_count <> 0
     OR cancellation_event_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reservation release requires exact terminal order, wallet, source reservation, and event evidence';
  END IF;
END;
$$;

CREATE FUNCTION public."require_reservation_release_completion"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_order_id TEXT;
  new_order_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Transaction' THEN
    IF TG_OP IN ('UPDATE', 'DELETE')
       AND OLD."type" IN ('RESERVATION', 'PURCHASE', 'RELEASE') THEN
      old_order_id := OLD."orderId";
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE')
       AND NEW."type" IN ('RESERVATION', 'PURCHASE', 'RELEASE') THEN
      new_order_id := NEW."orderId";
    END IF;
  ELSIF TG_TABLE_NAME = 'Order' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      old_order_id := OLD."id";
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      new_order_id := NEW."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'OrderEvent' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."eventType" = 'ORDER_CANCELLED' THEN
      old_order_id := OLD."orderId";
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."eventType" = 'ORDER_CANCELLED' THEN
      new_order_id := NEW."orderId";
    END IF;
  END IF;

  PERFORM public."assert_reservation_release_integrity"(old_order_id);
  IF new_order_id IS DISTINCT FROM old_order_id THEN
    PERFORM public."assert_reservation_release_integrity"(new_order_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "Transaction_reservation_release_commit_guard"
AFTER INSERT OR UPDATE OR DELETE ON public."Transaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."require_reservation_release_completion"();

CREATE CONSTRAINT TRIGGER "Order_reservation_release_commit_guard"
AFTER INSERT OR UPDATE OR DELETE ON public."Order"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."require_reservation_release_completion"();

CREATE CONSTRAINT TRIGGER "OrderEvent_reservation_release_commit_guard"
AFTER INSERT OR UPDATE OR DELETE ON public."OrderEvent"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."require_reservation_release_completion"();

COMMIT;
