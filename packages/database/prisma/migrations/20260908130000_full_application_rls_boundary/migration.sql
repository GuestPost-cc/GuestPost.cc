-- Install the complete application RLS policy surface without activating it.
--
-- Activation is deliberately separate (scripts/activate-full-rls.sql). This
-- migration is safe to deploy before runtime credentials are switched: it
-- creates the policy contract for all 99 application tables but does not run
-- ENABLE/FORCE RLS. ApiKey remains protected by the preceding Phase 1
-- migration throughout the staged rollout.

-- Public review responses must not need visibility into the Better Auth User
-- row. Snapshot only the two display-safe fields and backfill existing reviews
-- before the public catalog policy is activated.
ALTER TABLE public."MarketplaceReview"
  ADD COLUMN "reviewerName" text,
  ADD COLUMN "reviewerImage" text;

UPDATE public."MarketplaceReview" AS review
SET "reviewerName" = reviewer_user.name,
    "reviewerImage" = reviewer_user.image
FROM public."User" AS reviewer_user
WHERE reviewer_user.id = review."userId";

CREATE SCHEMA IF NOT EXISTS guestpost_rls;
REVOKE ALL ON SCHEMA guestpost_rls FROM PUBLIC;

CREATE OR REPLACE FUNCTION guestpost_rls.role_member(
  invoker_name text,
  target_role text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role)
    AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = invoker_name)
    AND pg_has_role(invoker_name, target_role, 'MEMBER');
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.actor_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(current_setting('guestpost.rls_actor_id', true), '');
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.customer_organization(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    target_id IS NOT NULL
    AND current_setting('guestpost.rls_workload', true) IN ('API', 'AUTH_BOOTSTRAP')
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND (
      current_setting('guestpost.rls_workload', true) = 'AUTH_BOOTSTRAP'
      OR current_setting('guestpost.rls_organization_id', true) = target_id
    )
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      JOIN public."User" AS actor ON actor.id = membership."userId"
      WHERE membership."organizationId" = target_id
        AND membership."userId" = guestpost_rls.actor_id()
        AND membership.status = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
        AND actor.banned = false
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.publisher(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    target_id IS NOT NULL
    AND current_setting('guestpost.rls_workload', true) IN ('API', 'AUTH_BOOTSTRAP')
    AND current_setting('guestpost.rls_actor_kind', true) = 'PUBLISHER'
    AND (
      current_setting('guestpost.rls_workload', true) = 'AUTH_BOOTSTRAP'
      OR current_setting('guestpost.rls_publisher_id', true) = target_id
    )
    AND EXISTS (
      SELECT 1
      FROM public."PublisherMembership" AS membership
      JOIN public."User" AS actor ON actor.id = membership."userId"
      WHERE membership."publisherId" = target_id
        AND membership."userId" = guestpost_rls.actor_id()
        AND actor."userType" = 'PUBLISHER'
        AND actor.banned = false
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.publisher_owner(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT guestpost_rls.publisher(target_id)
    AND EXISTS (
      SELECT 1
      FROM public."PublisherMembership" AS membership
      WHERE membership."publisherId" = target_id
        AND membership."userId" = guestpost_rls.actor_id()
        AND membership.role = 'PUBLISHER_OWNER'
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.customer_organization_owner(
  target_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT guestpost_rls.customer_organization(target_id)
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      WHERE membership."organizationId" = target_id
        AND membership."userId" = guestpost_rls.actor_id()
        AND membership.status = 'ACTIVE'
        AND membership.role = 'OWNER'
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.find_invitable_user(
  target_email text,
  target_organization_id text
)
RETURNS TABLE(id text, banned boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT candidate.id, candidate.banned
  FROM public."User" AS candidate
  WHERE lower(candidate.email) = lower(target_email)
    AND candidate."userType" = 'CUSTOMER'
    AND guestpost_rls.customer_organization_owner(target_organization_id)
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.publisher_organization(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."Publisher" AS publisher
    WHERE publisher."organizationId" = target_id
      AND guestpost_rls.publisher(publisher.id)
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.self_user(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    target_id IS NOT NULL
    AND current_setting('guestpost.rls_workload', true) IN ('API', 'AUTH_BOOTSTRAP')
    AND target_id = guestpost_rls.actor_id()
    AND EXISTS (
      SELECT 1 FROM public."User" AS actor
      WHERE actor.id = target_id AND actor.banned = false
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.staff_role_in(allowed_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'STAFF'
    AND EXISTS (
      SELECT 1
      FROM public."StaffMembership" AS membership
      JOIN public."User" AS actor ON actor.id = membership."userId"
      WHERE membership."userId" = guestpost_rls.actor_id()
        AND membership.role::text = ANY (allowed_roles)
        AND actor."userType" = 'STAFF'
        AND actor.banned = false
    );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.website(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."Website" AS website
    WHERE website.id = target_id
      AND website."publisherId" IS NOT NULL
      AND guestpost_rls.publisher(website."publisherId")
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.listing(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."MarketplaceListing" AS listing
    WHERE listing.id = target_id
      AND (
        guestpost_rls.customer_organization(listing."organizationId")
        OR guestpost_rls.publisher(listing."publisherId")
      )
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.public_listing(target_id text)
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
    WHERE listing.id = target_id
      AND listing.status = 'APPROVED'
      AND listing.verified = true
      AND website."isActive" = true
      AND website."verificationStatus" = 'VERIFIED'
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.public_website(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."MarketplaceListing" AS listing
    WHERE listing."websiteId" = target_id
      AND guestpost_rls.public_listing(listing.id)
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.public_publisher(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."MarketplaceListing" AS listing
    WHERE listing."publisherId" = target_id
      AND guestpost_rls.public_listing(listing.id)
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.order_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public."Order" AS customer_order
    LEFT JOIN public."Website" AS website ON website.id = customer_order."websiteId"
    LEFT JOIN public."MarketplaceListing" AS listing ON listing.id = customer_order."listingId"
    WHERE customer_order.id = target_id
      AND (
        guestpost_rls.customer_organization(customer_order."organizationId")
        OR guestpost_rls.publisher(website."publisherId")
        OR guestpost_rls.publisher(listing."publisherId")
      )
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.wallet_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."Wallet" AS wallet
    WHERE wallet.id = target_id
      AND (
        guestpost_rls.customer_organization(wallet."organizationId")
        OR guestpost_rls.publisher_organization(wallet."organizationId")
        OR guestpost_rls.self_user(wallet."userId")
      )
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.withdrawal_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."Withdrawal" AS withdrawal
    WHERE withdrawal.id = target_id
      AND guestpost_rls.publisher(withdrawal."publisherId")
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.payout_execution_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."PayoutExecution" AS execution
    WHERE execution.id = target_id
      AND guestpost_rls.withdrawal_access(execution."withdrawalId")
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.saved_list_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."MarketplaceSavedList" AS list
    WHERE list.id = target_id AND guestpost_rls.self_user(list."userId")
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.integration_access(target_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."PublisherIntegration" AS integration
    WHERE integration.id = target_id
      AND integration."ownerType" = 'PUBLISHER'
      AND guestpost_rls.publisher(integration."ownerId")
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.communication_scope(
  aggregate_type text,
  aggregate_id text,
  organization_id text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF guestpost_rls.customer_organization(organization_id)
     OR guestpost_rls.publisher_organization(organization_id)
  THEN
    RETURN true;
  END IF;

  CASE aggregate_type
    WHEN 'Order' THEN RETURN guestpost_rls.order_access(aggregate_id);
    WHEN 'Publisher' THEN RETURN guestpost_rls.publisher(aggregate_id);
    WHEN 'MarketplaceListing'
      THEN RETURN guestpost_rls.listing(aggregate_id);
    WHEN 'Withdrawal'
      THEN RETURN guestpost_rls.withdrawal_access(aggregate_id);
    WHEN 'Settlement' THEN RETURN EXISTS (
      SELECT 1 FROM public."Settlement" AS settlement
      WHERE settlement.id = aggregate_id
        AND guestpost_rls.order_access(settlement."orderId")
    );
    WHEN 'Ticket' THEN RETURN EXISTS (
      SELECT 1 FROM public."Ticket" AS ticket
      WHERE ticket.id = aggregate_id
        AND (
          guestpost_rls.customer_organization(ticket."organizationId")
          OR guestpost_rls.publisher(ticket."assignedPublisherId")
        )
    );
    WHEN 'TicketMessage' THEN RETURN EXISTS (
      SELECT 1
      FROM public."TicketMessage" AS message
      JOIN public."Ticket" AS ticket ON ticket.id = message."ticketId"
      WHERE message.id = aggregate_id
        AND (
          guestpost_rls.customer_organization(ticket."organizationId")
          OR guestpost_rls.publisher(ticket."assignedPublisherId")
        )
    );
    ELSE RETURN false;
  END CASE;
END
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.communication_event_access(
  target_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."CommunicationEvent" AS event
    WHERE event.id = target_id
      AND guestpost_rls.communication_scope(
        event."aggregateType", event."aggregateId", event."organizationId"
      )
  );
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.catalog_read(
  model_name text,
  row_data jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  CASE model_name
    WHEN 'MarketplaceCategory'
      THEN RETURN COALESCE((row_data->>'isActive')::boolean, false);
    WHEN 'MarketplaceTag'
      THEN RETURN true;
    WHEN 'MarketplaceListing'
      THEN RETURN guestpost_rls.public_listing(row_data->>'id');
    WHEN 'Publisher'
      THEN RETURN guestpost_rls.public_publisher(row_data->>'id');
    WHEN 'PublisherProfile'
      THEN RETURN guestpost_rls.public_publisher(row_data->>'publisherId');
    WHEN 'Website'
      THEN RETURN guestpost_rls.public_website(row_data->>'id');
    WHEN 'WebsiteMetric'
      THEN RETURN guestpost_rls.public_website(row_data->>'websiteId');
    WHEN 'MarketplaceReview'
      THEN RETURN row_data->>'status' = 'APPROVED'
        AND guestpost_rls.public_listing(row_data->>'listingId');
    WHEN 'ListingService'
      THEN RETURN row_data->>'availability' IN ('AVAILABLE', 'WAITLIST')
        AND guestpost_rls.public_listing(row_data->>'listingId');
    WHEN 'MarketplaceListingCategory', 'MarketplaceListingTag',
         'MarketplaceListingImage'
      THEN RETURN guestpost_rls.public_listing(row_data->>'listingId');
    WHEN 'MarketplaceSavedList'
      THEN RETURN COALESCE((row_data->>'isPublic')::boolean, false);
    ELSE
      RETURN false;
  END CASE;
END
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.api_actor_row(
  model_name text,
  row_data jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  CASE model_name
    WHEN 'User' THEN RETURN guestpost_rls.self_user(row_data->>'id');
    WHEN 'LegalAcceptance', 'Session', 'Account', 'ActiveContext',
         'NotificationPreference', 'EmailSuppression', 'MarketplaceFavorite',
         'MarketplaceSearchHistory', 'MarketplaceRecommendation'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId');
    WHEN 'MarketplaceSavedList'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId');
    WHEN 'MarketplaceSavedListItem'
      THEN RETURN guestpost_rls.saved_list_access(row_data->>'listId');

    WHEN 'Organization'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'id')
        OR guestpost_rls.publisher_organization(row_data->>'id');
    WHEN 'Membership'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.customer_organization(row_data->>'organizationId');
    WHEN 'PublisherMembership'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.publisher(row_data->>'publisherId');
    WHEN 'StaffMembership'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId');
    WHEN 'BillingProfile', 'Team', 'Campaign'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'organizationId');
    WHEN 'ApiKey'
      THEN RETURN current_setting('guestpost.rls_organization_role', true) = 'OWNER'
        AND guestpost_rls.customer_organization_owner(
          row_data->>'organizationId'
        );

    WHEN 'Publisher', 'PublisherBalance', 'Withdrawal', 'PayoutMethod',
         'PublisherProviderAccount', 'PublisherProfile'
      THEN RETURN guestpost_rls.publisher(
        CASE WHEN model_name = 'Publisher' THEN row_data->>'id'
             ELSE row_data->>'publisherId' END
      );

    WHEN 'Website'
      THEN RETURN guestpost_rls.publisher(row_data->>'publisherId');
    WHEN 'WebsiteMetric', 'WebsiteMetricRevision', 'WebsiteSearchDaily',
         'WebsiteAnalyticsDaily', 'WebsitePageSearchDaily'
      THEN RETURN guestpost_rls.website(row_data->>'websiteId');
    WHEN 'WebsiteImportBatch'
      THEN RETURN guestpost_rls.publisher(row_data->>'publisherId');
    WHEN 'WebsiteImportRow'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."WebsiteImportBatch" AS batch
        WHERE batch.id = row_data->>'batchId'
          AND guestpost_rls.publisher(batch."publisherId")
      );

    WHEN 'Order'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.order_access(row_data->>'id');
    WHEN 'OrderItem', 'OrderEvent', 'OrderDispute',
         'OrderCancellationRequest', 'PublisherCompensation', 'Settlement',
         'FulfillmentAssignment', 'OrderDeliveryVersion', 'DeliveryFraudFlag',
         'DeliveryFraudHold', 'DeliveryFraudFlagResolution',
         'DeliveryFraudFinding', 'OrderReview', 'ContentOrder',
         'OrderArticleVersion', 'Revision', 'Report', 'PlatformRevenue'
      THEN RETURN guestpost_rls.order_access(row_data->>'orderId');
    WHEN 'Publication'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."OrderItem" AS item
        WHERE item.id = row_data->>'orderItemId'
          AND guestpost_rls.order_access(item."orderId")
      );
    WHEN 'SettlementApproval'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."Settlement" AS settlement
        WHERE settlement.id = row_data->>'settlementId'
          AND guestpost_rls.order_access(settlement."orderId")
      );
    WHEN 'DeliveryVerificationEvidence', 'DeliverySnapshot'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."OrderDeliveryVersion" AS version
        WHERE version.id = row_data->>'deliveryVersionId'
          AND guestpost_rls.order_access(version."orderId")
      );

    WHEN 'Wallet'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.publisher_organization(row_data->>'organizationId')
        OR guestpost_rls.self_user(row_data->>'userId');
    WHEN 'Transaction'
      THEN RETURN guestpost_rls.wallet_access(row_data->>'walletId')
        OR guestpost_rls.order_access(row_data->>'orderId')
        OR guestpost_rls.publisher(row_data->>'publisherId');
    WHEN 'DepositAttempt'
      THEN RETURN guestpost_rls.wallet_access(row_data->>'walletId');
    WHEN 'DepositCreditRecovery'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."DepositAttempt" AS attempt
        WHERE attempt.id = row_data->>'depositAttemptId'
          AND guestpost_rls.wallet_access(attempt."walletId")
      );
    WHEN 'DepositCreditEvidence'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."DepositAttempt" AS attempt
        WHERE attempt.id = row_data->>'depositAttemptId'
          AND guestpost_rls.wallet_access(attempt."walletId")
      );
    WHEN 'PaymentDispute'
      THEN RETURN guestpost_rls.wallet_access(row_data->>'walletId');
    WHEN 'PaymentProviderEvent'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."DepositAttempt" AS attempt
        WHERE attempt.id = row_data->>'depositAttemptId'
          AND guestpost_rls.wallet_access(attempt."walletId")
      );

    WHEN 'PayoutExecution'
      THEN RETURN guestpost_rls.withdrawal_access(row_data->>'withdrawalId');
    WHEN 'PayoutExecutionClaim'
      THEN RETURN guestpost_rls.payout_execution_access(row_data->>'executionId');
    WHEN 'WithdrawalAllocation'
      THEN RETURN guestpost_rls.withdrawal_access(row_data->>'withdrawalId');

    WHEN 'Ticket'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.publisher(row_data->>'assignedPublisherId');
    WHEN 'TicketMessage'
      THEN RETURN EXISTS (
        SELECT 1 FROM public."Ticket" AS ticket
        WHERE ticket.id = row_data->>'ticketId'
          AND (
            guestpost_rls.customer_organization(ticket."organizationId")
            OR guestpost_rls.publisher(ticket."assignedPublisherId")
          )
      );

    WHEN 'Notification'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.publisher_organization(row_data->>'organizationId')
        OR guestpost_rls.communication_event_access(row_data->>'eventId');
    WHEN 'CommunicationDelivery'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.communication_event_access(row_data->>'eventId');
    WHEN 'CommunicationEvent'
      THEN RETURN guestpost_rls.communication_scope(
        row_data->>'aggregateType', row_data->>'aggregateId',
        row_data->>'organizationId'
      );
    WHEN 'FinancialDocument'
      THEN RETURN guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.publisher_organization(row_data->>'organizationId');
    WHEN 'AuditLog'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.customer_organization(row_data->>'organizationId')
        OR guestpost_rls.publisher_organization(row_data->>'organizationId');

    WHEN 'MarketplaceListing'
      THEN RETURN guestpost_rls.listing(row_data->>'id');
    WHEN 'ModerationEvent'
      THEN RETURN guestpost_rls.listing(row_data->>'listingId')
        OR guestpost_rls.website(row_data->>'websiteId');
    WHEN 'MarketplaceListingCategory', 'MarketplaceListingTag',
         'MarketplaceListingImage',
         'MarketplaceListingView', 'MarketplaceListingClick',
         'ListingFulfillmentRule'
      THEN RETURN guestpost_rls.listing(row_data->>'listingId');
    WHEN 'MarketplaceReview'
      THEN RETURN guestpost_rls.self_user(row_data->>'userId')
        OR guestpost_rls.listing(row_data->>'listingId');
    WHEN 'ListingService'
      THEN RETURN guestpost_rls.listing(row_data->>'listingId');

    WHEN 'ExternalAccount'
      THEN RETURN row_data->>'ownerType' = 'PUBLISHER'
        AND guestpost_rls.publisher(row_data->>'ownerId');
    WHEN 'PublisherIntegration'
      THEN RETURN row_data->>'ownerType' = 'PUBLISHER'
        AND guestpost_rls.publisher(row_data->>'ownerId');
    WHEN 'IntegrationSchedule', 'IntegrationDiscovery', 'IntegrationSync'
      THEN RETURN guestpost_rls.integration_access(row_data->>'integrationId');
    WHEN 'WebsiteIntegration'
      THEN RETURN guestpost_rls.integration_access(row_data->>'integrationId')
        AND guestpost_rls.website(row_data->>'websiteId');
    ELSE
      RETURN false;
  END CASE;
END
$function$;

-- Row ownership and command authorization are separate decisions. In
-- particular, a MEMBER must never be able to turn its own Membership row into
-- OWNER, and a publisher member must not mint a PUBLISHER_OWNER grant.
CREATE OR REPLACE FUNCTION guestpost_rls.api_actor_command_allowed(
  model_name text,
  command_name text,
  row_data jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF command_name = 'SELECT' THEN
    RETURN guestpost_rls.api_actor_row(model_name, row_data);
  END IF;

  IF model_name = 'User' THEN
    RETURN guestpost_rls.self_user(row_data->>'id')
      AND row_data->>'userType' = current_setting(
        'guestpost.rls_actor_kind', true
      );
  END IF;

  IF model_name = 'Membership' THEN
    RETURN guestpost_rls.customer_organization_owner(
      row_data->>'organizationId'
    ) OR (
      command_name IN ('UPDATE', 'DELETE')
      AND guestpost_rls.self_user(row_data->>'userId')
    );
  END IF;

  IF model_name IN ('Organization', 'ApiKey') THEN
    RETURN guestpost_rls.customer_organization_owner(
      CASE WHEN model_name = 'Organization' THEN row_data->>'id'
           ELSE row_data->>'organizationId' END
    );
  END IF;

  IF model_name = 'PublisherMembership' THEN
    RETURN guestpost_rls.publisher_owner(row_data->>'publisherId');
  END IF;

  IF model_name = 'Publisher' THEN
    RETURN guestpost_rls.publisher_owner(row_data->>'id');
  END IF;

  -- Audit records are append-only for every API actor. Their owning tenant is
  -- still checked by api_actor_row below.
  IF model_name = 'AuditLog' AND command_name <> 'INSERT' THEN
    RETURN false;
  END IF;

  RETURN guestpost_rls.api_actor_row(model_name, row_data);
END
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.staff_command_allowed(
  model_name text,
  command_name text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF model_name = 'AuditLog' AND command_name <> 'SELECT' THEN
    RETURN command_name = 'INSERT'
      AND guestpost_rls.staff_role_in(
        ARRAY['SUPER_ADMIN', 'OPERATIONS', 'FINANCE']
      );
  END IF;

  IF guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN']) THEN
    RETURN true;
  END IF;

  IF guestpost_rls.staff_role_in(ARRAY['OPERATIONS']) THEN
    IF command_name = 'SELECT' THEN
      RETURN model_name <> ALL (ARRAY[
        'Verification', 'Session', 'Account', 'BillingProfile',
        'PublisherProviderAccount', 'PayoutMethod'
      ]);
    END IF;
    RETURN model_name = ANY (ARRAY[
      'User', 'ActiveContext', 'Organization', 'Publisher', 'Website',
      'WebsiteMetric', 'WebsiteMetricRevision', 'WebsiteImportBatch',
      'WebsiteImportRow', 'Order', 'OrderItem', 'OrderEvent', 'Publication',
      'OrderDispute', 'OrderCancellationRequest', 'FulfillmentAssignment',
      'OrderDeliveryVersion', 'DeliveryVerificationEvidence',
      'DeliverySnapshot', 'DeliveryFraudFlag', 'DeliveryFraudHold',
      'DeliveryFraudFlagResolution', 'DeliveryFraudFinding', 'Ticket',
      'TicketMessage', 'Notification', 'CommunicationEvent',
      'CommunicationDelivery', 'MarketplaceCategory',
      'MarketplaceTag', 'MarketplaceListing', 'ModerationEvent',
      'MarketplaceListingCategory', 'ListingService',
      'MarketplaceListingTag', 'MarketplaceListingImage',
      'MarketplaceReview', 'MarketplaceFlag', 'ListingFulfillmentRule',
      'PublisherProfile'
    ]);
  END IF;

  IF guestpost_rls.staff_role_in(ARRAY['FINANCE']) THEN
    IF command_name = 'SELECT' THEN
      RETURN model_name = ANY (ARRAY[
        'User', 'Organization', 'Publisher', 'Order', 'OrderItem',
        'OrderEvent', 'OrderDispute', 'OrderCancellationRequest',
        'PublisherCompensation', 'Settlement', 'SettlementApproval',
        'DeliveryFraudFlag', 'DeliveryFraudHold',
        'DeliveryFraudFlagResolution', 'DeliveryFraudFinding',
        'PublisherBalance', 'Withdrawal', 'PayoutMethod',
        'PublisherProviderAccount', 'PayoutProvider', 'PayoutExecution',
        'PayoutExecutionClaim', 'WithdrawalAllocation', 'PayoutWebhookEvent',
        'PayoutBatch', 'PlatformRevenue', 'Wallet', 'Transaction',
        'DepositAttempt', 'DepositCreditRecovery', 'DepositCreditEvidence',
        'PaymentProviderEvent', 'PaymentDispute', 'Ticket', 'TicketMessage',
        'Notification', 'CommunicationEvent', 'CommunicationDelivery',
        'FinancialDocument', 'AuditLog', 'PlatformSettings'
      ]);
    END IF;
    RETURN model_name = ANY (ARRAY[
      'OrderEvent', 'OrderCancellationRequest', 'PublisherCompensation',
      'Settlement', 'SettlementApproval', 'DeliveryFraudFlag',
      'DeliveryFraudHold', 'DeliveryFraudFlagResolution',
      'DeliveryFraudFinding', 'PublisherBalance', 'Withdrawal',
      'PayoutExecution', 'PayoutExecutionClaim', 'WithdrawalAllocation',
      'PayoutWebhookEvent', 'PayoutBatch', 'PlatformRevenue', 'Wallet',
      'Transaction', 'DepositAttempt', 'DepositCreditRecovery',
      'DepositCreditEvidence', 'PaymentProviderEvent', 'PaymentDispute',
      'Notification', 'CommunicationEvent', 'CommunicationDelivery',
      'FinancialDocument'
    ]);
  END IF;

  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.authorize(
  invoker_name text,
  model_name text,
  command_name text,
  row_data jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  -- Better Auth has a distinct connection identity and no access to ordinary
  -- business rows beyond birth-time account provisioning.
  IF guestpost_rls.role_member(invoker_name, 'guestpost_auth_group') THEN
    IF model_name = 'AuditLog' AND command_name <> 'SELECT' THEN
      RETURN command_name = 'INSERT';
    END IF;
    RETURN model_name = ANY (ARRAY[
      'User', 'LegalAcceptance', 'Session', 'Account', 'Verification',
      'ActiveContext', 'Organization', 'Membership', 'PublisherMembership',
      'Publisher', 'PublisherBalance', 'Wallet', 'AuditLog'
    ]);
  END IF;

  IF guestpost_rls.role_member(invoker_name, 'guestpost_worker_group')
     AND current_setting('guestpost.rls_workload', true) = 'WORKER'
     AND NULLIF(current_setting('guestpost.rls_worker', true), '') IS NOT NULL
  THEN
    RETURN model_name = ANY (ARRAY[
      'User', 'StaffMembership', 'PublisherMembership', 'Publisher', 'Website',
      'WebsiteMetric', 'WebsiteMetricRevision', 'Order', 'OrderItem',
      'OrderEvent', 'Publication', 'OrderDispute', 'OrderCancellationRequest',
      'PublisherCompensation', 'Settlement', 'SettlementApproval',
      'FulfillmentAssignment', 'OrderDeliveryVersion',
      'DeliveryUrlClaimFence', 'DeliveryVerificationEvidence',
      'DeliverySnapshot', 'DeliveryFraudFlag', 'DeliveryFraudHold',
      'DeliveryFraudFlagResolution', 'DeliveryFraudFinding', 'OrderReview',
      'PublisherBalance', 'Withdrawal', 'PayoutMethod',
      'PublisherProviderAccount', 'PayoutProvider', 'PayoutExecution',
      'PayoutExecutionClaim', 'WithdrawalAllocation', 'PayoutWebhookEvent',
      'PayoutBatch', 'ContentOrder', 'OrderArticleVersion', 'Revision',
      'Report', 'PlatformRevenue', 'Wallet', 'Transaction', 'DepositAttempt',
      'DepositCreditRecovery', 'DepositCreditEvidence',
      'PaymentProviderEvent', 'PaymentDispute', 'Notification',
      'CommunicationEvent', 'CommunicationDelivery', 'FinancialDocument',
      'EmailSuppression', 'AuditLog', 'MarketplaceListing', 'ModerationEvent',
      'ListingService', 'PublisherProfile', 'MarketplaceFlag',
      'PlatformSettings', 'ExternalAccount', 'PublisherIntegration',
      'IntegrationSchedule', 'IntegrationDiscovery', 'WebsiteIntegration',
      'IntegrationSync', 'WebsiteSearchDaily', 'WebsiteAnalyticsDaily',
      'WebsitePageSearchDaily'
    ]);
  END IF;

  IF NOT guestpost_rls.role_member(invoker_name, 'guestpost_api_group') THEN
    RETURN false;
  END IF;

  IF current_setting('guestpost.rls_workload', true) = 'PUBLIC' THEN
    IF command_name = 'SELECT' THEN
      RETURN guestpost_rls.catalog_read(model_name, row_data);
    END IF;
    IF command_name = 'INSERT' AND model_name = 'MarketplaceSearchHistory' THEN
      RETURN NULLIF(row_data->>'userId', '') IS NULL;
    END IF;
    IF command_name = 'INSERT' AND model_name IN (
      'MarketplaceListingView', 'MarketplaceListingClick'
    ) THEN
      RETURN NULLIF(row_data->>'userId', '') IS NULL
        AND guestpost_rls.public_listing(row_data->>'listingId');
    END IF;
    RETURN false;
  END IF;

  IF current_setting('guestpost.rls_workload', true) = 'WEBHOOK' THEN
    CASE current_setting('guestpost.rls_ingress', true)
      WHEN 'STRIPE' THEN
        RETURN model_name = ANY (ARRAY[
          'Wallet', 'Transaction', 'DepositAttempt', 'DepositCreditRecovery',
          'DepositCreditEvidence', 'PaymentProviderEvent', 'PaymentDispute',
          'Order', 'OrderEvent', 'Notification', 'CommunicationEvent',
          'CommunicationDelivery', 'FinancialDocument', 'AuditLog'
        ]);
      WHEN 'PAYOUT_PROVIDER' THEN
        RETURN model_name = ANY (ARRAY[
          'Publisher', 'PublisherBalance', 'Withdrawal', 'PayoutMethod',
          'PublisherProviderAccount', 'PayoutProvider', 'PayoutExecution',
          'PayoutExecutionClaim', 'WithdrawalAllocation', 'PayoutWebhookEvent',
          'Transaction', 'Notification', 'CommunicationEvent',
          'CommunicationDelivery', 'FinancialDocument', 'AuditLog'
        ]);
      WHEN 'INTEGRATION_OAUTH' THEN
        RETURN model_name = ANY (ARRAY[
          'ExternalAccount', 'PublisherIntegration', 'IntegrationSchedule',
          'IntegrationDiscovery', 'WebsiteIntegration', 'IntegrationSync',
          'Website', 'AuditLog'
        ]);
      ELSE RETURN false;
    END CASE;
  END IF;

  IF current_setting('guestpost.rls_actor_kind', true) = 'STAFF' THEN
    RETURN guestpost_rls.staff_command_allowed(model_name, command_name);
  END IF;

  -- Customer and publisher sessions may browse the same reviewed catalog
  -- outside their ownership boundary. The live self_user check prevents a
  -- stale/suspended actor from retaining this read/write surface.
  IF current_setting('guestpost.rls_workload', true) = 'API'
     AND current_setting('guestpost.rls_actor_kind', true) IN ('CUSTOMER', 'PUBLISHER')
     AND guestpost_rls.self_user(guestpost_rls.actor_id())
  THEN
    IF command_name = 'SELECT'
       AND guestpost_rls.catalog_read(model_name, row_data)
    THEN
      RETURN true;
    END IF;
    IF command_name = 'INSERT' AND model_name = 'MarketplaceSearchHistory' THEN
      RETURN NULLIF(row_data->>'userId', '') IS NULL
        OR row_data->>'userId' = guestpost_rls.actor_id();
    END IF;
    IF command_name = 'INSERT' AND model_name IN (
      'MarketplaceListingView', 'MarketplaceListingClick'
    ) THEN
      RETURN (NULLIF(row_data->>'userId', '') IS NULL
          OR row_data->>'userId' = guestpost_rls.actor_id())
        AND guestpost_rls.public_listing(row_data->>'listingId');
    END IF;
  END IF;

  -- This row contains only a normalized URL and monotonic lock version. It is
  -- a platform coordination primitive used by a SECURITY INVOKER function and
  -- delivery triggers, not tenant data. A live API actor may acquire it; direct
  -- function execution is still restricted to the API/worker groups.
  IF model_name = 'DeliveryUrlClaimFence'
     AND current_setting('guestpost.rls_workload', true) = 'API'
     AND (
       guestpost_rls.self_user(guestpost_rls.actor_id())
       OR guestpost_rls.staff_role_in(
         ARRAY['SUPER_ADMIN', 'OPERATIONS', 'FINANCE']
       )
     )
  THEN
    RETURN true;
  END IF;

  RETURN guestpost_rls.api_actor_command_allowed(
    model_name, command_name, row_data
  );
END
$function$;

CREATE OR REPLACE FUNCTION guestpost_rls.enforce_membership_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_owner_count integer;
BEGIN
  IF current_setting('guestpost.rls_workload', true) <> 'API'
     OR current_setting('guestpost.rls_actor_kind', true) <> 'CUSTOMER'
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."userId" = guestpost_rls.actor_id()
     AND NOT guestpost_rls.customer_organization_owner(OLD."organizationId")
     AND NOT (
       OLD.status = 'PENDING'
       AND NEW.status = 'ACTIVE'
       AND (to_jsonb(OLD) - 'status' - 'updatedAt')
         = (to_jsonb(NEW) - 'status' - 'updatedAt')
     )
  THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'membership self-update is limited to accepting an unchanged pending invitation';
  END IF;

  IF OLD.role = 'OWNER' AND OLD.status = 'ACTIVE'
     AND (
       TG_OP = 'DELETE'
       OR NEW.role <> 'OWNER'
       OR NEW.status <> 'ACTIVE'
       OR NEW."organizationId" <> OLD."organizationId"
     )
  THEN
    SELECT count(*) INTO active_owner_count
    FROM public."Membership" AS membership
    WHERE membership."organizationId" = OLD."organizationId"
      AND membership.role = 'OWNER'
      AND membership.status = 'ACTIVE';

    IF active_owner_count <= 1 THEN
      RAISE insufficient_privilege
        USING MESSAGE = 'cannot remove or demote the last active organization owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER guestpost_rls_membership_transition
BEFORE UPDATE OR DELETE ON public."Membership"
FOR EACH ROW EXECUTE FUNCTION guestpost_rls.enforce_membership_transition();

CREATE OR REPLACE FUNCTION guestpost_rls.enforce_publisher_owner_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_owner_count integer;
BEGIN
  IF current_setting('guestpost.rls_workload', true) <> 'API'
     OR current_setting('guestpost.rls_actor_kind', true) <> 'PUBLISHER'
     OR OLD.role <> 'PUBLISHER_OWNER'
     OR NOT (
       TG_OP = 'DELETE'
       OR NEW.role <> 'PUBLISHER_OWNER'
       OR NEW."publisherId" <> OLD."publisherId"
     )
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO active_owner_count
  FROM public."PublisherMembership" AS membership
  WHERE membership."publisherId" = OLD."publisherId"
    AND membership.role = 'PUBLISHER_OWNER';

  IF active_owner_count <= 1 THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'cannot remove or demote the last publisher owner';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER guestpost_rls_publisher_owner_transition
BEFORE UPDATE OR DELETE ON public."PublisherMembership"
FOR EACH ROW EXECUTE FUNCTION guestpost_rls.enforce_publisher_owner_transition();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA guestpost_rls FROM PUBLIC;

-- Create an explicit CRUD policy set for every Prisma model. Policies are
-- installed now but remain inert until the activation gate enables and forces
-- RLS on the complete catalog in one transaction.
DO $policies$
DECLARE
  model_name text;
  models constant text[] := ARRAY[
    'User','LegalAcceptance','Session','Account','Verification','ActiveContext',
    'Organization','BillingProfile','Membership','PublisherMembership',
    'StaffMembership','Team','Publisher','Website','WebsiteMetric',
    'WebsiteMetricRevision','WebsiteImportBatch','WebsiteImportRow','Order',
    'Campaign','OrderItem','OrderEvent','Publication','OrderDispute',
    'OrderCancellationRequest','PublisherCompensation','Settlement',
    'SettlementApproval','FulfillmentAssignment','OrderDeliveryVersion',
    'DeliveryUrlClaimFence','DeliveryVerificationEvidence','DeliverySnapshot',
    'DeliveryFraudFlag','DeliveryFraudHold','DeliveryFraudFlagResolution',
    'DeliveryFraudFinding','OrderReview','PublisherBalance','Withdrawal',
    'PayoutMethod','PublisherProviderAccount','PayoutProvider','PayoutExecution',
    'PayoutExecutionClaim','WithdrawalAllocation','PayoutWebhookEvent',
    'PayoutBatch','ApiKey','ContentOrder','OrderArticleVersion','Revision',
    'Report','PlatformRevenue','Wallet','Transaction','DepositAttempt',
    'DepositCreditRecovery','DepositCreditEvidence','PaymentProviderEvent',
    'PaymentDispute','Ticket','TicketMessage','Notification',
    'CommunicationEvent','CommunicationDelivery','FinancialDocument',
    'NotificationPreference','EmailSuppression','AuditLog',
    'MarketplaceCategory','MarketplaceTag','MarketplaceListing',
    'ModerationEvent','MarketplaceListingCategory','ListingService',
    'MarketplaceListingTag','MarketplaceListingImage','MarketplaceReview',
    'MarketplaceFavorite','MarketplaceSavedList','MarketplaceSavedListItem',
    'MarketplaceListingView','MarketplaceListingClick',
    'MarketplaceSearchHistory','MarketplaceRecommendation','PublisherProfile',
    'MarketplaceFlag','ListingFulfillmentRule','PlatformSettings',
    'ExternalAccount','PublisherIntegration','IntegrationSchedule',
    'IntegrationDiscovery','WebsiteIntegration','IntegrationSync',
    'WebsiteSearchDaily','WebsiteAnalyticsDaily','WebsitePageSearchDaily'
  ];
BEGIN
  FOREACH model_name IN ARRAY models LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      model_name || '_full_boundary_select', model_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (' ||
      'current_user = ''guestpost_rls_authorizer'' OR ' ||
      'guestpost_rls.authorize(current_user, %L, ''SELECT'', to_jsonb(%I.*)))',
      model_name || '_full_boundary_select', model_name, model_name, model_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      model_name || '_full_boundary_insert', model_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (' ||
      'guestpost_rls.authorize(current_user, %L, ''INSERT'', to_jsonb(%I.*)))',
      model_name || '_full_boundary_insert', model_name, model_name, model_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      model_name || '_full_boundary_update', model_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (' ||
      'guestpost_rls.authorize(current_user, %L, ''UPDATE'', to_jsonb(%I.*))) ' ||
      'WITH CHECK (guestpost_rls.authorize(current_user, %L, ''UPDATE'', to_jsonb(%I.*)))',
      model_name || '_full_boundary_update', model_name,
      model_name, model_name, model_name, model_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      model_name || '_full_boundary_delete', model_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (' ||
      'guestpost_rls.authorize(current_user, %L, ''DELETE'', to_jsonb(%I.*)))',
      model_name || '_full_boundary_delete', model_name, model_name, model_name
    );
  END LOOP;
END
$policies$;
