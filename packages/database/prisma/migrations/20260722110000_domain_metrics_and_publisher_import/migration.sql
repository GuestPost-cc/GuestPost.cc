-- Source-aware domain metrics, Super Admin publisher-inventory imports, and
-- explicit break-glass website verification provenance.

ALTER TYPE "VerificationMethod" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN_OVERRIDE';

CREATE TYPE "WebsiteMetricKey" AS ENUM (
  'AHREFS_DOMAIN_RATING',
  'AHREFS_ORGANIC_TRAFFIC',
  'MOZ_DOMAIN_AUTHORITY',
  'OPEN_PAGE_RANK',
  'OPEN_PAGE_RANK_GLOBAL_RANK',
  'OPEN_PAGE_RANK_REFERRING_DOMAINS'
);

CREATE TYPE "WebsiteMetricProvider" AS ENUM (
  'AHREFS',
  'MOZ',
  'OPEN_PAGE_RANK'
);

CREATE TYPE "WebsiteMetricSource" AS ENUM (
  'AHREFS_FREE_API',
  'AHREFS_PAID_API',
  'MOZ_PAID_API',
  'OPEN_PAGE_RANK_API',
  'PUBLISHER_MANUAL',
  'ADMIN_IMPORT'
);

CREATE TYPE "WebsiteMetricStatus" AS ENUM (
  'CURRENT',
  'STALE',
  'UNAVAILABLE'
);

CREATE TYPE "WebsiteImportStatus" AS ENUM (
  'PREVIEWED',
  'COMMITTING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "WebsiteImportRowStatus" AS ENUM (
  'READY',
  'WARNING',
  'ERROR',
  'CREATED',
  'SKIPPED',
  'FAILED'
);

CREATE TABLE "WebsiteImportBatch" (
  "id" TEXT NOT NULL,
  "publisherId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "idempotencyKey" TEXT,
  "fileName" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL,
  "status" "WebsiteImportStatus" NOT NULL DEFAULT 'PREVIEWED',
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "readyRows" INTEGER NOT NULL DEFAULT 0,
  "warningRows" INTEGER NOT NULL DEFAULT 0,
  "errorRows" INTEGER NOT NULL DEFAULT 0,
  "createdRows" INTEGER NOT NULL DEFAULT 0,
  "skippedRows" INTEGER NOT NULL DEFAULT 0,
  "failedRows" INTEGER NOT NULL DEFAULT 0,
  "committedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteImportBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebsiteImportBatch_counts_check" CHECK (
    "totalRows" >= 0 AND "readyRows" >= 0 AND "warningRows" >= 0 AND
    "errorRows" >= 0 AND "createdRows" >= 0 AND "skippedRows" >= 0 AND
    "failedRows" >= 0
  )
);

CREATE UNIQUE INDEX "WebsiteImportBatch_actorUserId_idempotencyKey_key"
  ON "WebsiteImportBatch"("actorUserId", "idempotencyKey");
CREATE INDEX "WebsiteImportBatch_publisherId_createdAt_idx"
  ON "WebsiteImportBatch"("publisherId", "createdAt");
CREATE INDEX "WebsiteImportBatch_status_createdAt_idx"
  ON "WebsiteImportBatch"("status", "createdAt");
CREATE INDEX "WebsiteImportBatch_fileHash_idx"
  ON "WebsiteImportBatch"("fileHash");

ALTER TABLE "WebsiteImportBatch"
  ADD CONSTRAINT "WebsiteImportBatch_publisherId_fkey"
  FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebsiteImportBatch"
  ADD CONSTRAINT "WebsiteImportBatch_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebsiteImportBatch"
  ADD CONSTRAINT "WebsiteImportBatch_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WebsiteImportRow" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "canonicalDomain" TEXT,
  "status" "WebsiteImportRowStatus" NOT NULL,
  "normalizedData" JSONB,
  "errors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "websiteId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteImportRow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebsiteImportRow_rowNumber_check" CHECK ("rowNumber" >= 2)
);

CREATE UNIQUE INDEX "WebsiteImportRow_batchId_rowNumber_key"
  ON "WebsiteImportRow"("batchId", "rowNumber");
CREATE INDEX "WebsiteImportRow_batchId_status_idx"
  ON "WebsiteImportRow"("batchId", "status");
CREATE INDEX "WebsiteImportRow_canonicalDomain_idx"
  ON "WebsiteImportRow"("canonicalDomain");
CREATE INDEX "WebsiteImportRow_websiteId_idx"
  ON "WebsiteImportRow"("websiteId");
ALTER TABLE "WebsiteImportRow"
  ADD CONSTRAINT "WebsiteImportRow_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "WebsiteImportBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Website"
  ADD COLUMN "verificationOverrideExpiresAt" TIMESTAMP(3),
  ADD COLUMN "verificationOverrideReason" TEXT,
  ADD COLUMN "verifiedByUserId" TEXT,
  ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "Website_importBatchId_idx" ON "Website"("importBatchId");
CREATE INDEX "Website_verificationOverrideExpiresAt_idx"
  ON "Website"("verificationOverrideExpiresAt");
ALTER TABLE "Website"
  ADD CONSTRAINT "Website_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "WebsiteImportBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WebsiteMetric" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "key" "WebsiteMetricKey" NOT NULL,
  "provider" "WebsiteMetricProvider" NOT NULL,
  "source" "WebsiteMetricSource" NOT NULL,
  "status" "WebsiteMetricStatus" NOT NULL DEFAULT 'CURRENT',
  "value" DECIMAL(20,4) NOT NULL,
  "measuredAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "enteredByUserId" TEXT,
  "importBatchId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteMetric_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebsiteMetric_value_check" CHECK (
    "value" >= 0 AND
    ("key" NOT IN ('AHREFS_DOMAIN_RATING', 'MOZ_DOMAIN_AUTHORITY') OR "value" <= 100) AND
    ("key" <> 'OPEN_PAGE_RANK' OR "value" <= 10)
  )
);

CREATE UNIQUE INDEX "WebsiteMetric_websiteId_key_key"
  ON "WebsiteMetric"("websiteId", "key");
CREATE INDEX "WebsiteMetric_key_value_idx" ON "WebsiteMetric"("key", "value");
CREATE INDEX "WebsiteMetric_source_status_idx"
  ON "WebsiteMetric"("source", "status");
CREATE INDEX "WebsiteMetric_expiresAt_idx" ON "WebsiteMetric"("expiresAt");
CREATE INDEX "WebsiteMetric_importBatchId_idx"
  ON "WebsiteMetric"("importBatchId");
ALTER TABLE "WebsiteMetric"
  ADD CONSTRAINT "WebsiteMetric_websiteId_fkey"
  FOREIGN KEY ("websiteId") REFERENCES "Website"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WebsiteMetricRevision" (
  "id" TEXT NOT NULL,
  "metricId" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "key" "WebsiteMetricKey" NOT NULL,
  "provider" "WebsiteMetricProvider" NOT NULL,
  "source" "WebsiteMetricSource" NOT NULL,
  "status" "WebsiteMetricStatus" NOT NULL,
  "value" DECIMAL(20,4) NOT NULL,
  "measuredAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "enteredByUserId" TEXT,
  "importBatchId" TEXT,
  "metadata" JSONB,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebsiteMetricRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebsiteMetricRevision_value_check" CHECK (
    "value" >= 0 AND
    ("key" NOT IN ('AHREFS_DOMAIN_RATING', 'MOZ_DOMAIN_AUTHORITY') OR "value" <= 100) AND
    ("key" <> 'OPEN_PAGE_RANK' OR "value" <= 10)
  )
);

CREATE INDEX "WebsiteMetricRevision_metricId_recordedAt_idx"
  ON "WebsiteMetricRevision"("metricId", "recordedAt");
CREATE INDEX "WebsiteMetricRevision_websiteId_key_recordedAt_idx"
  ON "WebsiteMetricRevision"("websiteId", "key", "recordedAt");
ALTER TABLE "WebsiteMetricRevision"
  ADD CONSTRAINT "WebsiteMetricRevision_metricId_fkey"
  FOREIGN KEY ("metricId") REFERENCES "WebsiteMetric"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
