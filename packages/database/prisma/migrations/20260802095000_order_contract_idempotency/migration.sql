-- Bind idempotent create requests to their exact tenant/user payload and stop
-- mutable marketplace revision terms from changing an in-flight contract.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Freeze every writer table used by the catalog-chain preflight. This prevents
-- a concurrent relational rebind from passing validation and then changing
-- the attribution facts before the immutable Order trigger is installed.
LOCK TABLE
  "ListingService",
  "MarketplaceListing",
  "Order",
  "Website"
IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Order"
    WHERE "idempotencyKey" IS NOT NULL
      AND (
        char_length("idempotencyKey") NOT BETWEEN 1 AND 200
        OR "idempotencyKey" IS DISTINCT FROM btrim("idempotencyKey")
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22001',
      MESSAGE = 'order idempotency migration blocked: an existing key is blank, padded, or exceeds 200 characters';
  END IF;
END
$$;

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
    WHERE order_row."listingServiceId" IS NOT NULL
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
      MESSAGE = 'order contract migration blocked: listing-service catalog attribution is invalid';
  END IF;
END
$$;

ALTER TABLE "Order"
  ALTER COLUMN "idempotencyKey" TYPE VARCHAR(200),
  ADD COLUMN "requestFingerprint" VARCHAR(64),
  ADD COLUMN "revisionRoundsSnapshot" INTEGER;

-- Legacy rows remain NULL: today's mutable ListingService terms are not proof
-- of what a historical buyer purchased. Runtime revision requests fail closed
-- on that explicit unverified state. The INSERT trigger below requires an exact
-- snapshot for every new listing-backed Order.

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_idempotencyKey_format_check" CHECK (
    "idempotencyKey" IS NULL
    OR (
      char_length("idempotencyKey") BETWEEN 1 AND 200
      AND "idempotencyKey" = btrim("idempotencyKey")
    )
  ),
  ADD CONSTRAINT "Order_requestFingerprint_format_check" CHECK (
    "requestFingerprint" IS NULL
    OR "requestFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "Order_revisionRoundsSnapshot_check" CHECK (
    "revisionRoundsSnapshot" IS NULL OR "revisionRoundsSnapshot" >= 0
  );

CREATE FUNCTION "guard_order_contract_metadata"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  catalog_contract RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
       OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint"
       OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
       OR NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order tenant, customer, and idempotency identity is immutable';
    END IF;
    IF NEW."revisionRoundsSnapshot" IS DISTINCT FROM OLD."revisionRoundsSnapshot"
       OR NEW."listingId" IS DISTINCT FROM OLD."listingId"
       OR NEW."listingServiceId" IS DISTINCT FROM OLD."listingServiceId"
       OR NEW."websiteId" IS DISTINCT FROM OLD."websiteId"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."fulfillmentChannel" IS DISTINCT FROM OLD."fulfillmentChannel"
       OR NEW."turnaroundDays" IS DISTINCT FROM OLD."turnaroundDays"
       OR NEW."warrantyDays" IS DISTINCT FROM OLD."warrantyDays" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'order listing-service contract snapshot is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."idempotencyKey" IS NOT NULL THEN
    IF NEW."requestFingerprint" IS NULL
       OR NEW."requestFingerprint" !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'new idempotent order requires a canonical request fingerprint';
    END IF;
  ELSIF NEW."requestFingerprint" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order request fingerprint requires an idempotency key';
  END IF;

  IF NEW."listingServiceId" IS NULL THEN
    IF NEW."revisionRoundsSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'revision entitlement snapshot requires a listing service';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    service."revisionRounds",
    service."listingId" AS "serviceListingId",
    service."serviceType",
    service."currency" AS "serviceCurrency",
    service."turnaroundDays",
    service."warrantyDays",
    listing."id" AS "listingId",
    listing."websiteId",
    listing."currency" AS "listingCurrency",
    listing."ownerType",
    website."id" AS "websiteRowId"
    INTO catalog_contract
  FROM "ListingService" service
  JOIN "MarketplaceListing" listing
    ON listing."id" = service."listingId"
  JOIN "Website" website
    ON website."id" = listing."websiteId"
  WHERE service."id" = NEW."listingServiceId"
  FOR SHARE OF service, listing, website;

  IF NOT FOUND
     OR NEW."revisionRoundsSnapshot" IS NULL
     OR NEW."revisionRoundsSnapshot" IS DISTINCT FROM catalog_contract."revisionRounds"
     OR NEW."listingId" IS DISTINCT FROM catalog_contract."serviceListingId"
     OR NEW."listingId" IS DISTINCT FROM catalog_contract."listingId"
     OR NEW."websiteId" IS DISTINCT FROM catalog_contract."websiteId"
     OR NEW."websiteId" IS DISTINCT FROM catalog_contract."websiteRowId"
     OR NEW."type" IS DISTINCT FROM catalog_contract."serviceType"
     OR NEW."currency" IS DISTINCT FROM catalog_contract."serviceCurrency"
     OR NEW."currency" IS DISTINCT FROM catalog_contract."listingCurrency"
     OR NEW."turnaroundDays" IS DISTINCT FROM catalog_contract."turnaroundDays"
     OR NEW."warrantyDays" IS DISTINCT FROM catalog_contract."warrantyDays"
     OR NEW."fulfillmentChannel" IS DISTINCT FROM (
       CASE
       WHEN catalog_contract."ownerType" = 'PLATFORM'
         THEN 'PLATFORM'::"FulfillmentChannel"
       ELSE 'PUBLISHER'::"FulfillmentChannel"
       END
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'order contract does not match the selected listing service and website';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "Order_contract_metadata_guard"
  BEFORE INSERT OR UPDATE ON "Order"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_order_contract_metadata"();

COMMIT;
