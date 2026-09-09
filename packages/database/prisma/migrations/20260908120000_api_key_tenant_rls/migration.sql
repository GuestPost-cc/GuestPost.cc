-- Phase 1 of the tenant RLS rollout.
--
-- ApiKey is deliberately the first protected table because all interactive
-- access enters through the organization-owner API and no worker consumes it.
-- The API pins the server-derived context inside an interactive transaction
-- before touching this relation. Missing context denies every row.
--
-- The context is derived from CurrentAuthority in the API, but each owner
-- policy also checks the durable source of authority. That closes the window
-- where a membership is demoted or deactivated after request authentication.
-- Membership and User are intentionally not RLS-protected in this phase; when
-- they are protected, their policy design must preserve this authorization
-- lookup without adding a recursive or fail-open path.
--
-- Do not widen these predicates with a runtime-role or PUBLIC bypass. Runtime
-- roles need normal table DML grants, but RLS remains the row-level authority.

ALTER TABLE public."ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ApiKey" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ApiKey_select_active_organization_owner"
  ON public."ApiKey"
  FOR SELECT
  USING (
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND current_setting('guestpost.rls_organization_role', true) = 'OWNER'
    AND NULLIF(current_setting('guestpost.rls_actor_id', true), '') IS NOT NULL
    AND current_setting('guestpost.rls_organization_id', true) = "organizationId"
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      INNER JOIN public."User" AS actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = public."ApiKey"."organizationId"
        AND membership."userId" = current_setting('guestpost.rls_actor_id', true)
        AND membership."role" = 'OWNER'
        AND membership."status" = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
    )
  );

-- API-key authentication is intentionally narrower than an actor context: a
-- presented opaque key can reveal only the matching row. It cannot select a
-- tenant's other keys or acquire a user/staff/worker policy path.
CREATE POLICY "ApiKey_select_presented_opaque_key"
  ON public."ApiKey"
  FOR SELECT
  USING (
    current_setting('guestpost.rls_workload', true) = 'API_KEY_AUTH'
    AND NULLIF(current_setting('guestpost.rls_api_key_hash', true), '') = "keyHash"
  );

CREATE POLICY "ApiKey_insert_active_organization_owner"
  ON public."ApiKey"
  FOR INSERT
  WITH CHECK (
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND current_setting('guestpost.rls_organization_role', true) = 'OWNER'
    AND NULLIF(current_setting('guestpost.rls_actor_id', true), '') IS NOT NULL
    AND current_setting('guestpost.rls_organization_id', true) = "organizationId"
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      INNER JOIN public."User" AS actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = public."ApiKey"."organizationId"
        AND membership."userId" = current_setting('guestpost.rls_actor_id', true)
        AND membership."role" = 'OWNER'
        AND membership."status" = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
    )
  );

CREATE POLICY "ApiKey_update_active_organization_owner"
  ON public."ApiKey"
  FOR UPDATE
  USING (
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND current_setting('guestpost.rls_organization_role', true) = 'OWNER'
    AND NULLIF(current_setting('guestpost.rls_actor_id', true), '') IS NOT NULL
    AND current_setting('guestpost.rls_organization_id', true) = "organizationId"
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      INNER JOIN public."User" AS actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = public."ApiKey"."organizationId"
        AND membership."userId" = current_setting('guestpost.rls_actor_id', true)
        AND membership."role" = 'OWNER'
        AND membership."status" = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
    )
  )
  WITH CHECK (
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND current_setting('guestpost.rls_organization_role', true) = 'OWNER'
    AND NULLIF(current_setting('guestpost.rls_actor_id', true), '') IS NOT NULL
    AND current_setting('guestpost.rls_organization_id', true) = "organizationId"
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      INNER JOIN public."User" AS actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = public."ApiKey"."organizationId"
        AND membership."userId" = current_setting('guestpost.rls_actor_id', true)
        AND membership."role" = 'OWNER'
        AND membership."status" = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
    )
  );

CREATE POLICY "ApiKey_update_presented_opaque_key"
  ON public."ApiKey"
  FOR UPDATE
  USING (
    current_setting('guestpost.rls_workload', true) = 'API_KEY_AUTH'
    AND NULLIF(current_setting('guestpost.rls_api_key_hash', true), '') = "keyHash"
  )
  WITH CHECK (
    current_setting('guestpost.rls_workload', true) = 'API_KEY_AUTH'
    AND NULLIF(current_setting('guestpost.rls_api_key_hash', true), '') = "keyHash"
  );

CREATE POLICY "ApiKey_delete_active_organization_owner"
  ON public."ApiKey"
  FOR DELETE
  USING (
    current_setting('guestpost.rls_workload', true) = 'API'
    AND current_setting('guestpost.rls_actor_kind', true) = 'CUSTOMER'
    AND current_setting('guestpost.rls_organization_role', true) = 'OWNER'
    AND NULLIF(current_setting('guestpost.rls_actor_id', true), '') IS NOT NULL
    AND current_setting('guestpost.rls_organization_id', true) = "organizationId"
    AND EXISTS (
      SELECT 1
      FROM public."Membership" AS membership
      INNER JOIN public."User" AS actor ON actor."id" = membership."userId"
      WHERE membership."organizationId" = public."ApiKey"."organizationId"
        AND membership."userId" = current_setting('guestpost.rls_actor_id', true)
        AND membership."role" = 'OWNER'
        AND membership."status" = 'ACTIVE'
        AND actor."userType" = 'CUSTOMER'
    )
  );
