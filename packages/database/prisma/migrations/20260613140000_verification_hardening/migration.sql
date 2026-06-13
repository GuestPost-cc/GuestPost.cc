-- DropForeignKey

-- AlterTable
ALTER TABLE "Website" ADD COLUMN     "activeVerifiedToken" TEXT,
ADD COLUMN     "canonicalDomain" TEXT,
ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastSuccessfulVerificationAt" TIMESTAMP(3),
ADD COLUMN     "lastVerificationRequestAt" TIMESTAMP(3),
ADD COLUMN     "trustScore" INTEGER,
ADD COLUMN     "verificationCheckCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Website_canonicalDomain_idx" ON "Website"("canonicalDomain");

-- AddForeignKey


-- Backfill canonical domain from existing normalized domain.
UPDATE "Website" SET "canonicalDomain" = lower("domain") WHERE "domain" IS NOT NULL;

-- Backfill the proven token for already-verified sites so the periodic sweep
-- keeps checking the secret currently published in DNS.
UPDATE "Website" SET "activeVerifiedToken" = "verificationToken",
  "lastSuccessfulVerificationAt" = "verifiedAt"
WHERE "verificationStatus" = 'VERIFIED' AND "verificationToken" IS NOT NULL;

-- Platform-wide ownership uniqueness: one canonical domain = one publisher
-- website. Partial unique excludes platform-owned inventory + null domains.
-- Prisma cannot express partial unique indexes; created via raw SQL.
CREATE UNIQUE INDEX "Website_canonicalDomain_publisher_key"
  ON "Website" ("canonicalDomain")
  WHERE "ownershipType" = 'PUBLISHER' AND "canonicalDomain" IS NOT NULL;
