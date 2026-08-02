-- Populated pre-hardening fixture for the finance migration rehearsal.
--
-- This file is applied after every migration before
-- 20260729085000_payment_provider_event_quarantine. It deliberately contains
-- historical rows whose evidence is incomplete by the new runtime standard.
-- The hardening migrations must preserve or honestly classify them; they must
-- never invent provider evidence.

\set ON_ERROR_STOP on

INSERT INTO "Organization" (
  "id", "name", "slug", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-org',
    'Migration Rehearsal',
    'migration-rehearsal',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-rehearsal-empty-org',
    'Migration Rehearsal Empty Organization',
    'migration-rehearsal-empty',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "User" (
  "id", "email", "emailVerified", "userType", "role", "banned",
  "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-publisher-owner',
    'publisher-owner@migration-rehearsal.invalid',
    true,
    'PUBLISHER',
    'PUBLISHER',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-rehearsal-finance',
    'finance@migration-rehearsal.invalid',
    true,
    'STAFF',
    'ADMIN',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "Publisher" (
  "id", "name", "email", "organizationId", "tier", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-publisher',
    'Migration Rehearsal Publisher',
    'publisher@migration-rehearsal.invalid',
    'migration-rehearsal-org',
    'VERIFIED',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'migration-rehearsal-empty-publisher',
    'Migration Rehearsal Empty Publisher',
    'empty-publisher@migration-rehearsal.invalid',
    'migration-rehearsal-empty-org',
    'NEW',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "PublisherMembership" (
  "id", "role", "userId", "publisherId", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-publisher-membership',
  'PUBLISHER_OWNER',
  'migration-rehearsal-publisher-owner',
  'migration-rehearsal-publisher',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "StaffMembership" (
  "id", "role", "userId", "permissions", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-finance-membership',
  'FINANCE',
  'migration-rehearsal-finance',
  '[]'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "PublisherBalance" (
  "id", "publisherId", "withdrawableBalance", "lifetimeEarnings",
  "lifetimePaid", "allocationCutoverAt", "allocationCarryForward",
  "allocationCarryForwardUsed", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-publisher-balance',
  'migration-rehearsal-publisher',
  65,
  400,
  100,
  CURRENT_TIMESTAMP - INTERVAL '5 days',
  40,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "Withdrawal" (
  "id", "publisherId", "amount", "currency", "publicReference", "payoutFee",
  "netAmount", "feePolicyVersion", "method", "status", "availableAt",
  "idempotencyKey", "approvedBy", "approvedAt", "version", "createdAt",
  "updatedAt"
) VALUES
  (
    'migration-rehearsal-withdrawal-completed',
    'migration-rehearsal-publisher',
    100,
    'USD',
    'WD-REHEARSAL-COMPLETED',
    0,
    100,
    'legacy-no-fee',
    'stripe_connect',
    'COMPLETED',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-completed',
    'migration-rehearsal-finance',
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    3,
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    CURRENT_TIMESTAMP - INTERVAL '8 days'
  ),
  (
    'migration-rehearsal-withdrawal-reversed',
    'migration-rehearsal-publisher',
    100,
    'USD',
    'WD-REHEARSAL-REVERSED',
    0,
    100,
    'legacy-no-fee',
    'stripe_connect',
    'REVERSED',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-reversed',
    'migration-rehearsal-finance',
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    4,
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    CURRENT_TIMESTAMP - INTERVAL '7 days'
  ),
  (
    'migration-rehearsal-withdrawal-failed',
    'migration-rehearsal-publisher',
    100,
    'USD',
    'WD-REHEARSAL-FAILED',
    0,
    100,
    'legacy-no-fee',
    'stripe_connect',
    'FAILED',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-failed',
    'migration-rehearsal-finance',
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    3,
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    CURRENT_TIMESTAMP - INTERVAL '8 days'
  ),
  (
    'migration-rehearsal-withdrawal-ambiguous',
    'migration-rehearsal-publisher',
    100,
    'USD',
    'WD-REHEARSAL-AMBIGUOUS',
    0,
    100,
    'legacy-no-fee',
    'stripe_connect',
    'APPROVED',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-ambiguous',
    'migration-rehearsal-finance',
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    1,
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    CURRENT_TIMESTAMP - INTERVAL '9 days'
  );

-- Allocation tracking was introduced after these request-time debits. The
-- PENDING row remains reserved; the REJECTED row crossed the allocation
-- cutover and has an exact compensating reversal. They deliberately share an
-- amount so the rejected row's canonical reversal cannot be misattributed to
-- the pending request. Migration 0970 may rebuild only this evidence, without
-- changing withdrawable or lifetime balances.
INSERT INTO "Withdrawal" (
  "id", "publisherId", "amount", "currency", "publicReference", "payoutFee",
  "netAmount", "feePolicyVersion", "method", "status", "availableAt",
  "idempotencyKey", "version", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-withdrawal-pending-reserved',
    'migration-rehearsal-publisher',
    25,
    'USD',
    'WD-REHEARSAL-PENDING-RESERVED',
    0,
    25,
    'legacy-no-fee',
    'bank_transfer',
    'PENDING',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-pending-reserved',
    0,
    CURRENT_TIMESTAMP - INTERVAL '12 days',
    CURRENT_TIMESTAMP - INTERVAL '12 days'
  ),
  (
    'migration-rehearsal-withdrawal-rejected-reserved',
    'migration-rehearsal-publisher',
    25,
    'USD',
    'WD-REHEARSAL-REJECTED-RESERVED',
    0,
    25,
    'legacy-no-fee',
    'bank_transfer',
    'REJECTED',
    CURRENT_TIMESTAMP - INTERVAL '10 days',
    'migration-rehearsal-rejected-reserved',
    1,
    CURRENT_TIMESTAMP - INTERVAL '12 days',
    CURRENT_TIMESTAMP - INTERVAL '3 days'
  );

INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "description",
  "publisherId", "createdAt"
)
SELECT
  'migration-rehearsal-pending-reservation-debit',
  -withdrawal."amount",
  withdrawal."currency",
  'WITHDRAWAL'::"TransactionType",
  'withdrawal-' || withdrawal."id",
  'Historical pending publisher withdrawal reservation',
  withdrawal."publisherId",
  withdrawal."createdAt" + INTERVAL '1 second'
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-withdrawal-pending-reserved'
UNION ALL
SELECT
  'migration-rehearsal-rejected-reservation-debit',
  -withdrawal."amount",
  withdrawal."currency",
  'WITHDRAWAL'::"TransactionType",
  'withdrawal-' || withdrawal."id",
  'Historical rejected publisher withdrawal reservation',
  withdrawal."publisherId",
  withdrawal."createdAt" + INTERVAL '1 second'
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-withdrawal-rejected-reserved'
UNION ALL
SELECT
  'migration-rehearsal-rejected-reservation-reversal',
  withdrawal."amount",
  withdrawal."currency",
  'WITHDRAWAL_REVERSAL'::"TransactionType",
  'withdrawal-reject-' || withdrawal."id",
  'Historical exact publisher withdrawal rejection reversal',
  withdrawal."publisherId",
  withdrawal."updatedAt" - INTERVAL '1 second'
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-withdrawal-rejected-reserved';

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
)
SELECT
  'migration-rehearsal-request-' || "id",
  'WITHDRAWAL_REQUESTED',
  'Withdrawal',
  "id",
  'migration-rehearsal-publisher-owner',
  'migration-rehearsal-org',
  "createdAt"
FROM "Withdrawal"
WHERE "id" LIKE 'migration-rehearsal-withdrawal-%';

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
)
SELECT
  'migration-rehearsal-rejection-reserved',
  'WITHDRAWAL_REJECTED',
  'Withdrawal',
  withdrawal."id",
  'migration-rehearsal-finance',
  'migration-rehearsal-org',
  withdrawal."updatedAt"
FROM "Withdrawal" withdrawal
WHERE withdrawal."id" =
  'migration-rehearsal-withdrawal-rejected-reserved';

INSERT INTO "AuditLog" (
  "id", "action", "entityType", "entityId", "userId", "organizationId",
  "createdAt"
) VALUES
  (
    'migration-rehearsal-approval-completed',
    'WITHDRAWAL_APPROVED',
    'Withdrawal',
    'migration-rehearsal-withdrawal-completed',
    'migration-rehearsal-finance',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP - INTERVAL '9 days'
  ),
  (
    'migration-rehearsal-approval-reversed',
    'WITHDRAWAL_APPROVED',
    'Withdrawal',
    'migration-rehearsal-withdrawal-reversed',
    'migration-rehearsal-finance',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP - INTERVAL '9 days'
  ),
  (
    'migration-rehearsal-reversal',
    'WITHDRAWAL_REVERSED',
    'Withdrawal',
    'migration-rehearsal-withdrawal-reversed',
    'migration-rehearsal-finance',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP - INTERVAL '7 days'
  );

INSERT INTO "PayoutExecution" (
  "id", "withdrawalId", "providerId", "status", "providerExecutionId",
  "providerTransferId", "amount", "sourceCurrency", "destinationCurrency",
  "destinationAmount", "requestedReference", "stage", "idempotencyKey",
  "version", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-execution-completed',
    'migration-rehearsal-withdrawal-completed',
    'provider_stripe_connect',
    'COMPLETED',
    'tr_migration_rehearsal_completed',
    'tr_migration_rehearsal_completed',
    100,
    'USD',
    'USD',
    100,
    'WD-REHEARSAL-COMPLETED',
    'PROVIDER_SENT',
    'payout-migration-rehearsal-completed-v1',
    3,
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    CURRENT_TIMESTAMP - INTERVAL '8 days'
  ),
  (
    'migration-rehearsal-execution-cancelled',
    'migration-rehearsal-withdrawal-reversed',
    'provider_stripe_connect',
    'CANCELLED',
    NULL,
    NULL,
    100,
    'USD',
    'USD',
    100,
    'WD-REHEARSAL-REVERSED',
    'CREATED',
    'payout-migration-rehearsal-reversed-v1',
    2,
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    CURRENT_TIMESTAMP - INTERVAL '7 days'
  ),
  (
    'migration-rehearsal-execution-failed',
    'migration-rehearsal-withdrawal-failed',
    'provider_stripe_connect',
    'FAILED',
    NULL,
    NULL,
    100,
    'USD',
    'USD',
    100,
    'WD-REHEARSAL-FAILED',
    'CREATED',
    'payout-migration-rehearsal-failed-v1',
    2,
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    CURRENT_TIMESTAMP - INTERVAL '8 days'
  ),
  (
    'migration-rehearsal-execution-ambiguous',
    'migration-rehearsal-withdrawal-ambiguous',
    'provider_stripe_connect',
    'PENDING',
    NULL,
    NULL,
    100,
    'USD',
    'USD',
    100,
    'WD-REHEARSAL-AMBIGUOUS',
    'DESTINATION_VALIDATED',
    'payout-migration-rehearsal-ambiguous-v1',
    1,
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    CURRENT_TIMESTAMP - INTERVAL '9 days'
  );

INSERT INTO "Wallet" (
  "id", "availableBalance", "reservedBalance", "currency", "userId", "version",
  "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-wallet',
  75,
  0,
  'USD',
  'migration-rehearsal-publisher-owner',
  2,
  CURRENT_TIMESTAMP - INTERVAL '30 days',
  CURRENT_TIMESTAMP - INTERVAL '5 days'
);

INSERT INTO "Wallet" (
  "id", "availableBalance", "reservedBalance", "currency",
  "organizationId", "version", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-organization-wallet',
  0,
  0,
  'USD',
  'migration-rehearsal-org',
  0,
  CURRENT_TIMESTAMP - INTERVAL '30 days',
  CURRENT_TIMESTAMP - INTERVAL '5 days'
);

INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "provider", "providerRef",
  "description", "walletId", "createdAt"
) VALUES
  (
    'migration-rehearsal-deposit-transaction',
    100,
    'USD',
    'DEPOSIT',
    'cs_migration_rehearsal',
    'stripe',
    'pi_migration_rehearsal',
    'Historical deposit',
    'migration-rehearsal-wallet',
    CURRENT_TIMESTAMP - INTERVAL '30 days'
  ),
  (
    'migration-rehearsal-wallet-withdrawal',
    -25,
    'USD',
    'WITHDRAWAL',
    'legacy-wallet-withdrawal-migration-rehearsal',
    NULL,
    NULL,
    'Historical unsupported customer wallet cash-out',
    'migration-rehearsal-wallet',
    CURRENT_TIMESTAMP - INTERVAL '20 days'
  );

INSERT INTO "DepositAttempt" (
  "id", "publicReference", "walletId", "createdByUserId", "method", "provider",
  "amount", "walletCredit", "currency", "status", "idempotencyKey",
  "providerSessionId", "providerPaymentId", "ledgerTransactionId",
  "completedAt", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-deposit-attempt',
  'DEP-REHEARSAL',
  'migration-rehearsal-wallet',
  'migration-rehearsal-publisher-owner',
  'card',
  'stripe',
  100,
  100,
  'USD',
  'SUCCEEDED',
  'migration-rehearsal-deposit',
  'cs_migration_rehearsal',
  'pi_migration_rehearsal',
  'migration-rehearsal-deposit-transaction',
  CURRENT_TIMESTAMP - INTERVAL '30 days',
  CURRENT_TIMESTAMP - INTERVAL '30 days',
  CURRENT_TIMESTAMP - INTERVAL '30 days'
);

INSERT INTO "PaymentProviderEvent" (
  "id", "provider", "providerEventId", "eventType", "objectId",
  "depositAttemptId", "status", "attempts", "processedAt", "receivedAt",
  "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-deposit-event',
    'stripe',
    'evt_migration_rehearsal_deposit',
    'checkout.session.completed',
    'cs_migration_rehearsal',
    'migration-rehearsal-deposit-attempt',
    'PROCESSED',
    1,
    CURRENT_TIMESTAMP - INTERVAL '30 days',
    CURRENT_TIMESTAMP - INTERVAL '30 days',
    CURRENT_TIMESTAMP - INTERVAL '30 days',
    CURRENT_TIMESTAMP - INTERVAL '30 days'
  ),
  (
    'migration-rehearsal-dispute-event',
    'stripe',
    'evt_migration_rehearsal_dispute',
    'charge.dispute.created',
    'dp_migration_rehearsal',
    'migration-rehearsal-deposit-attempt',
    'PROCESSED',
    1,
    CURRENT_TIMESTAMP - INTERVAL '5 days',
    CURRENT_TIMESTAMP - INTERVAL '5 days',
    CURRENT_TIMESTAMP - INTERVAL '5 days',
    CURRENT_TIMESTAMP - INTERVAL '5 days'
  );

-- Google-quarantine and integration-encryption upgrade history. The active
-- account ciphertexts are valid AES-GCM envelopes created with the documented
-- disposable development v1 key; the ERROR account is the exact missing-
-- credential sentinel retained by the 20260718120000 migration.
INSERT INTO "Website" (
  "id", "url", "domain", "name", "metrics", "publisherId",
  "ownershipType", "verificationStatus", "canonicalDomain", "createdAt",
  "updatedAt"
) VALUES (
  'migration-rehearsal-metrics-website',
  'https://metrics-rehearsal.invalid',
  'metrics-rehearsal.invalid',
  'Metrics Rehearsal',
  '{"traffic":987,"ga4Sessions30d":987,"ga4Users30d":654,"ga4Pageviews30d":1234,"ga4SyncedAt":"2026-07-28T00:00:00.000Z","safeControl":"preserve-me"}'::jsonb,
  'migration-rehearsal-publisher',
  'PUBLISHER',
  'VERIFIED',
  'metrics-rehearsal.invalid',
  CURRENT_TIMESTAMP - INTERVAL '20 days',
  CURRENT_TIMESTAMP - INTERVAL '1 day'
);

-- Canonical eligible order used by the post-migration settlement assertions.
-- The active delivery is inserted separately because Order and
-- OrderDeliveryVersion intentionally form a circular evidence relationship.
INSERT INTO "Order" (
  "id", "type", "status", "amount", "currency", "paymentStatus", "title",
  "customerId", "websiteId", "organizationId", "version",
  "fulfillmentChannel", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-settlement-order',
  'GUEST_POST',
  'DELIVERED',
  100,
  'USD',
  'PAID',
  'Migration rehearsal settlement order',
  'migration-rehearsal-publisher-owner',
  'migration-rehearsal-metrics-website',
  'migration-rehearsal-org',
  1,
  'PUBLISHER',
  CURRENT_TIMESTAMP - INTERVAL '10 days',
  CURRENT_TIMESTAMP - INTERVAL '2 days'
);

INSERT INTO "OrderItem" (
  "id", "orderId", "websiteId", "price", "status", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-settlement-item',
  'migration-rehearsal-settlement-order',
  'migration-rehearsal-metrics-website',
  100,
  'PENDING_PAYMENT',
  CURRENT_TIMESTAMP - INTERVAL '10 days',
  CURRENT_TIMESTAMP - INTERVAL '10 days'
);

INSERT INTO "OrderDeliveryVersion" (
  "id", "orderId", "version", "publishedUrl", "normalizedUrl",
  "submittedByUserId", "submittedAt", "verificationStatus",
  "interventionStatus", "verificationVersion", "createdAt"
) VALUES (
  'migration-rehearsal-settlement-delivery',
  'migration-rehearsal-settlement-order',
  1,
  'https://metrics-rehearsal.invalid/rehearsal-article',
  'https://metrics-rehearsal.invalid/rehearsal-article',
  'migration-rehearsal-publisher-owner',
  CURRENT_TIMESTAMP - INTERVAL '3 days',
  'VERIFIED',
  'NONE',
  1,
  CURRENT_TIMESTAMP - INTERVAL '3 days'
);

UPDATE "Order"
SET "activeDeliveryVersionId" = 'migration-rehearsal-settlement-delivery'
WHERE "id" = 'migration-rehearsal-settlement-order';

-- Historical revision rows were not closed when replacement content was
-- submitted. Each request below has one CONTENT_SUBMITTED event inside its
-- own revision window, so the 0960 migration can repair it without inferring
-- intent from the order's later status.
INSERT INTO "Revision" (
  "id", "orderId", "notes", "status", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-evidenced-revision-one',
    'migration-rehearsal-settlement-order',
    'Historical first revision with replacement-content evidence',
    'REQUESTED',
    CURRENT_TIMESTAMP - INTERVAL '9 days',
    CURRENT_TIMESTAMP - INTERVAL '9 days'
  ),
  (
    'migration-rehearsal-evidenced-revision-two',
    'migration-rehearsal-settlement-order',
    'Historical second revision with replacement-content evidence',
    'REQUESTED',
    CURRENT_TIMESTAMP - INTERVAL '8 days',
    CURRENT_TIMESTAMP - INTERVAL '8 days'
  );

INSERT INTO "OrderEvent" (
  "id", "orderId", "eventType", "actorId", "message", "metadata",
  "createdAt"
) VALUES
  (
    'migration-rehearsal-evidenced-resubmission-one',
    'migration-rehearsal-settlement-order',
    'CONTENT_SUBMITTED',
    'migration-rehearsal-publisher-owner',
    'Historical replacement content submitted for revision one',
    '{"version":2,"hasContent":true}'::jsonb,
    CURRENT_TIMESTAMP - INTERVAL '8 days 12 hours'
  ),
  (
    'migration-rehearsal-evidenced-resubmission-two',
    'migration-rehearsal-settlement-order',
    'CONTENT_SUBMITTED',
    'migration-rehearsal-publisher-owner',
    'Historical replacement content submitted for revision two',
    '{"version":3,"hasContent":true}'::jsonb,
    CURRENT_TIMESTAMP - INTERVAL '7 days 12 hours'
  );

-- Pre-0940 unresolved signal: the fraud-resolution migration must project
-- this historical immutable flag into DeliveryFraudHold before switching the
-- canonical settlement predicate to that table.
INSERT INTO "DeliveryFraudFlag" (
  "id", "orderId", "deliveryVersionId", "type", "details", "createdAt"
) VALUES (
  'migration-rehearsal-pre0940-fraud',
  'migration-rehearsal-settlement-order',
  'migration-rehearsal-settlement-delivery',
  'URL_REUSED',
  '{"source":"pre-0940-migration-rehearsal"}'::jsonb,
  CURRENT_TIMESTAMP - INTERVAL '2 days'
);

-- The organization wallet was funded and charged exactly once for the paid
-- order. These are the canonical ledger facts consumed by settlement
-- eligibility; the zero aggregate is the honest +100 / -100 result.
INSERT INTO "Transaction" (
  "id", "amount", "currency", "type", "reference", "provider",
  "providerRef", "description", "walletId", "orderId", "createdAt"
) VALUES
  (
    'migration-rehearsal-order-funding',
    100,
    'USD',
    'DEPOSIT',
    'cs_migration_rehearsal_order_funding',
    'stripe',
    'pi_migration_rehearsal_order_funding',
    'Historical organization-wallet funding for the settlement order',
    'migration-rehearsal-organization-wallet',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '11 days'
  ),
  (
    'migration-rehearsal-order-purchase',
    -100,
    'USD',
    'PURCHASE',
    'order:migration-rehearsal-settlement-order',
    NULL,
    NULL,
    'Exact purchase evidence for the paid settlement order',
    'migration-rehearsal-organization-wallet',
    'migration-rehearsal-settlement-order',
    CURRENT_TIMESTAMP - INTERVAL '10 days'
  );

-- Active historical settlements did not yet have a versioned fee-policy
-- snapshot. The hardening migration must backfill it from the singleton
-- PlatformSettings row without inventing a different split.
INSERT INTO "Settlement" (
  "id", "orderId", "publisherId", "grossAmount", "platformFee",
  "publisherAmount", "status", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-settlement-backfill',
  'migration-rehearsal-settlement-order',
  'migration-rehearsal-publisher',
  100,
  20,
  80,
  'PENDING',
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP - INTERVAL '2 days'
);

INSERT INTO "MarketplaceListing" (
  "id", "title", "slug", "description", "status", "fulfillmentType",
  "ownerType", "currency", "traffic", "websiteUrl", "metricsData",
  "trafficData", "publisherId", "websiteId", "organizationId", "createdAt",
  "updatedAt"
) VALUES (
  'migration-rehearsal-metrics-listing',
  'Metrics rehearsal listing',
  'migration-rehearsal-metrics-listing',
  'Historical listing with unsafe Google summaries',
  'APPROVED',
  'PUBLISHER',
  'PUBLISHER',
  'USD',
  987,
  'https://metrics-rehearsal.invalid',
  '{"source":"GSC","clicks":111,"impressions":222}'::jsonb,
  '{"source":"GA4","sessions":987,"users":654}'::jsonb,
  'migration-rehearsal-publisher',
  'migration-rehearsal-metrics-website',
  'migration-rehearsal-org',
  CURRENT_TIMESTAMP - INTERVAL '20 days',
  CURRENT_TIMESTAMP - INTERVAL '1 day'
);

INSERT INTO "ListingService" (
  "id", "listingId", "serviceType", "price", "currency",
  "turnaroundDays", "revisionRounds", "availability", "createdAt",
  "updatedAt"
) VALUES (
  'migration-rehearsal-metrics-service',
  'migration-rehearsal-metrics-listing',
  'GUEST_POST',
  100,
  'USD',
  3,
  2,
  'AVAILABLE',
  CURRENT_TIMESTAMP - INTERVAL '20 days',
  CURRENT_TIMESTAMP - INTERVAL '1 day'
);

-- Bind the historical captured order to the exact catalog chain before the
-- settlement backstop validates attribution. This is factual fixture history,
-- not a migration-synthesized financial record.
UPDATE "Order"
SET
  "listingId" = 'migration-rehearsal-metrics-listing',
  "listingServiceId" = 'migration-rehearsal-metrics-service',
  "turnaroundDays" = 3
WHERE "id" = 'migration-rehearsal-settlement-order';

INSERT INTO "WebsiteMetric" (
  "id", "websiteId", "key", "provider", "source", "status", "value",
  "measuredAt", "collectedAt", "expiresAt", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-ahrefs-traffic',
  'migration-rehearsal-metrics-website',
  'AHREFS_ORGANIC_TRAFFIC',
  'AHREFS',
  'PUBLISHER_MANUAL',
  'CURRENT',
  321,
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP + INTERVAL '88 days',
  CURRENT_TIMESTAMP - INTERVAL '2 days',
  CURRENT_TIMESTAMP - INTERVAL '2 days'
);

INSERT INTO "ExternalAccount" (
  "id", "provider", "externalUserId", "ownerType", "ownerId", "email",
  "encryptedAccessToken", "encryptedRefreshToken", "tokenExpiresAt",
  "grantedScopes", "status", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-google-account',
    'GOOGLE',
    'google-migration-rehearsal',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'google@migration-rehearsal.invalid',
    'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
    'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
    CURRENT_TIMESTAMP + INTERVAL '1 hour',
    ARRAY['scope:google'],
    'ACTIVE',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-bing-account',
    'MICROSOFT',
    'bing-migration-rehearsal',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'bing@migration-rehearsal.invalid',
    'AQEBAQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
    'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
    CURRENT_TIMESTAMP + INTERVAL '1 hour',
    ARRAY['scope:bing'],
    'ACTIVE',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-empty-error-account',
    'GOOGLE',
    'missing-credential-migration-rehearsal',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    NULL,
    '',
    '',
    CURRENT_TIMESTAMP,
    ARRAY[]::TEXT[],
    'ERROR',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '20 days'
  );

INSERT INTO "PublisherIntegration" (
  "id", "ownerType", "ownerId", "provider", "connectionId", "status",
  "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-google-integration',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'GOOGLE_SEARCH_CONSOLE',
    'migration-rehearsal-google-account',
    'ACTIVE',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-bing-integration',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'BING_WEBMASTER',
    'migration-rehearsal-bing-account',
    'ACTIVE',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  );

INSERT INTO "IntegrationSchedule" (
  "id", "integrationId", "enabled", "intervalMinutes", "nextRunAt",
  "version", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-google-schedule',
    'migration-rehearsal-google-integration',
    TRUE,
    1440,
    CURRENT_TIMESTAMP,
    1,
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-bing-schedule',
    'migration-rehearsal-bing-integration',
    TRUE,
    1440,
    CURRENT_TIMESTAMP,
    1,
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  );

INSERT INTO "WebsiteIntegration" (
  "id", "integrationId", "websiteId", "externalResourceId",
  "externalResourceName", "metadata", "status", "syncedAt", "createdAt",
  "updatedAt"
) VALUES
  (
    'migration-rehearsal-google-link',
    'migration-rehearsal-google-integration',
    'migration-rehearsal-metrics-website',
    'sc-domain:unbound-attacker.invalid',
    'unbound-attacker.invalid',
    '{"permissionLevel":"siteOwner"}'::jsonb,
    'CONNECTED',
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-bing-link',
    'migration-rehearsal-bing-integration',
    'migration-rehearsal-metrics-website',
    'https://metrics-rehearsal.invalid',
    'metrics-rehearsal.invalid',
    '{}'::jsonb,
    'CONNECTED',
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '20 days',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  );

INSERT INTO "IntegrationSync" (
  "id", "integrationId", "websiteIntegrationId", "jobType", "status",
  "trigger", "startedAt"
) VALUES
  (
    'migration-rehearsal-google-sync',
    'migration-rehearsal-google-integration',
    'migration-rehearsal-google-link',
    'SYNC',
    'PENDING',
    'SCHEDULED',
    CURRENT_TIMESTAMP - INTERVAL '1 hour'
  ),
  (
    'migration-rehearsal-bing-sync',
    'migration-rehearsal-bing-integration',
    'migration-rehearsal-bing-link',
    'SYNC',
    'COMPLETED',
    'SCHEDULED',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  );

INSERT INTO "IntegrationDiscovery" (
  "id", "integrationId", "status", "resourcesFound", "resourcesCreated",
  "errorMessage", "startedAt", "completedAt"
) VALUES
  (
    'migration-rehearsal-google-discovery',
    'migration-rehearsal-google-integration',
    'PENDING',
    0,
    0,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 hour',
    NULL
  ),
  (
    'migration-rehearsal-bing-discovery',
    'migration-rehearsal-bing-integration',
    'COMPLETED',
    2,
    1,
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '23 hours'
  );

INSERT INTO "WebsiteSearchDaily" (
  "id", "websiteId", "sourceIntegrationId", "date", "clicks",
  "impressions", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-google-search-daily',
    'migration-rehearsal-metrics-website',
    'migration-rehearsal-google-link',
    CURRENT_DATE - 1,
    111,
    222,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  ),
  (
    'migration-rehearsal-bing-search-daily',
    'migration-rehearsal-metrics-website',
    'migration-rehearsal-bing-link',
    CURRENT_DATE - 1,
    12,
    34,
    CURRENT_TIMESTAMP - INTERVAL '1 day',
    CURRENT_TIMESTAMP - INTERVAL '1 day'
  );

INSERT INTO "WebsitePageSearchDaily" (
  "id", "websiteId", "sourceIntegrationId", "pageUrl", "date", "clicks",
  "impressions", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-google-page-daily',
  'migration-rehearsal-metrics-website',
  'migration-rehearsal-google-link',
  'https://unbound-attacker.invalid/page',
  CURRENT_DATE - 1,
  10,
  20,
  CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP - INTERVAL '1 day'
);

INSERT INTO "WebsiteAnalyticsDaily" (
  "id", "websiteId", "sourceIntegrationId", "date", "sessions", "users",
  "newUsers", "pageviews", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-google-analytics-daily',
  'migration-rehearsal-metrics-website',
  'migration-rehearsal-google-link',
  CURRENT_DATE - 1,
  987,
  654,
  321,
  1234,
  CURRENT_TIMESTAMP - INTERVAL '1 day',
  CURRENT_TIMESTAMP - INTERVAL '1 day'
);
