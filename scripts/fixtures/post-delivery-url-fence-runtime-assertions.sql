-- Exercise the URL fence through the exact restricted runtime role. This is a
-- rollback-only canary: it proves the intended call surface and proves that
-- primary-key rewrites, destructive table access, and direct trigger-function
-- execution remain unavailable.

\set ON_ERROR_STOP on

SET ROLE :"runtime_role";

DO $$
DECLARE
  can_use_schema boolean;
  can_create_in_schema boolean;
  can_insert_url boolean;
  can_insert_version boolean;
  can_update_version boolean;
  can_rewrite_url boolean;
  can_delete boolean;
  can_truncate boolean;
  can_trigger boolean;
  can_acquire_fence boolean;
  can_call_trigger_function boolean;
BEGIN
  SELECT
    has_schema_privilege(current_user, 'public', 'USAGE'),
    has_schema_privilege(current_user, 'public', 'CREATE'),
    has_column_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'normalizedUrl', 'INSERT'),
    has_column_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'version', 'INSERT'),
    has_column_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'version', 'UPDATE'),
    has_column_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'normalizedUrl', 'UPDATE'),
    has_table_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'DELETE'),
    has_table_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'TRUNCATE'),
    has_table_privilege(current_user,
      'public."DeliveryUrlClaimFence"', 'TRIGGER'),
    has_function_privilege(current_user,
      'public.acquire_delivery_url_claim_fence(text)', 'EXECUTE'),
    has_function_privilege(current_user,
      'public.fence_delivery_url_claim_mutation()', 'EXECUTE')
  INTO
    can_use_schema,
    can_create_in_schema,
    can_insert_url,
    can_insert_version,
    can_update_version,
    can_rewrite_url,
    can_delete,
    can_truncate,
    can_trigger,
    can_acquire_fence,
    can_call_trigger_function;

  IF NOT can_use_schema
     OR can_create_in_schema
     OR NOT can_insert_url
     OR NOT can_insert_version
     OR NOT can_update_version
     OR can_rewrite_url
     OR can_delete
     OR can_truncate
     OR can_trigger
     OR NOT can_acquire_fence
     OR can_call_trigger_function THEN
    RAISE EXCEPTION 'delivery URL runtime authority is broader or narrower than intended';
  END IF;
END
$$;

BEGIN;

CREATE TEMP TABLE "DeliveryUrlClaimFence" (
  "normalizedUrl" TEXT PRIMARY KEY,
  "version" BIGINT NOT NULL DEFAULT 0
);

SELECT public."acquire_delivery_url_claim_fence"(
  'https://migration-rehearsal.invalid/runtime-role-rollback'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp."DeliveryUrlClaimFence"
    WHERE "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rollback'
  ) THEN
    RAISE EXCEPTION 'restricted runtime URL fence was redirected to pg_temp';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."DeliveryUrlClaimFence"
    WHERE "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rollback'
  ) THEN
    RAISE EXCEPTION 'restricted runtime URL fence did not write the public row';
  END IF;

  UPDATE public."DeliveryUrlClaimFence"
  SET "version" = "version" + 1
  WHERE "normalizedUrl" =
    'https://migration-rehearsal.invalid/runtime-role-rollback';

  BEGIN
    UPDATE public."DeliveryUrlClaimFence"
    SET "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rewrite-denied'
    WHERE "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rollback';
    RAISE EXCEPTION 'restricted runtime role rewrote a URL fence identity';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public."DeliveryUrlClaimFence"
    WHERE "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rollback';
    RAISE EXCEPTION 'restricted runtime role deleted a URL fence';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public."fence_delivery_url_claim_mutation"();
    RAISE EXCEPTION 'restricted runtime role directly called the trigger function';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

ROLLBACK;

RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."DeliveryUrlClaimFence"
    WHERE "normalizedUrl" =
      'https://migration-rehearsal.invalid/runtime-role-rollback'
  ) THEN
    RAISE EXCEPTION 'restricted runtime URL fence rollback left a canary row';
  END IF;
END
$$;
