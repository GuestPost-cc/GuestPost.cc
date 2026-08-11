-- Serialize normalized delivery-URL claim mutations with acceptance and
-- settlement eligibility checks, including during a rolling deploy where an
-- older application pod does not yet take the application advisory lock.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

LOCK TABLE public."OrderDeliveryVersion" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."OrderDeliveryVersion"
    WHERE "normalizedUrl" IS NULL OR LENGTH(BTRIM("normalizedUrl")) = 0
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery URL claim fence migration blocked: empty normalized URL exists';
  END IF;
END
$$;

CREATE TABLE public."DeliveryUrlClaimFence" (
  "normalizedUrl" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "DeliveryUrlClaimFence_pkey" PRIMARY KEY ("normalizedUrl"),
  CONSTRAINT "DeliveryUrlClaimFence_version_check" CHECK ("version" >= 0)
);

INSERT INTO public."DeliveryUrlClaimFence" ("normalizedUrl", "version")
SELECT DISTINCT "normalizedUrl", 0
FROM public."OrderDeliveryVersion";

-- The row fence is essential under PostgreSQL SERIALIZABLE isolation. An
-- advisory-lock waiter keeps its original MVCC snapshot; locking a fence row
-- changed after that snapshot forces SQLSTATE 40001 and a fresh retry instead
-- of allowing a stale claim-set decision to commit.
CREATE FUNCTION public."acquire_delivery_url_claim_fence"(claim_url TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  claim_lock_key BIGINT;
BEGIN
  IF claim_url IS NULL OR LENGTH(BTRIM(claim_url)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery URL claim requires a normalized URL';
  END IF;

  claim_lock_key := hashtextextended(claim_url, 6182047);
  PERFORM pg_advisory_xact_lock(claim_lock_key);

  INSERT INTO public."DeliveryUrlClaimFence" ("normalizedUrl", "version")
  VALUES (claim_url, 0)
  ON CONFLICT ("normalizedUrl") DO NOTHING;

  PERFORM "version"
  FROM public."DeliveryUrlClaimFence"
  WHERE "normalizedUrl" = claim_url
  FOR UPDATE;

  -- Prisma's query protocol cannot deserialize PostgreSQL's pseudo-type
  -- void. Return an explicit scalar so application callers can execute this
  -- lock through a parameterized query without unsafe SQL or driver-specific
  -- behavior; trigger callers deliberately discard the value with PERFORM.
  RETURN TRUE;
END
$$;

CREATE FUNCTION public."fence_delivery_url_claim_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  old_lock_key BIGINT;
  new_lock_key BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD."normalizedUrl" IS NULL OR LENGTH(BTRIM(OLD."normalizedUrl")) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery URL claim requires a normalized URL';
    END IF;
    old_lock_key := hashtextextended(OLD."normalizedUrl", 6182047);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW."normalizedUrl" IS NULL OR LENGTH(BTRIM(NEW."normalizedUrl")) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery URL claim requires a normalized URL';
    END IF;
    new_lock_key := hashtextextended(NEW."normalizedUrl", 6182047);
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public."acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public."acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
  ELSIF old_lock_key = new_lock_key THEN
    PERFORM public."acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSIF old_lock_key < new_lock_key THEN
    PERFORM public."acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
    PERFORM public."acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSE
    PERFORM public."acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
    PERFORM public."acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
  END IF;

  IF TG_OP <> 'INSERT' THEN
    UPDATE public."DeliveryUrlClaimFence"
    SET "version" = "version" + 1
    WHERE "normalizedUrl" = OLD."normalizedUrl";
  END IF;
  IF TG_OP <> 'DELETE'
     AND (TG_OP <> 'UPDATE' OR NEW."normalizedUrl" IS DISTINCT FROM OLD."normalizedUrl") THEN
    UPDATE public."DeliveryUrlClaimFence"
    SET "version" = "version" + 1
    WHERE "normalizedUrl" = NEW."normalizedUrl";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- PostgreSQL grants function execution to PUBLIC by default. The application
-- call surface is provisioned explicitly for each restricted runtime role
-- after migration; the trigger function is never a direct runtime surface.
REVOKE ALL ON TABLE public."DeliveryUrlClaimFence" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."acquire_delivery_url_claim_fence"(text)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."fence_delivery_url_claim_mutation"()
  FROM PUBLIC;

-- The pre-existing settlement-blocker trigger uses unqualified application
-- objects. Pin public before pg_temp so a caller-controlled temporary table
-- cannot redirect the trigger while preserving its historical function body.
ALTER FUNCTION public."lock_settlement_blocker_order"()
  SET search_path = pg_catalog, public, pg_temp;

-- PostgreSQL executes same-kind triggers in name order. The existing
-- OrderDeliveryVersion_settlement_order_lock trigger sorts first and locks the
-- parent Order, so every writer follows the same Order -> URL lock order as
-- current application acceptance and settlement boundaries.
CREATE TRIGGER "OrderDeliveryVersion_url_claim_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON public."OrderDeliveryVersion"
  FOR EACH ROW
  EXECUTE FUNCTION public."fence_delivery_url_claim_mutation"();

COMMIT;
