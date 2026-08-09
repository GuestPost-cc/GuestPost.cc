-- Fraud signals are immutable evidence, but a hold must have an equally
-- durable adjudication path. Resolutions are append-only, identity-bound, and
-- serialized on the same Order row as settlement release.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Drain all writers that can change fraud identity, evidence, or the parent
-- settlement gate until the historical hold projection and its triggers are
-- installed in the same transaction.
LOCK TABLE
  "DeliveryFraudFlag",
  "DeliverySnapshot",
  "DeliveryVerificationEvidence",
  "Order",
  "OrderDeliveryVersion",
  "StaffMembership",
  "User"
IN SHARE MODE;

CREATE TYPE "DeliveryFraudResolutionKind" AS ENUM (
  'STAFF_CLEARED',
  'LINK_RESTORED'
);

CREATE TABLE "DeliveryFraudFlagResolution" (
  "id" TEXT NOT NULL,
  "fraudFlagId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "deliveryVersionId" TEXT NOT NULL,
  "kind" "DeliveryFraudResolutionKind" NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "resolvedByUserId" TEXT,
  "resolvedByRole" "StaffRole",
  "evidenceId" TEXT,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeliveryFraudFlagResolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryFraudFlagResolution_reason_check" CHECK (
    char_length(btrim("reason")) >= 20
  ),
  CONSTRAINT "DeliveryFraudFlagResolution_actor_check" CHECK (
    (
      "kind" = 'STAFF_CLEARED'
      AND "resolvedByUserId" IS NOT NULL
      AND "resolvedByRole" IS NOT NULL
      AND "evidenceId" IS NULL
    )
    OR (
      "kind" = 'LINK_RESTORED'
      AND "resolvedByUserId" IS NULL
      AND "resolvedByRole" IS NULL
      AND "evidenceId" IS NOT NULL
    )
  ),
  CONSTRAINT "DeliveryFraudFlagResolution_evidence_check" CHECK (
    jsonb_typeof("evidence") = 'object'
  )
);

CREATE UNIQUE INDEX "DeliveryFraudFlagResolution_fraudFlagId_key"
  ON "DeliveryFraudFlagResolution"("fraudFlagId");
CREATE UNIQUE INDEX "DeliveryFraudFlagResolution_evidenceId_key"
  ON "DeliveryFraudFlagResolution"("evidenceId");
CREATE INDEX "DeliveryFraudFlagResolution_orderId_idx"
  ON "DeliveryFraudFlagResolution"("orderId");
CREATE INDEX "DeliveryFraudFlagResolution_deliveryVersionId_idx"
  ON "DeliveryFraudFlagResolution"("deliveryVersionId");
CREATE INDEX "DeliveryFraudFlagResolution_resolvedByUserId_idx"
  ON "DeliveryFraudFlagResolution"("resolvedByUserId");
CREATE INDEX "DeliveryFraudFlagResolution_kind_createdAt_idx"
  ON "DeliveryFraudFlagResolution"("kind", "createdAt");

ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_fraudFlagId_fkey"
  FOREIGN KEY ("fraudFlagId") REFERENCES "DeliveryFraudFlag"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_deliveryVersionId_fkey"
  FOREIGN KEY ("deliveryVersionId") REFERENCES "OrderDeliveryVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_resolvedByUserId_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "DeliveryVerificationEvidence"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A delivery can generate the same signal again after an earlier signal was
-- resolved (for example, a restored link can later be removed again). Replace
-- the historical all-time unique key with an index; the trigger below enforces
-- exactly one *unresolved* signal of a type under the canonical Order lock.
ALTER TABLE "DeliveryFraudFlag"
  DROP CONSTRAINT "DeliveryFraudFlag_deliveryVersionId_type_key";
CREATE INDEX "DeliveryFraudFlag_deliveryVersionId_type_idx"
  ON "DeliveryFraudFlag"("deliveryVersionId", "type");

-- Mutable current-hold projection over immutable flags/resolutions. The unique
-- key is structural (not a snapshot-dependent check), so concurrent writers
-- can never create two active holds for one delivery/type.
CREATE TABLE "DeliveryFraudHold" (
  "fraudFlagId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "deliveryVersionId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryFraudHold_pkey" PRIMARY KEY ("fraudFlagId")
);
CREATE UNIQUE INDEX "DeliveryFraudHold_deliveryVersionId_type_key"
  ON "DeliveryFraudHold"("deliveryVersionId", "type");
CREATE INDEX "DeliveryFraudHold_orderId_idx"
  ON "DeliveryFraudHold"("orderId");
ALTER TABLE "DeliveryFraudHold"
  ADD CONSTRAINT "DeliveryFraudHold_fraudFlagId_fkey"
  FOREIGN KEY ("fraudFlagId") REFERENCES "DeliveryFraudFlag"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudHold"
  ADD CONSTRAINT "DeliveryFraudHold_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeliveryFraudHold"
  ADD CONSTRAINT "DeliveryFraudHold_deliveryVersionId_fkey"
  FOREIGN KEY ("deliveryVersionId") REFERENCES "OrderDeliveryVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every existing flag predates the resolution model and is therefore an open
-- hold. Project it before the settlement helper is switched to this table.
INSERT INTO "DeliveryFraudHold" (
  "fraudFlagId", "orderId", "deliveryVersionId", "type", "createdAt"
)
SELECT
  flag."id", flag."orderId", flag."deliveryVersionId", flag."type", flag."createdAt"
FROM "DeliveryFraudFlag" flag;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "DeliveryFraudHold")
      <> (SELECT COUNT(*) FROM "DeliveryFraudFlag")
    OR EXISTS (
      SELECT 1
      FROM "DeliveryFraudFlag" flag
      LEFT JOIN "DeliveryFraudHold" hold
        ON hold."fraudFlagId" = flag."id"
       AND hold."orderId" = flag."orderId"
       AND hold."deliveryVersionId" = flag."deliveryVersionId"
       AND hold."type" = flag."type"
       AND hold."createdAt" = flag."createdAt"
      WHERE hold."fraudFlagId" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud migration blocked: historical hold projection is incomplete';
  END IF;
END
$$;

-- The projection is settlement authority, so even raw SQL cannot mutate it
-- into a lie. Inserts must be exact unresolved-flag projections, updates are
-- never meaningful, and a delete is accepted only when this transaction also
-- appends the matching immutable resolution.
CREATE FUNCTION "guard_delivery_fraud_hold_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud holds cannot be updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag" flag
    WHERE flag."id" = NEW."fraudFlagId"
      AND flag."orderId" = NEW."orderId"
      AND flag."deliveryVersionId" = NEW."deliveryVersionId"
      AND flag."type" = NEW."type"
      AND flag."createdAt" = NEW."createdAt"
      AND NOT EXISTS (
        SELECT 1
        FROM "DeliveryFraudFlagResolution" resolution
        WHERE resolution."fraudFlagId" = flag."id"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud hold must exactly project an unresolved immutable flag';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "DeliveryFraudHold_write_guard"
  BEFORE INSERT OR UPDATE ON "DeliveryFraudHold"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_delivery_fraud_hold_write"();

CREATE FUNCTION "require_resolution_for_deleted_delivery_fraud_hold"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlagResolution" resolution
    WHERE resolution."fraudFlagId" = OLD."fraudFlagId"
      AND resolution."orderId" = OLD."orderId"
      AND resolution."deliveryVersionId" = OLD."deliveryVersionId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud hold deletion requires matching immutable resolution evidence';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "DeliveryFraudHold_delete_requires_resolution"
  AFTER DELETE ON "DeliveryFraudHold"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION "require_resolution_for_deleted_delivery_fraud_hold"();

CREATE FUNCTION "guard_delivery_fraud_resolution"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  flag_type TEXT;
  flag_created_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud resolution evidence is append-only';
  END IF;

  -- Advance the same database fence used by every settlement blocker. A
  -- SERIALIZABLE waiter with an older snapshot is forced to retry rather than
  -- authorize against a hold that was concurrently opened or closed.
  UPDATE "Order"
  SET "settlementGateVersion" = "settlementGateVersion" + 1
  WHERE "id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'fraud resolution order does not exist';
  END IF;

  SELECT flag."type", flag."createdAt"
    INTO flag_type, flag_created_at
  FROM "DeliveryFraudFlag" flag
  WHERE flag."id" = NEW."fraudFlagId"
    AND flag."orderId" = NEW."orderId"
    AND flag."deliveryVersionId" = NEW."deliveryVersionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud resolution identity does not match its immutable flag';
  END IF;

  IF NEW."kind" = 'LINK_RESTORED' THEN
    IF flag_type <> 'LINK_REMOVED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'only a link-removed flag can be resolved by automated restoration';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "Order" order_row
      JOIN "OrderDeliveryVersion" delivery
        ON delivery."id" = NEW."deliveryVersionId"
      JOIN "DeliveryVerificationEvidence" verification
        ON verification."id" = NEW."evidenceId"
       AND verification."deliveryVersionId" = delivery."id"
      WHERE order_row."id" = NEW."orderId"
        AND order_row."activeDeliveryVersionId" = delivery."id"
        AND delivery."orderId" = order_row."id"
        AND delivery."supersededByVersion" IS NULL
        AND delivery."verificationStatus" = 'VERIFIED'
        AND verification."checkedAt" > flag_created_at
        AND verification."httpStatus" IN (200, 301, 302)
        AND verification."linkFound"
        AND verification."targetUrlMatched"
        AND verification."anchorFound"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
      MESSAGE = 'link-restored resolution requires the active delivery to be freshly verified';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM "StaffMembership" membership
    JOIN "User" resolver ON resolver."id" = membership."userId"
    WHERE membership."userId" = NEW."resolvedByUserId"
      AND membership."role" = NEW."resolvedByRole"
      AND membership."role" IN ('SUPER_ADMIN', 'OPERATIONS', 'FINANCE')
      AND resolver."userType" = 'STAFF'
      AND NOT resolver."banned"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'staff-cleared fraud resolution requires an active allowed staff role';
  END IF;

  DELETE FROM "DeliveryFraudHold"
  WHERE "fraudFlagId" = NEW."fraudFlagId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud resolution requires a current unresolved hold';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "DeliveryFraudFlagResolution_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryFraudFlagResolution"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_delivery_fraud_resolution"();

CREATE FUNCTION "project_delivery_fraud_hold"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "DeliveryFraudHold" (
    "fraudFlagId", "orderId", "deliveryVersionId", "type", "createdAt"
  ) VALUES (
    NEW."id", NEW."orderId", NEW."deliveryVersionId", NEW."type", NEW."createdAt"
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER "DeliveryFraudFlag_current_hold_projection"
  AFTER INSERT ON "DeliveryFraudFlag"
  FOR EACH ROW
  EXECUTE FUNCTION "project_delivery_fraud_hold"();

CREATE FUNCTION "guard_delivery_verification_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'delivery verification evidence is append-only';
END
$$;

CREATE TRIGGER "DeliveryVerificationEvidence_append_only_guard"
  BEFORE UPDATE OR DELETE ON "DeliveryVerificationEvidence"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_delivery_verification_evidence"();

CREATE FUNCTION "guard_delivery_snapshot"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'delivery snapshot evidence is append-only';
END
$$;

CREATE TRIGGER "DeliverySnapshot_append_only_guard"
  BEFORE UPDATE OR DELETE ON "DeliverySnapshot"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_delivery_snapshot"();

-- The settlement transition trigger calls this helper. Replacing it here
-- upgrades the gate atomically after the resolution table exists.
CREATE OR REPLACE FUNCTION "has_unresolved_delivery_fraud"(parent_order_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "DeliveryFraudHold" hold
    WHERE hold."orderId" = parent_order_id
  )
$$;

COMMIT;
