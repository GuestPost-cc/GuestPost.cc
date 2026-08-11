-- ORDER_REFUNDED carries a customer credit note. The original acceptance-
-- timeout writer also resolved publisher members onto that financial event.
-- Drain communication workers before applying this migration: pre-dispatch
-- work is suppressible, but an SMTP call that already started is immutable
-- evidence and must be reviewed rather than rewritten or automatically sent.

-- Persist an incident trail before changing projections. This intentionally
-- records SENT/DELIVERY_UNCERTAIN/bounce/complaint outcomes and any delivery
-- that crossed the SMTP dispatch boundary. The deterministic id keeps a
-- retried migration idempotent.
INSERT INTO "AuditLog" (
  "id",
  "action",
  "entityType",
  "entityId",
  "metadata",
  "requestId",
  "userId",
  "organizationId",
  "ipAddress",
  "userAgent",
  "createdAt"
)
SELECT
  'refund-audience-review:' || md5(event."id"),
  'LEGACY_REFUND_AUDIENCE_DISCLOSURE_REVIEW_REQUIRED',
  'CommunicationEvent',
  event."id",
  jsonb_build_object(
    'communicationEventId', event."id",
    'orderId', order_row."id",
    'terminalUnauthorizedEmailCount', count(delivery."id"),
    'deliveries', jsonb_agg(
      jsonb_build_object(
        'deliveryId', delivery."id",
        'userId', delivery."userId",
        'status', delivery."status",
        'dispatchStartedAt', delivery."dispatchStartedAt",
        'sentAt', delivery."sentAt"
      )
      ORDER BY delivery."id"
    )
  ),
  NULL,
  NULL,
  order_row."organizationId",
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM "CommunicationEvent" event
JOIN "Order" order_row
  ON event."aggregateType" = 'Order'
  AND event."aggregateId" = order_row."id"
JOIN "CommunicationDelivery" delivery
  ON delivery."eventId" = event."id"
  AND delivery."channel" = 'EMAIL'
WHERE event."type" = 'ORDER_REFUNDED'
  AND (
    delivery."userId" IS NULL
    OR NOT (
      delivery."userId" = order_row."customerId"
      OR EXISTS (
        SELECT 1
        FROM "Membership" membership
        WHERE membership."organizationId" = order_row."organizationId"
          AND membership."userId" = delivery."userId"
          AND membership."status" = 'ACTIVE'
          AND membership."role" = 'OWNER'
      )
    )
  )
  AND (
    delivery."status" IN (
      'SENT',
      'DELIVERY_UNCERTAIN',
      'BOUNCED',
      'COMPLAINED'
    )
    OR delivery."dispatchStartedAt" IS NOT NULL
  )
GROUP BY event."id", order_row."id", order_row."organizationId"
ON CONFLICT ("id") DO NOTHING;

-- Record the reversible projection cleanup itself, including events with no
-- terminal disclosure. This is distinct from the incident record above.
INSERT INTO "AuditLog" (
  "id",
  "action",
  "entityType",
  "entityId",
  "metadata",
  "requestId",
  "userId",
  "organizationId",
  "ipAddress",
  "userAgent",
  "createdAt"
)
SELECT
  'refund-audience-repair:' || md5(event."id"),
  'LEGACY_REFUND_AUDIENCE_PROJECTIONS_REPAIRED',
  'CommunicationEvent',
  event."id",
  jsonb_build_object(
    'communicationEventId', event."id",
    'orderId', order_row."id",
    'preDispatchEmailSuppressed', (
      SELECT count(*)
      FROM "CommunicationDelivery" delivery
      WHERE delivery."eventId" = event."id"
        AND delivery."channel" = 'EMAIL'
        AND delivery."status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND delivery."dispatchStartedAt" IS NULL
        AND (
          delivery."userId" IS NULL
          OR NOT (
            delivery."userId" = order_row."customerId"
            OR EXISTS (
              SELECT 1
              FROM "Membership" membership
              WHERE membership."organizationId" = order_row."organizationId"
                AND membership."userId" = delivery."userId"
                AND membership."status" = 'ACTIVE'
                AND membership."role" = 'OWNER'
            )
          )
        )
    ),
    'inAppDeleted', (
      SELECT count(*)
      FROM "Notification" notification
      WHERE notification."eventId" = event."id"
        AND (
          notification."userId" IS NULL
          OR NOT (
            notification."userId" = order_row."customerId"
            OR EXISTS (
              SELECT 1
              FROM "Membership" membership
              WHERE membership."organizationId" = order_row."organizationId"
                AND membership."userId" = notification."userId"
                AND membership."status" = 'ACTIVE'
                AND membership."role" = 'OWNER'
            )
          )
        )
    )
  ),
  NULL,
  NULL,
  order_row."organizationId",
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM "CommunicationEvent" event
JOIN "Order" order_row
  ON event."aggregateType" = 'Order'
  AND event."aggregateId" = order_row."id"
WHERE event."type" = 'ORDER_REFUNDED'
  AND (
    EXISTS (
      SELECT 1
      FROM "CommunicationDelivery" delivery
      WHERE delivery."eventId" = event."id"
        AND delivery."channel" = 'EMAIL'
        AND delivery."status" IN ('PENDING', 'FAILED', 'PROCESSING')
        AND delivery."dispatchStartedAt" IS NULL
        AND (
          delivery."userId" IS NULL
          OR NOT (
            delivery."userId" = order_row."customerId"
            OR EXISTS (
              SELECT 1
              FROM "Membership" membership
              WHERE membership."organizationId" = order_row."organizationId"
                AND membership."userId" = delivery."userId"
                AND membership."status" = 'ACTIVE'
                AND membership."role" = 'OWNER'
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "Notification" notification
      WHERE notification."eventId" = event."id"
        AND (
          notification."userId" IS NULL
          OR NOT (
            notification."userId" = order_row."customerId"
            OR EXISTS (
              SELECT 1
              FROM "Membership" membership
              WHERE membership."organizationId" = order_row."organizationId"
                AND membership."userId" = notification."userId"
                AND membership."status" = 'ACTIVE'
                AND membership."role" = 'OWNER'
            )
          )
        )
    )
  )
ON CONFLICT ("id") DO NOTHING;

-- Suppress only email work that provably has not crossed the provider side-
-- effect boundary. A PROCESSING row is safe only while dispatchStartedAt is
-- NULL. SENT and uncertain rows are deliberately never altered.
UPDATE "CommunicationDelivery" AS delivery
SET
  "status" = 'SUPPRESSED',
  "lockedAt" = NULL,
  "failedAt" = COALESCE(delivery."failedAt", CURRENT_TIMESTAMP),
  "lastError" = 'Recipient removed from financial event audience',
  "updatedAt" = CURRENT_TIMESTAMP
FROM "CommunicationEvent" AS event
JOIN "Order" AS order_row
  ON event."aggregateType" = 'Order'
  AND event."aggregateId" = order_row."id"
WHERE delivery."eventId" = event."id"
  AND delivery."channel" = 'EMAIL'
  AND event."type" = 'ORDER_REFUNDED'
  AND delivery."status" IN ('PENDING', 'FAILED', 'PROCESSING')
  AND delivery."dispatchStartedAt" IS NULL
  AND (
    delivery."userId" IS NULL
    OR NOT (
      delivery."userId" = order_row."customerId"
      OR EXISTS (
        SELECT 1
        FROM "Membership" membership
        WHERE membership."organizationId" = order_row."organizationId"
          AND membership."userId" = delivery."userId"
          AND membership."status" = 'ACTIVE'
          AND membership."role" = 'OWNER'
      )
    )
  );

-- In-app rows have no external side effect and can be removed completely.
DELETE FROM "Notification" AS notification
USING "CommunicationEvent" AS event, "Order" AS order_row
WHERE notification."eventId" = event."id"
  AND event."aggregateType" = 'Order'
  AND event."aggregateId" = order_row."id"
  AND event."type" = 'ORDER_REFUNDED'
  AND (
    notification."userId" IS NULL
    OR NOT (
      notification."userId" = order_row."customerId"
      OR EXISTS (
        SELECT 1
        FROM "Membership" membership
        WHERE membership."organizationId" = order_row."organizationId"
          AND membership."userId" = notification."userId"
          AND membership."status" = 'ACTIVE'
          AND membership."role" = 'OWNER'
      )
    )
  );

-- Make the database sweep see every remaining authorized retry. Do not race
-- an SMTP call that already crossed dispatch; those rows and their parent
-- event remain untouched until operator reconciliation.
UPDATE "CommunicationEvent" AS event
SET
  "status" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "CommunicationDelivery" delivery
      WHERE delivery."eventId" = event."id"
        AND delivery."status" IN (
          'PENDING',
          'PROCESSING',
          'FAILED',
          'DELIVERY_UNCERTAIN'
        )
    ) THEN 'PENDING'::"CommunicationEventStatus"
    ELSE 'PROCESSED'::"CommunicationEventStatus"
  END,
  "processedAt" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "CommunicationDelivery" delivery
      WHERE delivery."eventId" = event."id"
        AND delivery."status" IN (
          'PENDING',
          'PROCESSING',
          'FAILED',
          'DELIVERY_UNCERTAIN'
        )
    ) THEN NULL
    ELSE COALESCE(event."processedAt", CURRENT_TIMESTAMP)
  END,
  "lockedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE event."type" = 'ORDER_REFUNDED'
  AND event."aggregateType" = 'Order'
  AND NOT EXISTS (
    SELECT 1
    FROM "CommunicationDelivery" delivery
    WHERE delivery."eventId" = event."id"
      AND delivery."status" = 'PROCESSING'
      AND delivery."dispatchStartedAt" IS NOT NULL
  );
