\set ON_ERROR_STOP on

DELETE FROM "Membership"
WHERE "id" = 'migration-rehearsal-missing-wallet-membership';

DELETE FROM "OrderCancellationRequest"
WHERE "id" = 'migration-rehearsal-missing-wallet-cancellation';

DELETE FROM "PlatformRevenue"
WHERE "id" = 'migration-rehearsal-missing-wallet-revenue';

DELETE FROM "Settlement"
WHERE "id" = 'migration-rehearsal-missing-wallet-settlement';

DELETE FROM "Transaction"
WHERE "id" = 'migration-rehearsal-missing-wallet-purchase';

DELETE FROM "Order"
WHERE "id" = 'migration-rehearsal-missing-wallet-paid-order';

DELETE FROM "Website"
WHERE "id" = 'migration-rehearsal-missing-wallet-website';
