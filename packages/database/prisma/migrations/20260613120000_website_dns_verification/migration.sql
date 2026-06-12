-- DNS TXT domain ownership verification for publisher websites.
CREATE TYPE "WebsiteVerificationStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'VERIFICATION_FAILED', 'REVOKED');
CREATE TYPE "VerificationMethod" AS ENUM ('DNS_TXT');

ALTER TABLE "Website"
  ADD COLUMN "verificationStatus" "WebsiteVerificationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  ADD COLUMN "verificationMethod" "VerificationMethod",
  ADD COLUMN "verificationToken" TEXT,
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "lastVerificationCheckAt" TIMESTAMP(3),
  ADD COLUMN "verificationFailureReason" TEXT,
  ADD COLUMN "verificationVersion" INTEGER NOT NULL DEFAULT 0;

-- Platform-owned websites are owned by the platform — mark them VERIFIED so
-- the existing platform inventory is not retroactively blocked.
UPDATE "Website" SET "verificationStatus" = 'VERIFIED', "verifiedAt" = now()
WHERE "ownershipType" = 'PLATFORM';

CREATE INDEX "Website_verificationToken_idx" ON "Website"("verificationToken");
CREATE INDEX "Website_verificationStatus_idx" ON "Website"("verificationStatus");
CREATE INDEX "Website_verifiedAt_idx" ON "Website"("verifiedAt");
