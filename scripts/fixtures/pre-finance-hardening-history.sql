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
  "lifetimePaid", "createdAt", "updatedAt"
) VALUES (
  'migration-rehearsal-publisher-balance',
  'migration-rehearsal-publisher',
  0,
  400,
  100,
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
