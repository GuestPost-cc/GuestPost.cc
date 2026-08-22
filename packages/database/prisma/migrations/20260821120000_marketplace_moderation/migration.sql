-- Marketplace lifecycle remains on MarketplaceListing.status. This migration
-- adds a separate moderation authority projection and immutable evidence so a
-- publisher cannot clear a staff pause/archive merely because both share the
-- same historical ListingStatus value.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE TYPE public."ModerationAction" AS ENUM (
  'SUBMIT_FOR_REVIEW',
  'APPROVE',
  'REQUEST_CHANGES',
  'PAUSE',
  'RESTORE',
  'ARCHIVE',
  'REOPEN',
  'ALLOW_RESUBMISSION',
  'DENY_RESUBMISSION'
);

CREATE TYPE public."ModerationScope" AS ENUM ('LISTING', 'WEBSITE');

CREATE TYPE public."ModerationAuthority" AS ENUM (
  'PUBLISHER',
  'OPERATIONS',
  'SUPER_ADMIN'
);

CREATE TYPE public."ModerationReasonCode" AS ENUM (
  'INITIAL_SUBMISSION',
  'CORRECTIONS_COMPLETE',
  'APPROVED_AFTER_REVIEW',
  'INCOMPLETE_POLICY',
  'INCOMPLETE_LISTING',
  'CONTENT_QUALITY',
  'PRICING_OR_SERVICE',
  'DOMAIN_VERIFICATION',
  'POLICY_VIOLATION',
  'SECURITY_RISK',
  'FRAUD_RISK',
  'INVENTORY_UNAVAILABLE',
  'OPERATIONAL_HOLD',
  'PUBLISHER_REQUEST',
  'ISSUE_RESOLVED',
  'EMERGENCY_OVERRIDE',
  'DUPLICATE_OR_INVALID',
  'OTHER',
  'LEGACY_ORIGIN_UNKNOWN'
);

ALTER TABLE public."MarketplaceListing"
  ADD COLUMN "activeModerationAction" public."ModerationAction",
  ADD COLUMN "activeModerationAuthority" public."ModerationAuthority",
  ADD COLUMN "activeModerationReasonCode" public."ModerationReasonCode",
  ADD COLUMN "activeModerationMessage" VARCHAR(2000),
  ADD COLUMN "activeModerationPreviousStatus" public."ListingStatus",
  ADD COLUMN "moderationResubmissionAllowed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "moderationVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public."Website"
  ADD COLUMN "activeModerationAction" public."ModerationAction",
  ADD COLUMN "activeModerationAuthority" public."ModerationAuthority",
  ADD COLUMN "activeModerationReasonCode" public."ModerationReasonCode",
  ADD COLUMN "activeModerationMessage" VARCHAR(2000),
  ADD COLUMN "activeModerationPreviousActive" BOOLEAN,
  ADD COLUMN "moderationVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE public."ModerationEvent" (
  "id" TEXT NOT NULL,
  "scope" public."ModerationScope" NOT NULL,
  "listingId" TEXT,
  "websiteId" TEXT,
  "action" public."ModerationAction" NOT NULL,
  "reasonCode" public."ModerationReasonCode" NOT NULL,
  "publisherMessage" VARCHAR(2000),
  "internalNote" VARCHAR(2000),
  "actorUserId" TEXT,
  "actorStaffRole" public."StaffRole",
  "authority" public."ModerationAuthority" NOT NULL,
  "previousStatus" public."ListingStatus",
  "resultingStatus" public."ListingStatus",
  "previousModerationAction" public."ModerationAction",
  "resultingModerationAction" public."ModerationAction",
  "previousWebsiteActive" BOOLEAN,
  "resultingWebsiteActive" BOOLEAN,
  "resubmissionAllowed" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ModerationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModerationEvent_exact_scope_target_check" CHECK (
    (
      "scope" = 'LISTING'
      AND "listingId" IS NOT NULL
      AND "websiteId" IS NULL
      AND "previousWebsiteActive" IS NULL
      AND "resultingWebsiteActive" IS NULL
    )
    OR
    (
      "scope" = 'WEBSITE'
      AND "websiteId" IS NOT NULL
      AND "listingId" IS NULL
      AND "previousStatus" IS NULL
      AND "resultingStatus" IS NULL
    )
  ),
  CONSTRAINT "ModerationEvent_actor_authority_check" CHECK (
    (
      "authority" = 'PUBLISHER'
      AND "actorUserId" IS NOT NULL
      AND "actorStaffRole" IS NULL
    )
    OR
    (
      "authority" = 'OPERATIONS'
      AND "actorUserId" IS NOT NULL
      AND "actorStaffRole" = 'OPERATIONS'
    )
    OR
    (
      "authority" = 'SUPER_ADMIN'
      AND (
        ("actorUserId" IS NOT NULL AND "actorStaffRole" = 'SUPER_ADMIN')
        OR
        (
          "actorUserId" IS NULL
          AND "actorStaffRole" IS NULL
          AND "reasonCode" = 'LEGACY_ORIGIN_UNKNOWN'
        )
      )
    )
  ),
  CONSTRAINT "ModerationEvent_resubmission_action_check" CHECK (
    NOT "resubmissionAllowed"
    OR "action" IN ('REQUEST_CHANGES', 'ARCHIVE', 'REOPEN', 'ALLOW_RESUBMISSION')
  )
);

ALTER TABLE public."ModerationEvent"
  ADD CONSTRAINT "ModerationEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES public."User"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModerationEvent_listingId_fkey"
    FOREIGN KEY ("listingId") REFERENCES public."MarketplaceListing"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ModerationEvent_websiteId_fkey"
    FOREIGN KEY ("websiteId") REFERENCES public."Website"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "ModerationEvent_listingId_createdAt_idx"
  ON public."ModerationEvent"("listingId", "createdAt");
CREATE INDEX "ModerationEvent_websiteId_createdAt_idx"
  ON public."ModerationEvent"("websiteId", "createdAt");
CREATE INDEX "ModerationEvent_actorUserId_createdAt_idx"
  ON public."ModerationEvent"("actorUserId", "createdAt");
CREATE INDEX "ModerationEvent_scope_action_createdAt_idx"
  ON public."ModerationEvent"("scope", "action", "createdAt");
CREATE INDEX "MarketplaceListing_activeModerationAuthority_activeModerationAction_idx"
  ON public."MarketplaceListing"("activeModerationAuthority", "activeModerationAction");

ALTER TABLE public."MarketplaceListing"
  ADD CONSTRAINT "MarketplaceListing_active_moderation_shape_check" CHECK (
    (
      "activeModerationAction" IS NULL
      AND "activeModerationAuthority" IS NULL
      AND "activeModerationReasonCode" IS NULL
      AND "activeModerationMessage" IS NULL
      AND "activeModerationPreviousStatus" IS NULL
      AND NOT "moderationResubmissionAllowed"
    )
    OR
    (
      "activeModerationAction" IS NOT NULL
      AND "activeModerationAuthority" IS NOT NULL
      AND "activeModerationReasonCode" IS NOT NULL
      AND (
        NOT "moderationResubmissionAllowed"
        OR "activeModerationAction" IN ('REQUEST_CHANGES', 'ARCHIVE', 'ALLOW_RESUBMISSION')
      )
    )
  );

ALTER TABLE public."Website"
  ADD CONSTRAINT "Website_active_moderation_shape_check" CHECK (
    (
      "activeModerationAction" IS NULL
      AND "activeModerationAuthority" IS NULL
      AND "activeModerationReasonCode" IS NULL
      AND "activeModerationMessage" IS NULL
      AND "activeModerationPreviousActive" IS NULL
    )
    OR
    (
      "activeModerationAction" IS NOT NULL
      AND "activeModerationAuthority" IS NOT NULL
      AND "activeModerationReasonCode" IS NOT NULL
    )
  );

-- Historical PAUSED/ARCHIVED origin cannot be reconstructed reliably from the
-- old status alone. Fail closed: treat both as Super Admin interventions until
-- an authorized staff member restores/reopens them. This never grants a
-- publisher authority it did not demonstrably possess before the migration.
INSERT INTO public."ModerationEvent" (
  "id", "scope", "listingId", "action", "reasonCode", "publisherMessage",
  "internalNote", "actorUserId", "actorStaffRole", "authority", "previousStatus",
  "resultingStatus", "previousModerationAction", "resultingModerationAction",
  "resubmissionAllowed", "createdAt"
)
SELECT
  'legacy-listing-' || listing."id" || '-' || lower(listing."status"::text),
  'LISTING'::public."ModerationScope",
  listing."id",
  CASE listing."status"
    WHEN 'PAUSED' THEN 'PAUSE'::public."ModerationAction"
    ELSE 'ARCHIVE'::public."ModerationAction"
  END,
  'LEGACY_ORIGIN_UNKNOWN'::public."ModerationReasonCode",
  CASE listing."status"
    WHEN 'PAUSED' THEN 'This listing was paused before moderation history was introduced. GuestPost Operations must review it before restoration.'
    ELSE 'This listing was archived before moderation history was introduced. Resubmission requires Super Admin review.'
  END,
  'Imported conservatively from legacy status; the originating actor, reason, and prior lifecycle state are unknown.',
  NULL,
  NULL,
  'SUPER_ADMIN'::public."ModerationAuthority",
  NULL,
  listing."status",
  NULL,
  CASE listing."status"
    WHEN 'PAUSED' THEN 'PAUSE'::public."ModerationAction"
    ELSE 'ARCHIVE'::public."ModerationAction"
  END,
  FALSE,
  listing."updatedAt"
FROM public."MarketplaceListing" listing
WHERE listing."status" IN ('PAUSED', 'ARCHIVED');

UPDATE public."MarketplaceListing" listing
SET
  "activeModerationAction" = CASE listing."status"
    WHEN 'PAUSED' THEN 'PAUSE'::public."ModerationAction"
    ELSE 'ARCHIVE'::public."ModerationAction"
  END,
  "activeModerationAuthority" = 'SUPER_ADMIN',
  "activeModerationReasonCode" = 'LEGACY_ORIGIN_UNKNOWN',
  "activeModerationMessage" = CASE listing."status"
    WHEN 'PAUSED' THEN 'This listing was paused before moderation history was introduced. GuestPost Operations must review it before restoration.'
    ELSE 'This listing was archived before moderation history was introduced. Resubmission requires Super Admin review.'
  END,
  "activeModerationPreviousStatus" = NULL,
  "moderationResubmissionAllowed" = FALSE,
  "moderationVersion" = 1
WHERE listing."status" IN ('PAUSED', 'ARCHIVED');

INSERT INTO public."ModerationEvent" (
  "id", "scope", "websiteId", "action", "reasonCode", "publisherMessage",
  "internalNote", "actorUserId", "actorStaffRole", "authority", "previousWebsiteActive",
  "resultingWebsiteActive", "previousModerationAction",
  "resultingModerationAction", "resubmissionAllowed", "createdAt"
)
SELECT
  'legacy-website-' || website."id" || '-inactive',
  'WEBSITE'::public."ModerationScope",
  website."id",
  'PAUSE'::public."ModerationAction",
  'LEGACY_ORIGIN_UNKNOWN'::public."ModerationReasonCode",
  'This website was inactive before moderation history was introduced. GuestPost Operations must review it before restoration.',
  'Imported conservatively from legacy availability; the originating actor, reason, and prior availability state are unknown.',
  NULL,
  NULL,
  'SUPER_ADMIN'::public."ModerationAuthority",
  NULL,
  FALSE,
  NULL,
  'PAUSE'::public."ModerationAction",
  FALSE,
  website."updatedAt"
FROM public."Website" website
WHERE NOT website."isActive";

UPDATE public."Website" website
SET
  "activeModerationAction" = 'PAUSE',
  "activeModerationAuthority" = 'SUPER_ADMIN',
  "activeModerationReasonCode" = 'LEGACY_ORIGIN_UNKNOWN',
  "activeModerationMessage" = 'This website was inactive before moderation history was introduced. GuestPost Operations must review it before restoration.',
  "activeModerationPreviousActive" = NULL,
  "moderationVersion" = 1
WHERE NOT website."isActive";

CREATE FUNCTION public."reject_moderation_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'ModerationEvent is append-only';
END;
$$;

CREATE TRIGGER "ModerationEvent_append_only_guard"
BEFORE UPDATE OR DELETE ON public."ModerationEvent"
FOR EACH ROW EXECUTE FUNCTION public."reject_moderation_event_mutation"();

CREATE TRIGGER "ModerationEvent_truncate_guard"
BEFORE TRUNCATE ON public."ModerationEvent"
FOR EACH STATEMENT EXECUTE FUNCTION public."reject_moderation_event_mutation"();

COMMIT;
