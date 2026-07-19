-- Turn the legacy boolean account ban into an auditable suspension lifecycle
-- while keeping `banned` as the compatibility/enforcement flag consumed by
-- Better Auth and existing API guards.
CREATE TYPE "AccountSuspensionReason" AS ENUM (
    'SECURITY_RISK',
    'FRAUD_OR_ABUSE',
    'TERMS_VIOLATION',
    'PAYMENT_RISK',
    'COMPLIANCE',
    'STAFF_ACCESS_REMOVAL',
    'OTHER',
    'LEGACY'
);

ALTER TABLE "User"
ADD COLUMN "banReasonCode" "AccountSuspensionReason",
ADD COLUMN "suspendedAt" TIMESTAMP(3),
ADD COLUMN "suspendedByUserId" TEXT;

-- Preserve already-suspended accounts without inventing an administrator.
UPDATE "User"
SET
    "banReasonCode" = 'LEGACY',
    "suspendedAt" = "updatedAt"
WHERE "banned" = TRUE;

CREATE INDEX "User_suspendedByUserId_idx"
ON "User"("suspendedByUserId");

ALTER TABLE "User"
ADD CONSTRAINT "User_suspendedByUserId_fkey"
FOREIGN KEY ("suspendedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
