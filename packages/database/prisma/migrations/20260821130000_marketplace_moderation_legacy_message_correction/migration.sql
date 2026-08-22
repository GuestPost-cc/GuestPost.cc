-- Migration 20260821120000_marketplace_moderation is already deployed to
-- staging and its checksum is immutable. Correct only the mutable current
-- projection for untouched system-imported legacy pauses. ModerationEvent rows
-- remain append-only; the API applies the same exact-tuple wording correction
-- only when presenting those historical imports.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

UPDATE public."MarketplaceListing" listing
SET "activeModerationMessage" =
  'This listing was paused before moderation history was introduced. A GuestPost Super Admin must review it before restoration.'
WHERE listing."status" = 'PAUSED'
  AND listing."activeModerationAction" = 'PAUSE'
  AND listing."activeModerationAuthority" = 'SUPER_ADMIN'
  AND listing."activeModerationReasonCode" = 'LEGACY_ORIGIN_UNKNOWN'
  AND listing."activeModerationMessage" =
    'This listing was paused before moderation history was introduced. GuestPost Operations must review it before restoration.'
  AND listing."activeModerationPreviousStatus" IS NULL
  AND NOT listing."moderationResubmissionAllowed"
  AND listing."moderationVersion" = 1
  AND EXISTS (
    SELECT 1
    FROM public."ModerationEvent" event
    WHERE event."id" = 'legacy-listing-' || listing."id" || '-paused'
      AND event."scope" = 'LISTING'
      AND event."listingId" = listing."id"
      AND event."websiteId" IS NULL
      AND event."action" = 'PAUSE'
      AND event."authority" = 'SUPER_ADMIN'
      AND event."reasonCode" = 'LEGACY_ORIGIN_UNKNOWN'
      AND event."publisherMessage" = listing."activeModerationMessage"
      AND event."actorUserId" IS NULL
      AND event."actorStaffRole" IS NULL
      AND event."previousStatus" IS NULL
      AND event."resultingStatus" = 'PAUSED'
      AND event."previousWebsiteActive" IS NULL
      AND event."resultingWebsiteActive" IS NULL
      AND NOT event."resubmissionAllowed"
  );

UPDATE public."Website" website
SET "activeModerationMessage" =
  'This website was inactive before moderation history was introduced. A GuestPost Super Admin must review it before restoration.'
WHERE NOT website."isActive"
  AND website."activeModerationAction" = 'PAUSE'
  AND website."activeModerationAuthority" = 'SUPER_ADMIN'
  AND website."activeModerationReasonCode" = 'LEGACY_ORIGIN_UNKNOWN'
  AND website."activeModerationMessage" =
    'This website was inactive before moderation history was introduced. GuestPost Operations must review it before restoration.'
  AND website."activeModerationPreviousActive" IS NULL
  AND website."moderationVersion" = 1
  AND EXISTS (
    SELECT 1
    FROM public."ModerationEvent" event
    WHERE event."id" = 'legacy-website-' || website."id" || '-inactive'
      AND event."scope" = 'WEBSITE'
      AND event."listingId" IS NULL
      AND event."websiteId" = website."id"
      AND event."action" = 'PAUSE'
      AND event."authority" = 'SUPER_ADMIN'
      AND event."reasonCode" = 'LEGACY_ORIGIN_UNKNOWN'
      AND event."publisherMessage" = website."activeModerationMessage"
      AND event."actorUserId" IS NULL
      AND event."actorStaffRole" IS NULL
      AND event."previousStatus" IS NULL
      AND event."resultingStatus" IS NULL
      AND event."previousWebsiteActive" IS NULL
      AND NOT event."resultingWebsiteActive"
      AND NOT event."resubmissionAllowed"
  );

COMMIT;
