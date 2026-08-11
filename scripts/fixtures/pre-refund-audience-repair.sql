-- Populated legacy ORDER_REFUNDED audience fixture. This file is loaded
-- immediately before 20260811132000_refund_financial_audience_repair so the
-- migration is exercised against real enum, FK, nullable-recipient, and
-- dispatch-evidence constraints.

\set ON_ERROR_STOP on

INSERT INTO "User" (
  "id", "email", "emailVerified", "userType", "banned", "createdAt", "updatedAt"
) VALUES
  (
    'migration-refund-active-owner',
    'refund-active-owner@migration-rehearsal.invalid',
    true,
    'CUSTOMER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-inactive-owner',
    'refund-inactive-owner@migration-rehearsal.invalid',
    true,
    'CUSTOMER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-pending',
    'refund-pending@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-processing-pre',
    'refund-processing-pre@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-processing-post',
    'refund-processing-post@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-sent',
    'refund-sent@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-uncertain',
    'refund-uncertain@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "Membership" (
  "id", "role", "status", "userId", "organizationId", "createdAt", "updatedAt"
) VALUES
  (
    'migration-refund-active-owner-membership',
    'OWNER',
    'ACTIVE',
    'migration-refund-active-owner',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-refund-inactive-owner-membership',
    'OWNER',
    'PENDING',
    'migration-refund-inactive-owner',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "CommunicationEvent" (
  "id", "type", "category", "severity", "aggregateType", "aggregateId",
  "organizationId", "title", "message", "payload", "dedupKey", "status",
  "availableAt", "lockedAt", "createdAt", "updatedAt"
) VALUES (
  'migration-refund-event',
  'ORDER_REFUNDED',
  'BILLING',
  'SUCCESS',
  'Order',
  'migration-rehearsal-settlement-order',
  -- Deliberately stale/miswired legacy scope. Audit rows must use the Order's
  -- canonical organization instead of trusting this value.
  'migration-rehearsal-empty-org',
  'Order refunded',
  'A legacy refund credit note is available.',
  '{"amount":"100.00","currency":"USD","financialDocumentId":"legacy-document"}'::jsonb,
  'migration:refund-audience:event',
  'PROCESSING',
  CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP - INTERVAL '10 minutes',
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP - INTERVAL '10 minutes'
);

INSERT INTO "CommunicationDelivery" (
  "id", "eventId", "userId", "channel", "status", "attempts",
  "availableAt", "lockedAt", "dispatchStartedAt", "sentAt", "createdAt", "updatedAt"
) VALUES
  (
    'migration-refund-delivery-pending',
    'migration-refund-event',
    'migration-refund-pending',
    'EMAIL',
    'PENDING',
    0,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-processing-pre',
    'migration-refund-event',
    'migration-refund-processing-pre',
    'EMAIL',
    'PROCESSING',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes'
  ),
  (
    'migration-refund-delivery-processing-post',
    'migration-refund-event',
    'migration-refund-processing-post',
    'EMAIL',
    'PROCESSING',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    CURRENT_TIMESTAMP - INTERVAL '9 minutes',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '9 minutes'
  ),
  (
    'migration-refund-delivery-sent',
    'migration-refund-event',
    'migration-refund-sent',
    'EMAIL',
    'SENT',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-uncertain',
    'migration-refund-event',
    'migration-refund-uncertain',
    'EMAIL',
    'DELIVERY_UNCERTAIN',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-null-user',
    'migration-refund-event',
    NULL,
    'EMAIL',
    'PENDING',
    0,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-inactive-owner',
    'migration-refund-event',
    'migration-refund-inactive-owner',
    'EMAIL',
    'FAILED',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-customer',
    'migration-refund-event',
    'migration-rehearsal-publisher-owner',
    'EMAIL',
    'PENDING',
    0,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-refund-delivery-active-owner',
    'migration-refund-event',
    'migration-refund-active-owner',
    'EMAIL',
    'PROCESSING',
    1,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    NULL,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '2 days',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes'
  );

INSERT INTO "Notification" (
  "id", "type", "title", "message", "category", "severity", "read",
  "userId", "organizationId", "eventId", "createdAt"
) VALUES
  (
    'migration-refund-notification-unauthorized',
    'ORDER_REFUNDED',
    'Order refunded',
    'Unauthorized legacy refund notification',
    'BILLING',
    'SUCCESS',
    false,
    'migration-refund-pending',
    'migration-rehearsal-org',
    'migration-refund-event',
    CURRENT_TIMESTAMP - INTERVAL '2 days'
  ),
  (
    'migration-refund-notification-null-user',
    'ORDER_REFUNDED',
    'Order refunded',
    'Deleted-recipient legacy refund notification',
    'BILLING',
    'SUCCESS',
    false,
    NULL,
    'migration-rehearsal-org',
    'migration-refund-event',
    CURRENT_TIMESTAMP - INTERVAL '2 days'
  ),
  (
    'migration-refund-notification-customer',
    'ORDER_REFUNDED',
    'Order refunded',
    'Authorized customer refund notification',
    'BILLING',
    'SUCCESS',
    false,
    'migration-rehearsal-publisher-owner',
    'migration-rehearsal-org',
    'migration-refund-event',
    CURRENT_TIMESTAMP - INTERVAL '2 days'
  ),
  (
    'migration-refund-notification-active-owner',
    'ORDER_REFUNDED',
    'Order refunded',
    'Authorized active owner refund notification',
    'BILLING',
    'SUCCESS',
    false,
    'migration-refund-active-owner',
    'migration-rehearsal-org',
    'migration-refund-event',
    CURRENT_TIMESTAMP - INTERVAL '2 days'
  );
