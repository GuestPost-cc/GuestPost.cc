-- Repairs schema/database drift left by earlier db-push-only changes:
-- enum types for Campaign/ContentOrder/Revision statuses (converted in place
-- with USING casts — Prisma's generated script would DROP the columns and
-- destroy data), Website.ownershipType, nullable Website.publisherId, and
-- FK delete rules for the now-nullable AuditLog/Notification actor columns.
-- All steps idempotent.

-- ── Enum types ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CampaignStatus') THEN
    CREATE TYPE "CampaignStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContentOrderStatus') THEN
    CREATE TYPE "ContentOrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RevisionStatus') THEN
    CREATE TYPE "RevisionStatus" AS ENUM ('REQUESTED', 'PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'DRAFT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebsiteOwnershipType') THEN
    CREATE TYPE "WebsiteOwnershipType" AS ENUM ('PUBLISHER', 'PLATFORM');
  END IF;
END $$;

-- ── Campaign.status TEXT → enum (data-preserving) ─────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Campaign' AND column_name = 'status' AND data_type = 'text') THEN
    UPDATE "Campaign" SET "status" = 'ACTIVE'
      WHERE "status" NOT IN ('ACTIVE','PAUSED','COMPLETED','ARCHIVED');
    ALTER TABLE "Campaign" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "Campaign" ALTER COLUMN "status" TYPE "CampaignStatus" USING "status"::"CampaignStatus";
    ALTER TABLE "Campaign" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
  END IF;
END $$;

-- ── ContentOrder.status TEXT → enum (data-preserving) ─────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'ContentOrder' AND column_name = 'status' AND data_type = 'text') THEN
    UPDATE "ContentOrder" SET "status" = 'PENDING'
      WHERE "status" NOT IN ('PENDING','IN_PROGRESS','COMPLETED','CANCELLED');
    ALTER TABLE "ContentOrder" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "ContentOrder" ALTER COLUMN "status" TYPE "ContentOrderStatus" USING "status"::"ContentOrderStatus";
    ALTER TABLE "ContentOrder" ALTER COLUMN "status" SET DEFAULT 'PENDING';
  END IF;
END $$;

-- ── Revision.status TEXT → enum (data-preserving) ─────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'Revision' AND column_name = 'status' AND data_type = 'text') THEN
    UPDATE "Revision" SET "status" = 'REQUESTED'
      WHERE "status" NOT IN ('REQUESTED','PENDING','APPROVED','REJECTED','CHANGES_REQUESTED','DRAFT');
    ALTER TABLE "Revision" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "Revision" ALTER COLUMN "status" TYPE "RevisionStatus" USING "status"::"RevisionStatus";
    ALTER TABLE "Revision" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';
  END IF;
END $$;

-- ── Website: ownershipType + nullable publisherId ─────────────────────────
ALTER TABLE "Website" ADD COLUMN IF NOT EXISTS "ownershipType" "WebsiteOwnershipType" NOT NULL DEFAULT 'PUBLISHER';
ALTER TABLE "Website" ALTER COLUMN "publisherId" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "Website_ownershipType_idx" ON "Website"("ownershipType");

ALTER TABLE "Website" DROP CONSTRAINT IF EXISTS "Website_publisherId_fkey";
ALTER TABLE "Website" ADD CONSTRAINT "Website_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Nullable actor FKs: delete rule becomes SET NULL ───────────────────────
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_organizationId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_organizationId_fkey";
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
