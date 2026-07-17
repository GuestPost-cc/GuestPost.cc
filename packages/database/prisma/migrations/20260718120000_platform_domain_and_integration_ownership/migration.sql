-- Platform inventory and integration ownership hardening.
--
-- 1. Canonical domains are unique across BOTH publisher and platform sites.
--    The application already normalizes both paths; this index closes the
--    concurrent-request race at the database boundary.
-- 2. OAuth credentials are owner-scoped. A Google identity may be connected
--    separately by a publisher and the platform without sharing ciphertext.
-- 3. The missing Integration Management model transition is applied so the
--    deployed schema matches the publisher/platform discovery and sync code.

-- Backfill platform websites created before canonicalDomain was populated.
UPDATE "Website"
SET "canonicalDomain" = lower("domain")
WHERE "canonicalDomain" IS NULL AND "domain" IS NOT NULL;

-- Refuse to guess if historical data already contains a domain collision.
-- Merging websites would rewrite order/listing ownership and is not safe in a
-- schema migration; operators must resolve the conflicting rows explicitly.
DO $$
DECLARE
  duplicate_domain TEXT;
BEGIN
  SELECT "canonicalDomain"
  INTO duplicate_domain
  FROM "Website"
  WHERE "canonicalDomain" IS NOT NULL
  GROUP BY "canonicalDomain"
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF duplicate_domain IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce global website domain uniqueness: duplicate canonical domain %',
      duplicate_domain;
  END IF;
END $$;

DROP INDEX IF EXISTS "Website_canonicalDomain_publisher_key";
CREATE UNIQUE INDEX "Website_canonicalDomain_key"
  ON "Website" ("canonicalDomain")
  WHERE "canonicalDomain" IS NOT NULL;

-- The integration code moved from per-provider IntegrationCredential rows to
-- reusable owner-scoped external accounts, but that model transition never
-- received a migration. Perform it here before enabling platform accounts.
CREATE TYPE "ExternalAccountStatus" AS ENUM (
  'ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR'
);
CREATE TYPE "IntegrationSyncJobType" AS ENUM ('SYNC', 'BACKFILL');
ALTER TYPE "WebsiteIntegrationStatus" ADD VALUE IF NOT EXISTS 'INACCESSIBLE';

CREATE TABLE "ExternalAccount" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalUserId" TEXT NOT NULL,
  "ownerType" "IntegrationOwnerType" NOT NULL DEFAULT 'PUBLISHER',
  "ownerId" TEXT NOT NULL,
  "email" TEXT,
  "displayName" TEXT,
  "encryptedAccessToken" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "grantedScopes" TEXT[] NOT NULL,
  "status" "ExternalAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastDiscoveryAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalAccount_pkey" PRIMARY KEY ("id")
);

-- One legacy integration becomes one isolated account owned by that same
-- publisher. Missing/incomplete legacy credentials are retained as ERROR
-- accounts so the owner can reconnect without losing integration history.
INSERT INTO "ExternalAccount" (
  "id",
  "provider",
  "externalUserId",
  "ownerType",
  "ownerId",
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "tokenExpiresAt",
  "grantedScopes",
  "status",
  "lastDiscoveryAt",
  "lastUsedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy_' || md5(integration.id),
  integration.provider::TEXT,
  integration."providerAccountId",
  integration."ownerType",
  integration."ownerId",
  COALESCE(credential."encryptedAccessToken", ''),
  COALESCE(credential."encryptedRefreshToken", ''),
  COALESCE(credential."tokenExpiresAt", CURRENT_TIMESTAMP),
  COALESCE(credential.scopes, ARRAY[]::TEXT[]),
  CASE
    WHEN credential.id IS NULL THEN 'ERROR'::"ExternalAccountStatus"
    ELSE 'ACTIVE'::"ExternalAccountStatus"
  END,
  integration."discoveredAt",
  integration."lastSyncAt",
  COALESCE(credential."createdAt", integration."createdAt"),
  GREATEST(
    credential."updatedAt",
    integration."updatedAt"
  )
FROM "PublisherIntegration" AS integration
LEFT JOIN "IntegrationCredential" AS credential
  ON credential."integrationId" = integration.id;

CREATE UNIQUE INDEX "ExternalAccount_provider_externalUserId_ownerType_ownerId_key"
  ON "ExternalAccount" ("provider", "externalUserId", "ownerType", "ownerId");
CREATE INDEX "ExternalAccount_ownerType_ownerId_idx"
  ON "ExternalAccount" ("ownerType", "ownerId");
CREATE INDEX "ExternalAccount_status_idx" ON "ExternalAccount" ("status");

ALTER TABLE "PublisherIntegration" ADD COLUMN "connectionId" TEXT;
UPDATE "PublisherIntegration"
SET "connectionId" = 'legacy_' || md5(id);
ALTER TABLE "PublisherIntegration"
  ALTER COLUMN "connectionId" SET NOT NULL;

DROP INDEX "PublisherIntegration_provider_providerAccountId_key";
CREATE UNIQUE INDEX "PublisherIntegration_provider_connectionId_key"
  ON "PublisherIntegration" ("provider", "connectionId");
ALTER TABLE "PublisherIntegration"
  ADD CONSTRAINT "PublisherIntegration_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "ExternalAccount" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublisherIntegration"
  DROP COLUMN "providerAccountId",
  DROP COLUMN "lastSyncAt",
  DROP COLUMN "discoveredAt",
  DROP COLUMN "discoveredResources";

CREATE TABLE "IntegrationSchedule" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "intervalMinutes" INTEGER NOT NULL DEFAULT 1440,
  "nextRunAt" TIMESTAMP(3) NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationSchedule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationSchedule_integrationId_key"
  ON "IntegrationSchedule" ("integrationId");
ALTER TABLE "IntegrationSchedule"
  ADD CONSTRAINT "IntegrationSchedule_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "PublisherIntegration" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing integrations receive the same daily schedule as new connections;
-- the first run is due immediately after the worker is deployed.
INSERT INTO "IntegrationSchedule" (
  "id", "integrationId", "nextRunAt", "createdAt", "updatedAt"
)
SELECT
  'schedule_' || md5(integration.id),
  integration.id,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "PublisherIntegration" AS integration;

CREATE TABLE "IntegrationDiscovery" (
  "id" TEXT NOT NULL,
  "integrationId" TEXT NOT NULL,
  "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'PENDING',
  "resourcesFound" INTEGER NOT NULL DEFAULT 0,
  "resourcesCreated" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "IntegrationDiscovery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IntegrationDiscovery_integrationId_idx"
  ON "IntegrationDiscovery" ("integrationId");
CREATE INDEX "IntegrationDiscovery_status_idx"
  ON "IntegrationDiscovery" ("status");
ALTER TABLE "IntegrationDiscovery"
  ADD CONSTRAINT "IntegrationDiscovery_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "PublisherIntegration" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Generalize GSC-only property columns so the same mapping table can hold
-- GSC and GA4 resources.
DROP INDEX "WebsiteIntegration_integrationId_propertyUrl_key";
ALTER TABLE "WebsiteIntegration"
  RENAME COLUMN "propertyUrl" TO "externalResourceId";
ALTER TABLE "WebsiteIntegration"
  ADD COLUMN "externalResourceName" TEXT,
  ADD COLUMN "metadata" JSONB;
UPDATE "WebsiteIntegration"
SET
  "externalResourceName" = regexp_replace(
    "externalResourceId",
    '^sc-domain:',
    ''
  ),
  "metadata" = jsonb_build_object(
    'permissionLevel',
    "permissionLevel"::TEXT
  );
ALTER TABLE "WebsiteIntegration" DROP COLUMN "permissionLevel";
DROP TYPE "GooglePermissionLevel";
CREATE UNIQUE INDEX "WebsiteIntegration_integrationId_externalResourceId_key"
  ON "WebsiteIntegration" ("integrationId", "externalResourceId");

-- Prevent concurrent link requests from attaching two properties from one
-- provider integration to the same website. Do not silently discard a
-- historical source if old data is ambiguous.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "WebsiteIntegration"
    GROUP BY "integrationId", "websiteId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce one property per provider/website: duplicate WebsiteIntegration rows exist';
  END IF;
END $$;
CREATE UNIQUE INDEX "WebsiteIntegration_integrationId_websiteId_key"
  ON "WebsiteIntegration" ("integrationId", "websiteId");

ALTER TABLE "IntegrationSync"
  ADD COLUMN "websiteIntegrationId" TEXT,
  ADD COLUMN "jobType" "IntegrationSyncJobType" NOT NULL DEFAULT 'SYNC';

-- Attach legacy daily rows to their prior website-property mapping. The
-- source id is a snapshot key (not an FK), so truly unlinked historical rows
-- receive an explicit sentinel instead of being deleted.
ALTER TABLE "WebsiteSearchDaily" ADD COLUMN "sourceIntegrationId" TEXT;
UPDATE "WebsiteSearchDaily" AS daily
SET "sourceIntegrationId" = COALESCE(
  (
    SELECT link.id
    FROM "WebsiteIntegration" AS link
    JOIN "PublisherIntegration" AS integration
      ON integration.id = link."integrationId"
    WHERE
      link."websiteId" = daily."websiteId"
      AND integration.provider = 'GOOGLE_SEARCH_CONSOLE'
    ORDER BY link."createdAt" ASC
    LIMIT 1
  ),
  'legacy-unlinked'
);
ALTER TABLE "WebsiteSearchDaily"
  ALTER COLUMN "sourceIntegrationId" SET NOT NULL;
DROP INDEX "WebsiteSearchDaily_websiteId_date_key";
CREATE UNIQUE INDEX "WebsiteSearchDaily_websiteId_sourceIntegrationId_date_key"
  ON "WebsiteSearchDaily" ("websiteId", "sourceIntegrationId", "date");
CREATE INDEX "WebsiteSearchDaily_sourceIntegrationId_date_idx"
  ON "WebsiteSearchDaily" ("sourceIntegrationId", "date");
CREATE INDEX "WebsiteSearchDaily_date_idx" ON "WebsiteSearchDaily" ("date");

ALTER TABLE "WebsitePageSearchDaily" ADD COLUMN "sourceIntegrationId" TEXT;
UPDATE "WebsitePageSearchDaily" AS daily
SET "sourceIntegrationId" = COALESCE(
  (
    SELECT link.id
    FROM "WebsiteIntegration" AS link
    JOIN "PublisherIntegration" AS integration
      ON integration.id = link."integrationId"
    WHERE
      link."websiteId" = daily."websiteId"
      AND integration.provider = 'GOOGLE_SEARCH_CONSOLE'
    ORDER BY link."createdAt" ASC
    LIMIT 1
  ),
  'legacy-unlinked'
);
ALTER TABLE "WebsitePageSearchDaily"
  ALTER COLUMN "sourceIntegrationId" SET NOT NULL;
DROP INDEX "WebsitePageSearchDaily_websiteId_pageUrl_date_key";
CREATE UNIQUE INDEX "WebsitePageSearchDaily_websiteId_sourceIntegrationId_pageUrl_date_key"
  ON "WebsitePageSearchDaily" (
    "websiteId", "sourceIntegrationId", "pageUrl", "date"
  );

CREATE TABLE "WebsiteAnalyticsDaily" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "sourceIntegrationId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "sessions" INTEGER NOT NULL DEFAULT 0,
  "users" INTEGER NOT NULL DEFAULT 0,
  "newUsers" INTEGER NOT NULL DEFAULT 0,
  "pageviews" INTEGER NOT NULL DEFAULT 0,
  "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "avgSessionDuration" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebsiteAnalyticsDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebsiteAnalyticsDaily_websiteId_sourceIntegrationId_date_key"
  ON "WebsiteAnalyticsDaily" (
    "websiteId", "sourceIntegrationId", "date"
  );
CREATE INDEX "WebsiteAnalyticsDaily_websiteId_date_idx"
  ON "WebsiteAnalyticsDaily" ("websiteId", "date");
CREATE INDEX "WebsiteAnalyticsDaily_sourceIntegrationId_date_idx"
  ON "WebsiteAnalyticsDaily" ("sourceIntegrationId", "date");
CREATE INDEX "WebsiteAnalyticsDaily_date_idx"
  ON "WebsiteAnalyticsDaily" ("date");

DROP TABLE "IntegrationCredential";
