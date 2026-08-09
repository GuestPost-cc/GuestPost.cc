-- Prove the aggregate-provisioning migration refuses to invent a zero wallet
-- for every organization-linked financial-history representation supported by
-- the preflight. The rehearsal supplies one fixed aggregate_case at a time so
-- a working branch cannot mask a missing branch.

\set ON_ERROR_STOP on

INSERT INTO "Website" (
  "id", "url", "publisherId", "createdAt", "updatedAt"
) SELECT
  'migration-rehearsal-missing-wallet-website',
  'https://missing-wallet-status-drift.invalid',
  'migration-rehearsal-publisher',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' = 'status_drift';

INSERT INTO "Order" (
  "id", "type", "status", "amount", "currency", "paymentStatus", "customerId",
  "websiteId", "organizationId", "createdAt", "updatedAt"
) SELECT
  'migration-rehearsal-missing-wallet-paid-order',
  'GUEST_POST',
  CASE
    WHEN :'aggregate_case' = 'status_drift'
      THEN 'SUBMITTED'::"OrderStatus"
    ELSE 'DRAFT'::"OrderStatus"
  END,
  1,
  'USD',
  CASE
    WHEN :'aggregate_case' = 'paid_order'
      THEN 'PAID'::"PaymentStatus"
    ELSE 'PENDING'::"PaymentStatus"
  END,
  'migration-rehearsal-publisher-owner',
  CASE
    WHEN :'aggregate_case' = 'status_drift'
      THEN 'migration-rehearsal-missing-wallet-website'
    ELSE NULL
  END,
  'migration-rehearsal-empty-org',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' IN (
  'paid_order',
  'order_transaction',
  'settlement',
  'platform_revenue',
  'cancellation_refund',
  'status_drift'
);

INSERT INTO "Membership" (
  "id", "role", "status", "userId", "organizationId", "createdAt", "updatedAt"
) SELECT
  'migration-rehearsal-missing-wallet-membership',
  'OWNER',
  CASE
    WHEN :'aggregate_case' = 'active_personal_wallet'
      THEN 'ACTIVE'::"MembershipStatus"
    ELSE 'PENDING'::"MembershipStatus"
  END,
  'migration-rehearsal-publisher-owner',
  'migration-rehearsal-empty-org',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' IN (
  'active_personal_wallet',
  'pending_personal_wallet'
);

INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "description", "orderId",
  "createdAt"
) SELECT
  'migration-rehearsal-missing-wallet-purchase',
  -1,
  'USD',
  'PURCHASE',
  'migration-rehearsal-missing-wallet-purchase',
  'Preflight-only order payment without an organization wallet',
  'migration-rehearsal-missing-wallet-paid-order',
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' = 'order_transaction';

INSERT INTO "Settlement" (
  "id", "orderId", "publisherId", "grossAmount", "platformFee",
  "publisherAmount", "createdAt", "updatedAt"
) SELECT
  'migration-rehearsal-missing-wallet-settlement',
  'migration-rehearsal-missing-wallet-paid-order',
  'migration-rehearsal-publisher',
  1,
  0,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' = 'settlement';

INSERT INTO "PlatformRevenue" (
  "id", "orderId", "amount", "platformFee", "netRevenue", "recordedAt",
  "createdAt"
) SELECT
  'migration-rehearsal-missing-wallet-revenue',
  'migration-rehearsal-missing-wallet-paid-order',
  1,
  0,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' = 'platform_revenue';

INSERT INTO "OrderCancellationRequest" (
  "id", "orderId", "requesterType", "reasonCode", "previousOrderStatus",
  "fulfillmentChannel", "refundTransactionId", "createdAt", "updatedAt"
) SELECT
  'migration-rehearsal-missing-wallet-cancellation',
  'migration-rehearsal-missing-wallet-paid-order',
  'STAFF',
  'PLATFORM_ERROR',
  'DRAFT',
  'PLATFORM',
  'migration-rehearsal-orphan-refund-evidence',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE :'aggregate_case' = 'cancellation_refund';
