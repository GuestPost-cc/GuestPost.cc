-- Staging-only single-actor testing is an explicit database capability.
-- The capability role is created by the role provisioner but is not granted
-- to any runtime by migrations. On production, these guards remain two-person.

CREATE OR REPLACE FUNCTION public.guard_reconciliation_repair_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  proposal public."ReconciliationRepairProposal"%ROWTYPE;
  staging_single_actor_enabled boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles capability_role
    WHERE capability_role.rolname = 'guestpost_financial_repair_staging'
      AND pg_catalog.pg_has_role(session_user, capability_role.oid, 'MEMBER')
  ) INTO staging_single_actor_enabled;

  SELECT * INTO proposal FROM public."ReconciliationRepairProposal"
    WHERE "id" = NEW."proposalId" FOR SHARE;
  IF NOT guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
     OR NEW."approvedByUserId" <> guestpost_rls.actor_id()
     OR proposal."id" IS NULL
     OR proposal."proposalDigest" <> NEW."proposalDigest"
     OR (proposal."initiatedByUserId" = NEW."approvedByUserId" AND NOT staging_single_actor_enabled)
     OR proposal."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'repair approval is stale, self-approved, or not bound to an authorized proposal';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_reconciliation_repair_execution()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  proposal public."ReconciliationRepairProposal"%ROWTYPE;
  approval public."ReconciliationRepairApproval"%ROWTYPE;
  target_wallet public."Wallet"%ROWTYPE;
  target_order public."Order"%ROWTYPE;
  repair_case public."ReconciliationCase"%ROWTYPE;
  source_tx public."Transaction"%ROWTYPE;
  reversal_tx public."Transaction"%ROWTYPE;
  staging_single_actor_enabled boolean := false;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles capability_role
    WHERE capability_role.rolname = 'guestpost_financial_repair_staging'
      AND pg_catalog.pg_has_role(session_user, capability_role.oid, 'MEMBER')
  ) INTO staging_single_actor_enabled;

  SELECT * INTO proposal FROM public."ReconciliationRepairProposal"
    WHERE "id" = NEW."proposalId" FOR SHARE;
  SELECT * INTO approval FROM public."ReconciliationRepairApproval"
    WHERE "proposalId" = NEW."proposalId" FOR SHARE;
  SELECT * INTO target_wallet FROM public."Wallet"
    WHERE "id" = NEW."walletId" FOR SHARE;
  SELECT * INTO target_order FROM public."Order"
    WHERE "id" = NEW."orderId" FOR SHARE;
  SELECT * INTO repair_case FROM public."ReconciliationCase"
    WHERE "id" = NEW."caseId" FOR SHARE;
  SELECT * INTO source_tx FROM public."Transaction"
    WHERE "id" = NEW."sourceRefundTransactionId" FOR SHARE;
  SELECT * INTO reversal_tx FROM public."Transaction"
    WHERE "id" = NEW."reversalTransactionId" FOR SHARE;
  IF NOT guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
     OR NEW."executedByUserId" <> guestpost_rls.actor_id()
     OR proposal."id" IS NULL OR approval."id" IS NULL
     OR approval."proposalDigest" <> proposal."proposalDigest"
     OR NEW."approverUserId" <> approval."approvedByUserId"
     OR (NEW."approverUserId" = proposal."initiatedByUserId" AND NOT staging_single_actor_enabled)
     OR NEW."caseId" <> proposal."caseId"
     OR NEW."orderId" <> proposal."orderId"
     OR NEW."sourceRefundTransactionId" <> proposal."sourceRefundTransactionId"
     OR NEW."walletId" <> proposal."walletId"
     OR NEW."amount" <> proposal."amount"
     OR NEW."currency" <> proposal."currency"
     OR proposal."expiresAt" <= CURRENT_TIMESTAMP
     OR target_order."version" <> proposal."expectedOrderVersion"
     OR repair_case."currentFingerprint" <> proposal."evidenceFingerprint"
     OR repair_case."status" <> 'AWAITING_APPROVAL'
     OR source_tx."type" <> 'REFUND'
     OR source_tx."amount" <> proposal."amount"
     OR source_tx."orderId" <> proposal."orderId"
     OR source_tx."walletId" <> proposal."walletId"
     OR reversal_tx."type" <> 'REFUND_REVERSAL'
     OR reversal_tx."reversalOfTransactionId" <> proposal."sourceRefundTransactionId"
     OR NEW."beforeAvailableBalance" < NEW."amount"
     OR NEW."beforeWalletVersion" <> proposal."expectedWalletVersion"
     OR target_wallet."availableBalance" <> NEW."afterAvailableBalance"
     OR target_wallet."version" <> NEW."afterWalletVersion"
     OR NEW."afterWalletVersion" <> NEW."beforeWalletVersion" + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'repair execution does not match the approved proposal and committed wallet debit';
  END IF;
  RETURN NEW;
END
$function$;
