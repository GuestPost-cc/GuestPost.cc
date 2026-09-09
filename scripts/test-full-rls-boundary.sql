-- Destructive fixture test for a disposable database only.
--
-- Prerequisites: all migrations, provision-rls-roles.sql, ownership transfer,
-- and activate-full-rls.sql have completed. The connected role must be a
-- superuser so this script can seed fixed fixtures and SET ROLE to each
-- NOLOGIN runtime identity. Run this only against an ephemeral clone/CI DB.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(value boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF value IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS assertion failed: %', message;
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.set_rls_context(
  workload text,
  actor_kind text DEFAULT '',
  actor_id text DEFAULT '',
  organization_id text DEFAULT '',
  organization_role text DEFAULT '',
  publisher_id text DEFAULT '',
  publisher_role text DEFAULT '',
  staff_role text DEFAULT '',
  ingress text DEFAULT '',
  worker_name text DEFAULT ''
)
RETURNS void
LANGUAGE sql
AS $function$
  SELECT set_config('guestpost.rls_workload', workload, true),
         set_config('guestpost.rls_actor_kind', actor_kind, true),
         set_config('guestpost.rls_actor_id', actor_id, true),
         set_config('guestpost.rls_organization_id', organization_id, true),
         set_config('guestpost.rls_organization_role', organization_role, true),
         set_config('guestpost.rls_publisher_id', publisher_id, true),
         set_config('guestpost.rls_publisher_role', publisher_role, true),
         set_config('guestpost.rls_staff_role', staff_role, true),
         set_config('guestpost.rls_staff_permissions', '[]', true),
         set_config('guestpost.rls_ingress', ingress, true),
         set_config('guestpost.rls_worker', worker_name, true),
         set_config('guestpost.rls_resource_id', '', true),
         set_config('guestpost.rls_api_key_hash', '', true);
$function$;

CREATE OR REPLACE FUNCTION pg_temp.assert_rejected(statement text, message text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RETURN;
  END;
  RAISE EXCEPTION 'RLS assertion failed: %', message;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.assert_affected_rows(
  statement text,
  expected_rows bigint,
  message text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  affected_rows bigint;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> expected_rows THEN
    RAISE EXCEPTION 'RLS assertion failed: % (expected %, got %)',
      message, expected_rows, affected_rows;
  END IF;
END
$function$;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 99
   FROM pg_class AS relation
   JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relkind = 'r'
     AND relation.relname <> '_prisma_migrations'
     AND relation.relrowsecurity
     AND relation.relforcerowsecurity),
  'all 99 application tables must have ENABLE + FORCE RLS'
);

BEGIN;

INSERT INTO public."User" (id, email, "userType", "updatedAt") VALUES
  ('rls_customer_owner', 'rls-customer-owner@example.test', 'CUSTOMER', now()),
  ('rls_customer_member', 'rls-customer-member@example.test', 'CUSTOMER', now()),
  ('rls_customer_b', 'rls-customer-b@example.test', 'CUSTOMER', now()),
  ('rls_publisher_a_user', 'rls-publisher-a@example.test', 'PUBLISHER', now()),
  ('rls_publisher_a_member', 'rls-publisher-a-member@example.test', 'PUBLISHER', now()),
  ('rls_publisher_b_user', 'rls-publisher-b@example.test', 'PUBLISHER', now()),
  ('rls_staff_operations', 'rls-staff-operations@example.test', 'STAFF', now()),
  ('rls_staff_finance', 'rls-staff-finance@example.test', 'STAFF', now()),
  ('rls_staff_admin', 'rls-staff-admin@example.test', 'STAFF', now());

INSERT INTO public."Organization" (id, name, slug, "updatedAt") VALUES
  ('rls_org_a', 'RLS Organization A', 'rls-org-a', now()),
  ('rls_org_b', 'RLS Organization B', 'rls-org-b', now()),
  ('rls_pub_org_a', 'RLS Publisher Organization A', 'rls-pub-org-a', now()),
  ('rls_pub_org_b', 'RLS Publisher Organization B', 'rls-pub-org-b', now());

INSERT INTO public."Membership"
  (id, role, "userId", "organizationId", status, "updatedAt") VALUES
  ('rls_membership_owner', 'OWNER', 'rls_customer_owner', 'rls_org_a', 'ACTIVE', now()),
  ('rls_membership_member', 'MEMBER', 'rls_customer_member', 'rls_org_a', 'ACTIVE', now()),
  ('rls_membership_b', 'OWNER', 'rls_customer_b', 'rls_org_b', 'ACTIVE', now()),
  ('rls_membership_pending', 'MEMBER', 'rls_customer_b', 'rls_org_a', 'PENDING', now());

INSERT INTO public."Publisher" (id, name, "organizationId", "updatedAt") VALUES
  ('rls_publisher_a', 'RLS Publisher A', 'rls_pub_org_a', now()),
  ('rls_publisher_b', 'RLS Publisher B', 'rls_pub_org_b', now());

INSERT INTO public."PublisherMembership"
  (id, role, "userId", "publisherId", "updatedAt") VALUES
  ('rls_publisher_membership_a', 'PUBLISHER_OWNER', 'rls_publisher_a_user', 'rls_publisher_a', now()),
  ('rls_publisher_membership_a_member', 'PUBLISHER_MEMBER', 'rls_publisher_a_member', 'rls_publisher_a', now()),
  ('rls_publisher_membership_b', 'PUBLISHER_OWNER', 'rls_publisher_b_user', 'rls_publisher_b', now());

INSERT INTO public."StaffMembership" (id, role, "userId", "updatedAt") VALUES
  ('rls_staff_membership_operations', 'OPERATIONS', 'rls_staff_operations', now()),
  ('rls_staff_membership_finance', 'FINANCE', 'rls_staff_finance', now()),
  ('rls_staff_membership_admin', 'SUPER_ADMIN', 'rls_staff_admin', now());

INSERT INTO public."Website"
  (id, url, "publisherId", "verificationStatus", "verifiedAt", "updatedAt") VALUES
  ('rls_web_a', 'https://rls-a.example.test', 'rls_publisher_a', 'VERIFIED', now(), now()),
  ('rls_private_web_a', 'https://rls-private-a.example.test', 'rls_publisher_a', 'VERIFIED', now(), now()),
  ('rls_web_b', 'https://rls-b.example.test', 'rls_publisher_b', 'VERIFIED', now(), now());

INSERT INTO public."MarketplaceListing"
  (id, title, slug, description, status, verified, "publisherId", "websiteId", "updatedAt") VALUES
  ('rls_listing_public', 'RLS Public Listing', 'rls-listing-public', 'public', 'APPROVED', true, 'rls_publisher_a', 'rls_web_a', now()),
  ('rls_listing_unverified', 'RLS Unverified Listing', 'rls-listing-unverified', 'unverified', 'APPROVED', false, 'rls_publisher_b', 'rls_web_b', now()),
  ('rls_listing_private', 'RLS Private Listing', 'rls-listing-private', 'private', 'DRAFT', false, 'rls_publisher_a', 'rls_private_web_a', now());

INSERT INTO public."ListingService"
  (id, "listingId", "serviceType", price, "turnaroundDays", availability, "updatedAt") VALUES
  ('rls_service_available', 'rls_listing_public', 'GUEST_POST', 10.00, 3, 'AVAILABLE', now()),
  ('rls_service_paused', 'rls_listing_public', 'NICHE_EDIT', 20.00, 5, 'PAUSED', now());

INSERT INTO public."WebsiteMetric"
  (id, "websiteId", key, provider, source, value, "measuredAt", "updatedAt") VALUES
  ('rls_metric_public', 'rls_web_a', 'AHREFS_DOMAIN_RATING', 'AHREFS', 'AHREFS_FREE_API', 72, now(), now()),
  ('rls_metric_private', 'rls_private_web_a', 'AHREFS_DOMAIN_RATING', 'AHREFS', 'AHREFS_FREE_API', 41, now(), now());

INSERT INTO public."MarketplaceReview"
  (id, "listingId", "userId", "reviewerName", rating, content, status, "updatedAt") VALUES
  ('rls_review_public', 'rls_listing_public', 'rls_customer_b', 'RLS Reviewer', 5, 'good', 'APPROVED', now());

INSERT INTO public."Order"
  (id, type, amount, "customerId", "organizationId", "websiteId", "updatedAt") VALUES
  ('rls_order_a', 'GUEST_POST', 10.00, 'rls_customer_owner', 'rls_org_a', 'rls_web_a', now()),
  ('rls_order_b', 'GUEST_POST', 20.00, 'rls_customer_b', 'rls_org_b', 'rls_web_b', now());

INSERT INTO public."ApiKey"
  (id, "organizationId", name, "keyHash", "updatedAt") VALUES
  ('rls_key_a', 'rls_org_a', 'RLS Key A', repeat('a', 64), now()),
  ('rls_key_b', 'rls_org_b', 'RLS Key B', repeat('b', 64), now());

COMMIT;

-- Customer owner: tenant rows, owner-only keys, and reviewed marketplace rows.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_owner', 'rls_org_a', 'OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Organization"), 'customer owner sees exactly its organization');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Order"), 'customer owner sees exactly its order');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."ApiKey"), 'customer owner sees exactly its API key');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."MarketplaceListing"), 'customer sees only reviewed marketplace listings');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."ListingService"), 'customer sees only available catalog services');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."WebsiteMetric"), 'customer sees only metrics for reviewed catalog websites');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."MarketplaceReview"), 'customer sees approved reviews without reviewer User access');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM guestpost_rls.find_invitable_user('rls-customer-b@example.test', 'rls_org_a')), 'organization owner can resolve an invitable customer without listing User rows');
SELECT pg_temp.assert_true(
  public."acquire_delivery_url_claim_fence"('https://rls-publication.example.test/article'),
  'live API actor can acquire the delivery URL coordination fence'
);
INSERT INTO public."MarketplaceListingView" (id, "listingId", "userId")
VALUES ('rls_customer_view', 'rls_listing_public', 'rls_customer_owner');
SELECT pg_temp.assert_rejected(
  'INSERT INTO public."MarketplaceListingView" (id, "listingId", "userId") VALUES (''rls_spoofed_view'', ''rls_listing_public'', ''rls_customer_b'')',
  'customer cannot write catalog telemetry as another user'
);
SELECT pg_temp.assert_affected_rows(
  'UPDATE public."Organization" SET name = name WHERE id = ''rls_org_b''',
  0,
  'customer cannot update another organization'
);
INSERT INTO public."AuditLog" (id, action, "entityType", "userId", "organizationId")
VALUES ('rls_audit_append_only', 'RLS_TEST', 'Organization', 'rls_customer_owner', 'rls_org_a');
SELECT pg_temp.assert_affected_rows(
  'UPDATE public."AuditLog" SET action = ''TAMPERED'' WHERE id = ''rls_audit_append_only''',
  0,
  'API audit records are append-only'
);
SELECT pg_temp.assert_rejected(
  'DELETE FROM public."Membership" WHERE id = ''rls_membership_owner''',
  'the last active organization owner cannot remove itself'
);
ROLLBACK;

-- Customer member retains tenant access but never inherits owner-only API keys.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_member', 'rls_org_a', 'MEMBER');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Organization"), 'customer member sees its organization');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Order"), 'customer member sees its organization order');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."ApiKey"), 'customer member cannot see API keys');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM guestpost_rls.find_invitable_user('rls-customer-b@example.test', 'rls_org_a')), 'organization member cannot use the invitable-user lookup');
SELECT pg_temp.assert_rejected(
  'UPDATE public."Membership" SET role = ''OWNER'' WHERE id = ''rls_membership_member''',
  'organization member cannot promote itself'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_member', 'rls_org_a', 'OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."ApiKey"), 'forged customer role GUC cannot widen API-key access');
ROLLBACK;

-- A pending invitee can accept only the unchanged invitation, even when a
-- different organization is active in the request context.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_b', 'rls_org_b', 'OWNER');
SELECT pg_temp.assert_affected_rows(
  'UPDATE public."Membership" SET status = ''ACTIVE'', "updatedAt" = now() WHERE id = ''rls_membership_pending''',
  1,
  'pending invitee can accept its unchanged invitation'
);
ROLLBACK;

-- Publisher: own private resources plus customer orders routed to its website.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'PUBLISHER', 'rls_publisher_a_user', '', '', 'rls_publisher_a', 'PUBLISHER_OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Publisher"), 'publisher sees exactly its publisher identity');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public."Website"), 'publisher sees its public and private websites');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Order"), 'publisher sees the order routed to its website');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public."MarketplaceListing"), 'publisher sees its private listing plus the public catalog');
ROLLBACK;

BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'PUBLISHER', 'rls_publisher_a_member', '', '', 'rls_publisher_a', 'PUBLISHER_OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."Publisher"), 'publisher member retains its publisher read boundary');
SELECT pg_temp.assert_affected_rows(
  'UPDATE public."PublisherMembership" SET role = ''PUBLISHER_OWNER'' WHERE id = ''rls_publisher_membership_a_member''',
  0,
  'publisher member cannot promote itself with a forged role GUC'
);
ROLLBACK;

-- Runtime connections fail closed when middleware did not establish context.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Organization"), 'API without context sees no organizations');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Order"), 'API without context sees no orders');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."MarketplaceListing"), 'API without context sees no catalog');
ROLLBACK;

-- Public context is read-only and filtered; anonymous telemetry cannot spoof a user.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('PUBLIC');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."MarketplaceListing"), 'public sees only approved, verified, active listings');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."ListingService"), 'public sees only catalog-visible services');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."WebsiteMetric"), 'public sees metrics only for reviewed catalog websites');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public."MarketplaceReview"), 'public sees approved catalog reviews');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."User"), 'public review reads do not expose reviewer User rows');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Order"), 'public cannot see orders');
SELECT pg_temp.assert_rejected(
  'INSERT INTO public."MarketplaceListingView" (id, "listingId", "userId") VALUES (''rls_public_spoofed_view'', ''rls_listing_public'', ''rls_customer_owner'')',
  'public telemetry cannot claim an authenticated user'
);
ROLLBACK;

-- Staff authority comes from live database membership, not caller-supplied role GUCs.
BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'STAFF', 'rls_staff_operations', '', '', '', '', 'SUPER_ADMIN');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public."Order"), 'operations can inspect all orders');
SELECT pg_temp.assert_true(NOT guestpost_rls.staff_command_allowed('PayoutMethod', 'SELECT'), 'forged staff role GUC cannot widen operations access');
SELECT pg_temp.assert_affected_rows(
  'UPDATE public."StaffMembership" SET role = ''SUPER_ADMIN'' WHERE id = ''rls_staff_membership_operations''',
  0,
  'operations staff cannot promote itself to super admin'
);
ROLLBACK;

BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'STAFF', 'rls_staff_finance', '', '', '', '', 'OPERATIONS');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public."Order"), 'finance can inspect all orders');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."MarketplaceListing"), 'finance cannot inspect marketplace listings');
ROLLBACK;

BEGIN;
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'STAFF', 'rls_staff_admin', '', '', '', '', 'FINANCE');
SELECT pg_temp.assert_true((SELECT count(*) = 4 FROM public."Organization"), 'super admin can inspect all organizations');
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM public."MarketplaceListing"), 'super admin can inspect all listings');
INSERT INTO public."AuditLog" (id, action, "entityType", "userId")
VALUES ('rls_staff_audit_append_only', 'RLS_STAFF_TEST', 'User', 'rls_staff_admin');
SELECT pg_temp.assert_affected_rows(
  'DELETE FROM public."AuditLog" WHERE id = ''rls_staff_audit_append_only''',
  0,
  'audit records remain append-only even for super admin'
);
ROLLBACK;

-- Better Auth has its own table-level identity and cannot reach business tables.
BEGIN;
SET LOCAL ROLE guestpost_auth_runtime;
SELECT pg_temp.assert_true((SELECT count(*) = 9 FROM public."User"), 'auth runtime can resolve account users');
SELECT pg_temp.assert_true(NOT has_table_privilege(current_user, 'public."Order"', 'SELECT'), 'auth runtime has no order privilege');
ROLLBACK;

-- Workers are platform service principals, require an explicit worker context,
-- and remain subject to FORCE RLS (they are never BYPASSRLS).
BEGIN;
SET LOCAL ROLE guestpost_worker_runtime;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Order"), 'worker without context sees no orders');
SELECT pg_temp.set_rls_context('WORKER', '', '', '', '', '', '', '', '', 'reconciliation');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM public."Order"), 'reviewed worker identity can process platform orders');
ROLLBACK;

-- Revocation is live: an already-established context loses access immediately.
BEGIN;
UPDATE public."Membership" SET status = 'PENDING' WHERE id = 'rls_membership_owner';
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_owner', 'rls_org_a', 'OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Organization"), 'inactive customer membership revokes access immediately');
ROLLBACK;

BEGIN;
DELETE FROM public."PublisherMembership" WHERE id = 'rls_publisher_membership_a';
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'PUBLISHER', 'rls_publisher_a_user', '', '', 'rls_publisher_a', 'PUBLISHER_OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Website" WHERE id = 'rls_private_web_a'), 'removed publisher membership revokes private resources immediately');
ROLLBACK;

BEGIN;
DELETE FROM public."StaffMembership" WHERE id = 'rls_staff_membership_operations';
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'STAFF', 'rls_staff_operations', '', '', '', '', 'SUPER_ADMIN');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Order"), 'removed staff membership revokes access immediately');
ROLLBACK;

BEGIN;
UPDATE public."User" SET banned = true WHERE id = 'rls_customer_owner';
SET LOCAL ROLE guestpost_api_runtime;
SELECT pg_temp.set_rls_context('API', 'CUSTOMER', 'rls_customer_owner', 'rls_org_a', 'OWNER');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."Organization"), 'suspended customer loses tenant access immediately');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM public."MarketplaceListing"), 'suspended customer loses catalog access immediately');
ROLLBACK;

\echo 'full application RLS boundary assertions passed'
