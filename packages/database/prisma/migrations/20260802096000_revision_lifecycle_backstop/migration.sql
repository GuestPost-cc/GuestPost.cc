-- One active revision request per Order. A resubmission closes the current
-- request before the customer can either approve content or consume another
-- snapshotted revision round.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Block concurrent revision/order lifecycle writers until the historical
-- preflight and partial unique index are installed atomically.
LOCK TABLE "Order", "Revision" IN SHARE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Revision"
    WHERE "status" NOT IN ('APPROVED', 'REJECTED')
    GROUP BY "orderId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'revision lifecycle migration blocked: an order has multiple active revisions';
  END IF;
END
$$;

CREATE UNIQUE INDEX "Revision_orderId_active_key"
  ON "Revision"("orderId")
  WHERE "status" NOT IN ('APPROVED', 'REJECTED');

COMMIT;
