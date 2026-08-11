-- Rehearsal-only provisioning of the exact delivery URL fence privileges.
-- The caller supplies a fixed local NOLOGIN role through psql's identifier
-- variable; production operators must use their reviewed runtime role name.

\set ON_ERROR_STOP on

BEGIN;

REVOKE ALL ON TABLE public."DeliveryUrlClaimFence"
  FROM :"runtime_role";
REVOKE EXECUTE ON FUNCTION public."acquire_delivery_url_claim_fence"(text)
  FROM :"runtime_role";
REVOKE EXECUTE ON FUNCTION public."fence_delivery_url_claim_mutation"()
  FROM :"runtime_role";

GRANT SELECT ON TABLE public."DeliveryUrlClaimFence"
  TO :"runtime_role";
GRANT INSERT ("normalizedUrl", "version")
  ON TABLE public."DeliveryUrlClaimFence" TO :"runtime_role";
GRANT UPDATE ("version") ON TABLE public."DeliveryUrlClaimFence"
  TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public."acquire_delivery_url_claim_fence"(text)
  TO :"runtime_role";

COMMIT;
