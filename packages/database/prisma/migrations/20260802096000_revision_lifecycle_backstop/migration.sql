-- One active revision request per Order. A resubmission closes the current
-- request before the customer can either approve content or consume another
-- snapshotted revision round.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Block concurrent revision/order lifecycle writers until the historical
-- preflight and partial unique index are installed atomically.
LOCK TABLE "Order", "OrderEvent", "Revision" IN SHARE MODE;

-- Before this lifecycle was enforced, replacement-content submissions did
-- not close their corresponding Revision row. Repair only history for which
-- the append-only OrderEvent timeline proves fulfillment: a CONTENT_SUBMITTED
-- event must fall strictly after the request and strictly before the next
-- revision request for the same order. Equal timestamps and requests without
-- an event in their own window remain nonterminal and are handled by the
-- fail-closed duplicate preflight below.
WITH revision_windows AS (
  SELECT
    revision."id",
    revision."orderId",
    revision."createdAt",
    COUNT(*) OVER (
      PARTITION BY revision."orderId", revision."createdAt"
    ) AS same_timestamp_count,
    LEAD(revision."createdAt") OVER (
      PARTITION BY revision."orderId"
      ORDER BY revision."createdAt", revision."id"
    ) AS next_revision_at
  FROM "Revision" revision
), fulfilled_revisions AS (
  SELECT
    revision_window."id",
    MIN(event."createdAt") AS fulfilled_at
  FROM revision_windows revision_window
  JOIN "OrderEvent" event
    ON event."orderId" = revision_window."orderId"
   AND event."eventType" = 'CONTENT_SUBMITTED'
   AND revision_window.same_timestamp_count = 1
   AND event."createdAt" > revision_window."createdAt"
   AND (
     revision_window.next_revision_at IS NULL
     OR event."createdAt" < revision_window.next_revision_at
   )
  GROUP BY revision_window."id"
)
UPDATE "Revision" revision
SET
  "status" = 'APPROVED',
  "updatedAt" = GREATEST(revision."updatedAt", fulfilled.fulfilled_at)
FROM fulfilled_revisions fulfilled
WHERE revision."id" = fulfilled."id"
  AND revision."status" NOT IN ('APPROVED', 'REJECTED');

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
