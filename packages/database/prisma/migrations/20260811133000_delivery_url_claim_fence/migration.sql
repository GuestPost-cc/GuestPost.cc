-- Serialize normalized delivery-URL claim mutations with acceptance and
-- settlement eligibility checks, including during a rolling deploy where an
-- older application pod does not yet take the application advisory lock.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "OrderDeliveryVersion" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OrderDeliveryVersion"
    WHERE "normalizedUrl" IS NULL OR LENGTH("normalizedUrl") = 0
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery URL claim fence migration blocked: empty normalized URL exists';
  END IF;
END
$$;

CREATE TABLE "DeliveryUrlClaimFence" (
  "normalizedUrl" TEXT NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "DeliveryUrlClaimFence_pkey" PRIMARY KEY ("normalizedUrl"),
  CONSTRAINT "DeliveryUrlClaimFence_version_check" CHECK ("version" >= 0)
);

INSERT INTO "DeliveryUrlClaimFence" ("normalizedUrl", "version")
SELECT DISTINCT "normalizedUrl", 0
FROM "OrderDeliveryVersion";

-- The row fence is essential under PostgreSQL SERIALIZABLE isolation. An
-- advisory-lock waiter keeps its original MVCC snapshot; locking a fence row
-- changed after that snapshot forces SQLSTATE 40001 and a fresh retry instead
-- of allowing a stale claim-set decision to commit.
CREATE FUNCTION "acquire_delivery_url_claim_fence"(claim_url TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  claim_lock_key BIGINT;
BEGIN
  IF claim_url IS NULL OR LENGTH(claim_url) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery URL claim requires a normalized URL';
  END IF;

  claim_lock_key := hashtextextended(claim_url, 6182047);
  PERFORM pg_advisory_xact_lock(claim_lock_key);

  INSERT INTO "DeliveryUrlClaimFence" ("normalizedUrl", "version")
  VALUES (claim_url, 0)
  ON CONFLICT ("normalizedUrl") DO NOTHING;

  PERFORM "version"
  FROM "DeliveryUrlClaimFence"
  WHERE "normalizedUrl" = claim_url
  FOR UPDATE;

  -- Prisma's query protocol cannot deserialize PostgreSQL's pseudo-type
  -- void. Return an explicit scalar so application callers can execute this
  -- lock through a parameterized query without unsafe SQL or driver-specific
  -- behavior; trigger callers deliberately discard the value with PERFORM.
  RETURN TRUE;
END
$$;

CREATE FUNCTION "fence_delivery_url_claim_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_lock_key BIGINT;
  new_lock_key BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD."normalizedUrl" IS NULL OR LENGTH(OLD."normalizedUrl") = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery URL claim requires a normalized URL';
    END IF;
    old_lock_key := hashtextextended(OLD."normalizedUrl", 6182047);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW."normalizedUrl" IS NULL OR LENGTH(NEW."normalizedUrl") = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'delivery URL claim requires a normalized URL';
    END IF;
    new_lock_key := hashtextextended(NEW."normalizedUrl", 6182047);
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM "acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
  ELSIF old_lock_key = new_lock_key THEN
    PERFORM "acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSIF old_lock_key < new_lock_key THEN
    PERFORM "acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
    PERFORM "acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
  ELSE
    PERFORM "acquire_delivery_url_claim_fence"(NEW."normalizedUrl");
    PERFORM "acquire_delivery_url_claim_fence"(OLD."normalizedUrl");
  END IF;

  IF TG_OP <> 'INSERT' THEN
    UPDATE "DeliveryUrlClaimFence"
    SET "version" = "version" + 1
    WHERE "normalizedUrl" = OLD."normalizedUrl";
  END IF;
  IF TG_OP <> 'DELETE'
     AND (TG_OP <> 'UPDATE' OR NEW."normalizedUrl" IS DISTINCT FROM OLD."normalizedUrl") THEN
    UPDATE "DeliveryUrlClaimFence"
    SET "version" = "version" + 1
    WHERE "normalizedUrl" = NEW."normalizedUrl";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

-- PostgreSQL executes same-kind triggers in name order. The existing
-- OrderDeliveryVersion_settlement_order_lock trigger sorts first and locks the
-- parent Order, so every writer follows the same Order -> URL lock order as
-- current application acceptance and settlement boundaries.
CREATE TRIGGER "OrderDeliveryVersion_url_claim_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "OrderDeliveryVersion"
  FOR EACH ROW
  EXECUTE FUNCTION "fence_delivery_url_claim_mutation"();

COMMIT;
