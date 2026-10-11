BEGIN;

-- Deferred carry-forward guards inspect aggregate state across PublisherBalance,
-- Withdrawal, and WithdrawalAllocation. Keep that narrow integrity check in a
-- SECURITY DEFINER context; the RLS provisioner assigns these functions to the
-- NOLOGIN, read-only guestpost_rls_authorizer role.
ALTER FUNCTION public."assert_publisher_carry_forward_integrity"(text)
  SECURITY DEFINER;
ALTER FUNCTION public."assert_publisher_carry_forward_integrity"(text)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public."require_publisher_carry_forward_integrity"()
  SECURITY DEFINER;
ALTER FUNCTION public."require_publisher_carry_forward_integrity"()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public."assert_publisher_carry_forward_integrity"(text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public."require_publisher_carry_forward_integrity"()
  FROM PUBLIC;

COMMIT;
