-- Additive hardening for API-key principals, idempotent report generation,
-- bounded worker candidate scans, and public-catalog RLS lookup paths.

ALTER TABLE public."ApiKey"
  ADD COLUMN "createdByUserId" text;

ALTER TABLE public."ApiKey"
  ADD CONSTRAINT "ApiKey_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES public."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Existing keys deliberately remain NULL and cannot authenticate. There is no
-- trustworthy historical creator to infer; owners can rotate them explicitly.

ALTER TABLE public."Report"
  ADD COLUMN "dedupKey" varchar(256);

-- Make the public Website policy's listing predicate visible to PostgreSQL.
-- The previous nested SECURITY DEFINER function call could prevent the planner
-- from proving that the active-listing partial index applied.
CREATE OR REPLACE FUNCTION guestpost_rls.public_website(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."MarketplaceListing" AS listing
    JOIN public."Website" AS website ON website.id = listing."websiteId"
    WHERE listing."websiteId" = target_id
      AND listing.status = 'APPROVED'
      AND listing.verified = true
      AND website."isActive" = true
      AND website."verificationStatus" = 'VERIFIED'
  );
$function$;
