-- Google metric properties are not yet cryptographically/relationally bound
-- to Website.canonicalDomain. Quarantine collection and public summaries while
-- preserving raw rows as untrusted forensic history for a future repair.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE
  "ExternalAccount",
  "IntegrationDiscovery",
  "IntegrationSchedule",
  "IntegrationSync",
  "MarketplaceListing",
  "PublisherIntegration",
  "Website",
  "WebsiteAnalyticsDaily",
  "WebsiteIntegration",
  "WebsiteMetric",
  "WebsitePageSearchDaily",
  "WebsiteSearchDaily"
IN SHARE MODE;

DO $$
DECLARE
  malformed_website_id TEXT;
BEGIN
  SELECT "id" INTO malformed_website_id
  FROM "Website"
  WHERE "metrics" IS NOT NULL
    AND jsonb_typeof("metrics") <> 'object'
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Google metrics quarantine blocked: Website %s has non-object metrics JSON',
        malformed_website_id
      );
  END IF;
END
$$;

DO $$
DECLARE
  mismatched_integration_id TEXT;
  invalid_metric_source RECORD;
BEGIN
  SELECT integration."id" INTO mismatched_integration_id
  FROM "PublisherIntegration" integration
  LEFT JOIN "ExternalAccount" connection
    ON connection."id" = integration."connectionId"
  WHERE connection."id" IS NULL
     OR connection."ownerType" IS DISTINCT FROM integration."ownerType"
     OR connection."ownerId" IS DISTINCT FROM integration."ownerId"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Google metrics quarantine blocked: integration %s does not match its credential owner',
        mismatched_integration_id
      );
  END IF;

  SELECT metric."sourceTable", metric."rowId" INTO invalid_metric_source
  FROM (
    SELECT
      'WebsiteSearchDaily'::TEXT AS "sourceTable",
      daily."id" AS "rowId",
      daily."websiteId",
      daily."sourceIntegrationId"
    FROM "WebsiteSearchDaily" daily
    UNION ALL
    SELECT
      'WebsitePageSearchDaily',
      daily."id",
      daily."websiteId",
      daily."sourceIntegrationId"
    FROM "WebsitePageSearchDaily" daily
    UNION ALL
    SELECT
      'WebsiteAnalyticsDaily',
      daily."id",
      daily."websiteId",
      daily."sourceIntegrationId"
    FROM "WebsiteAnalyticsDaily" daily
  ) metric
  LEFT JOIN "WebsiteIntegration" source_link
    ON source_link."id" = metric."sourceIntegrationId"
  WHERE source_link."id" IS NULL
     OR source_link."websiteId" IS DISTINCT FROM metric."websiteId"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Google metrics quarantine blocked: %s row %s has missing or mismatched source-link provenance',
        invalid_metric_source."sourceTable",
        invalid_metric_source."rowId"
      );
  END IF;
END
$$;

ALTER TABLE "Website"
  ADD CONSTRAINT "Website_metrics_object_check" CHECK (
    "metrics" IS NULL OR jsonb_typeof("metrics") = 'object'
  );

-- Daily metric source ids are financial/audit-adjacent provenance, not loose
-- labels. Restrictive foreign keys make the source mapping durable under
-- concurrent metric inserts, unlinks, and attempted primary-key reuse.
ALTER TABLE "WebsiteSearchDaily"
  ADD CONSTRAINT "WebsiteSearchDaily_sourceIntegrationId_fkey"
  FOREIGN KEY ("sourceIntegrationId") REFERENCES "WebsiteIntegration"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WebsitePageSearchDaily"
  ADD CONSTRAINT "WebsitePageSearchDaily_sourceIntegrationId_fkey"
  FOREIGN KEY ("sourceIntegrationId") REFERENCES "WebsiteIntegration"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WebsiteAnalyticsDaily"
  ADD CONSTRAINT "WebsiteAnalyticsDaily_sourceIntegrationId_fkey"
  FOREIGN KEY ("sourceIntegrationId") REFERENCES "WebsiteIntegration"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

UPDATE "IntegrationSchedule" schedule
SET
  "enabled" = FALSE,
  "version" = schedule."version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "PublisherIntegration" integration
WHERE integration."id" = schedule."integrationId"
  AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  AND schedule."enabled" = TRUE;

UPDATE "WebsiteIntegration" link
SET
  "status" = 'DISABLED',
  "syncedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "PublisherIntegration" integration
WHERE integration."id" = link."integrationId"
  AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  AND (link."status" <> 'DISABLED' OR link."syncedAt" IS NOT NULL);

UPDATE "IntegrationSync" sync
SET
  "status" = 'FAILED',
  "errorMessage" = 'GOOGLE_METRICS_DISABLED',
  "completedAt" = CURRENT_TIMESTAMP
FROM "PublisherIntegration" integration
WHERE integration."id" = sync."integrationId"
  AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  AND sync."status" IN ('PENDING', 'PROCESSING');

UPDATE "IntegrationDiscovery" discovery
SET
  "status" = 'FAILED',
  "errorMessage" = 'GOOGLE_METRICS_DISABLED',
  "completedAt" = CURRENT_TIMESTAMP
FROM "PublisherIntegration" integration
WHERE integration."id" = discovery."integrationId"
  AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  AND discovery."status" IN ('PENDING', 'PROCESSING');

-- These two legacy JSON columns are written only by GSC/GA4 adapters. Clear
-- every payload, including malformed/case-drifted historical shapes that
-- cannot prove a safe non-Google source. Traffic is then re-derived from the
-- normalized, source-aware WebsiteMetric table rather than GA4 summaries.
UPDATE "MarketplaceListing"
SET "metricsData" = NULL
WHERE "metricsData" IS NOT NULL;

UPDATE "MarketplaceListing"
SET "trafficData" = NULL
WHERE "trafficData" IS NOT NULL;

UPDATE "MarketplaceListing" SET "traffic" = NULL;

UPDATE "MarketplaceListing" listing
SET "traffic" = ROUND(metric."value")::INTEGER
FROM "WebsiteMetric" metric
WHERE metric."websiteId" = listing."websiteId"
  AND metric."key" = 'AHREFS_ORGANIC_TRAFFIC'
  AND metric."status" = 'CURRENT'
  AND metric."value" BETWEEN 0 AND 2147483647;

UPDATE "Website"
SET "metrics" = COALESCE("metrics", '{}'::jsonb)
  - 'traffic'
  - 'ga4Sessions30d'
  - 'ga4Users30d'
  - 'ga4Pageviews30d'
  - 'ga4SyncedAt'
WHERE "metrics" IS NOT NULL;

UPDATE "Website" website
SET "metrics" = COALESCE(website."metrics", '{}'::jsonb)
  || jsonb_build_object('traffic', ROUND(metric."value")::BIGINT)
FROM "WebsiteMetric" metric
WHERE metric."websiteId" = website."id"
  AND metric."key" = 'AHREFS_ORGANIC_TRAFFIC'
  AND metric."status" = 'CURRENT'
  AND metric."value" >= 0;

CREATE FUNCTION "reject_quarantined_google_daily_write"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."websiteId" IS DISTINCT FROM OLD."websiteId"
    OR NEW."sourceIntegrationId" IS DISTINCT FROM OLD."sourceIntegrationId"
    OR NEW."date" IS DISTINCT FROM OLD."date"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'daily metric website, source, and date identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE'
     AND TG_TABLE_NAME = 'WebsitePageSearchDaily'
     AND to_jsonb(NEW) -> 'pageUrl' IS DISTINCT FROM to_jsonb(OLD) -> 'pageUrl' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'daily page metric URL identity is immutable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "WebsiteIntegration" link
    JOIN "PublisherIntegration" integration ON integration."id" = link."integrationId"
    WHERE link."id" = NEW."sourceIntegrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'GOOGLE_METRICS_DISABLED: provider-to-domain binding is not verified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "WebsiteIntegration" link
    WHERE link."id" = NEW."sourceIntegrationId"
      AND link."websiteId" = NEW."websiteId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'daily metric source does not match a website integration';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "WebsiteSearchDaily_google_quarantine" BEFORE INSERT OR UPDATE ON "WebsiteSearchDaily" FOR EACH ROW EXECUTE FUNCTION "reject_quarantined_google_daily_write"();
CREATE TRIGGER "WebsitePageSearchDaily_google_quarantine" BEFORE INSERT OR UPDATE ON "WebsitePageSearchDaily" FOR EACH ROW EXECUTE FUNCTION "reject_quarantined_google_daily_write"();
CREATE TRIGGER "WebsiteAnalyticsDaily_google_quarantine" BEFORE INSERT OR UPDATE ON "WebsiteAnalyticsDaily" FOR EACH ROW EXECUTE FUNCTION "reject_quarantined_google_daily_write"();

CREATE FUNCTION "guard_quarantined_google_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."integrationId" IS DISTINCT FROM OLD."integrationId"
    OR NEW."websiteId" IS DISTINCT FROM OLD."websiteId"
    OR NEW."externalResourceId" IS DISTINCT FROM OLD."externalResourceId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'website integration provider-property identity is immutable';
  END IF;
  IF NEW."status" NOT IN ('DISABLED', 'REMOVED') AND EXISTS (
    SELECT 1
    FROM "PublisherIntegration" integration
    WHERE integration."id" = NEW."integrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: website link cannot be enabled';
  END IF;
  IF NEW."syncedAt" IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "PublisherIntegration" integration
    WHERE integration."id" = NEW."integrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: website link cannot be marked synced';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "WebsiteIntegration_google_quarantine" BEFORE INSERT OR UPDATE ON "WebsiteIntegration" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_link"();

CREATE FUNCTION "guard_quarantined_google_schedule"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."integrationId" IS DISTINCT FROM OLD."integrationId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'integration schedule identity is immutable';
  END IF;
  IF NEW."enabled" AND EXISTS (
    SELECT 1
    FROM "PublisherIntegration" integration
    WHERE integration."id" = NEW."integrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: schedule cannot be enabled';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IntegrationSchedule_google_quarantine" BEFORE INSERT OR UPDATE ON "IntegrationSchedule" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_schedule"();

CREATE FUNCTION "guard_quarantined_google_sync"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."integrationId" IS DISTINCT FROM OLD."integrationId"
    OR NEW."websiteIntegrationId" IS DISTINCT FROM OLD."websiteIntegrationId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'integration sync identity is immutable';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "PublisherIntegration" integration
    WHERE integration."id" = NEW."integrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: sync jobs cannot be written';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IntegrationSync_google_quarantine" BEFORE INSERT OR UPDATE ON "IntegrationSync" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_sync"();

CREATE FUNCTION "guard_quarantined_google_discovery"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."integrationId" IS DISTINCT FROM OLD."integrationId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'integration discovery identity is immutable';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "PublisherIntegration" integration
    WHERE integration."id" = NEW."integrationId"
      AND integration."provider" IN ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: discovery jobs cannot be written';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "IntegrationDiscovery_google_quarantine" BEFORE INSERT OR UPDATE ON "IntegrationDiscovery" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_discovery"();

-- Provider is part of an integration aggregate's identity. Without this
-- guard, a direct writer could relabel a non-Google parent after creating
-- enabled child links/schedules and bypass every child-table quarantine
-- trigger above.
CREATE FUNCTION "guard_integration_provider_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
     OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
     OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'integration provider, credential, and owner identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "PublisherIntegration_provider_identity_guard"
  BEFORE UPDATE OF "provider", "connectionId", "ownerType", "ownerId" ON "PublisherIntegration"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_integration_provider_identity"();

-- A provider integration and its OAuth credential form one owner-scoped trust
-- aggregate. The existing single-column FK proves only that the credential
-- exists; this trigger also proves both owner dimensions match. It is named
-- after the identity trigger so immutable-field updates fail with the more
-- specific identity error before this relational assertion runs.
CREATE FUNCTION "assert_integration_connection_owner"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  connection_owner RECORD;
BEGIN
  SELECT connection."ownerType", connection."ownerId"
  INTO connection_owner
  FROM "ExternalAccount" connection
  WHERE connection."id" = NEW."connectionId"
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'integration credential does not exist';
  END IF;

  IF connection_owner."ownerType" IS DISTINCT FROM NEW."ownerType"
     OR connection_owner."ownerId" IS DISTINCT FROM NEW."ownerId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'integration owner must match its credential owner';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "PublisherIntegration_z_connection_owner_guard"
  BEFORE INSERT OR UPDATE OF "connectionId", "ownerType", "ownerId"
  ON "PublisherIntegration"
  FOR EACH ROW
  EXECUTE FUNCTION "assert_integration_connection_owner"();

-- canonicalDomain is the durable Website identity to which a future provider
-- property must be proven. Legacy NULL rows may be populated once, but a
-- verified identity can never be retargeted in place by an old/direct writer.
CREATE FUNCTION "guard_website_canonical_domain_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."canonicalDomain" IS NOT NULL
     AND NEW."canonicalDomain" IS DISTINCT FROM OLD."canonicalDomain" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'website canonical domain identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Website_canonical_domain_identity_guard"
  BEFORE UPDATE OF "canonicalDomain" ON "Website"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_website_canonical_domain_identity"();

CREATE FUNCTION "guard_quarantined_google_listing_summary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."metricsData" IS NOT NULL OR NEW."trafficData" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: listing summary is quarantined';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "MarketplaceListing_google_summary_quarantine" BEFORE INSERT OR UPDATE ON "MarketplaceListing" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_listing_summary"();

CREATE FUNCTION "guard_quarantined_google_website_summary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW."metrics", '{}'::jsonb) ?| ARRAY[
    'ga4Sessions30d',
    'ga4Users30d',
    'ga4Pageviews30d',
    'ga4SyncedAt'
  ] THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'GOOGLE_METRICS_DISABLED: website summary is quarantined';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Website_google_summary_quarantine" BEFORE INSERT OR UPDATE ON "Website" FOR EACH ROW EXECUTE FUNCTION "guard_quarantined_google_website_summary"();

COMMIT;
