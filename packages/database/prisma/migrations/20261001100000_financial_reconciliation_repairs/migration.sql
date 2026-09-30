BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = public, pg_catalog, pg_temp;

ALTER TABLE public."Transaction"
  ADD COLUMN "reversalOfTransactionId" TEXT;

ALTER TABLE public."Transaction"
  ADD CONSTRAINT "Transaction_reversalOfTransactionId_fkey"
  FOREIGN KEY ("reversalOfTransactionId")
  REFERENCES public."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Transaction_reversalOfTransactionId_key"
  ON public."Transaction"("reversalOfTransactionId");

CREATE TABLE public."ReconciliationRepairProposal" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sourceRefundTransactionId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "evidenceFingerprint" CHAR(64) NOT NULL,
  "evidenceDigest" CHAR(64) NOT NULL,
  "proposalDigest" CHAR(64) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "incidentReference" VARCHAR(191) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "expectedCaseVersion" INTEGER NOT NULL,
  "expectedOrderVersion" INTEGER NOT NULL,
  "expectedWalletVersion" INTEGER NOT NULL,
  "initiatedByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRepairProposal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationRepairProposal_amount_check" CHECK (
    "amount" > 0 AND "amount" * 100 = TRUNC("amount" * 100)
  ),
  CONSTRAINT "ReconciliationRepairProposal_currency_check" CHECK ("currency" = 'USD'),
  CONSTRAINT "ReconciliationRepairProposal_digest_check" CHECK (
    "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
    AND "evidenceDigest" ~ '^[0-9a-f]{64}$'
    AND "proposalDigest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ReconciliationRepairProposal_reason_check" CHECK (
    LENGTH(BTRIM("reason")) BETWEEN 20 AND 1000
    AND "reason" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "ReconciliationRepairProposal_incident_check" CHECK (
    LENGTH(BTRIM("incidentReference")) BETWEEN 3 AND 191
    AND "incidentReference" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  CONSTRAINT "ReconciliationRepairProposal_expiry_check" CHECK (
    "expiresAt" > "createdAt"
    AND "expiresAt" <= "createdAt" + INTERVAL '1 hour'
  ),
  CONSTRAINT "ReconciliationRepairProposal_case_fkey"
    FOREIGN KEY ("caseId") REFERENCES public."ReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairProposal_order_fkey"
    FOREIGN KEY ("orderId") REFERENCES public."Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairProposal_source_fkey"
    FOREIGN KEY ("sourceRefundTransactionId") REFERENCES public."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairProposal_wallet_fkey"
    FOREIGN KEY ("walletId") REFERENCES public."Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairProposal_initiator_fkey"
    FOREIGN KEY ("initiatedByUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReconciliationRepairProposal_proposalDigest_key"
  ON public."ReconciliationRepairProposal"("proposalDigest");
CREATE INDEX "ReconciliationRepairProposal_caseId_createdAt_idx"
  ON public."ReconciliationRepairProposal"("caseId", "createdAt");
CREATE INDEX "ReconciliationRepairProposal_source_expires_idx"
  ON public."ReconciliationRepairProposal"("sourceRefundTransactionId", "expiresAt");

CREATE TABLE public."ReconciliationRepairApproval" (
  "id" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "proposalDigest" CHAR(64) NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRepairApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationRepairApproval_proposalDigest_check"
    CHECK ("proposalDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ReconciliationRepairApproval_proposal_fkey"
    FOREIGN KEY ("proposalId") REFERENCES public."ReconciliationRepairProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairApproval_approver_fkey"
    FOREIGN KEY ("approvedByUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReconciliationRepairApproval_proposalId_key"
  ON public."ReconciliationRepairApproval"("proposalId");

CREATE TABLE public."ReconciliationRepairExecution" (
  "id" TEXT NOT NULL,
  "proposalId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sourceRefundTransactionId" TEXT NOT NULL,
  "reversalTransactionId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "beforeAvailableBalance" DECIMAL(18,2) NOT NULL,
  "afterAvailableBalance" DECIMAL(18,2) NOT NULL,
  "beforeWalletVersion" INTEGER NOT NULL,
  "afterWalletVersion" INTEGER NOT NULL,
  "executedByUserId" TEXT NOT NULL,
  "approverUserId" TEXT NOT NULL,
  "idempotencyKey" VARCHAR(191) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationRepairExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationRepairExecution_amount_check" CHECK (
    "amount" > 0 AND "amount" * 100 = TRUNC("amount" * 100)
    AND "beforeAvailableBalance" >= "amount"
    AND "afterAvailableBalance" = "beforeAvailableBalance" - "amount"
    AND "beforeWalletVersion" >= 0
    AND "afterWalletVersion" = "beforeWalletVersion" + 1
  ),
  CONSTRAINT "ReconciliationRepairExecution_identity_check" CHECK (
    "currency" = 'USD'
    AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,191}$'
    AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ReconciliationRepairExecution_proposal_fkey"
    FOREIGN KEY ("proposalId") REFERENCES public."ReconciliationRepairProposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_case_fkey"
    FOREIGN KEY ("caseId") REFERENCES public."ReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_order_fkey"
    FOREIGN KEY ("orderId") REFERENCES public."Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_source_fkey"
    FOREIGN KEY ("sourceRefundTransactionId") REFERENCES public."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_reversal_fkey"
    FOREIGN KEY ("reversalTransactionId") REFERENCES public."Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_wallet_fkey"
    FOREIGN KEY ("walletId") REFERENCES public."Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_executor_fkey"
    FOREIGN KEY ("executedByUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationRepairExecution_approver_fkey"
    FOREIGN KEY ("approverUserId") REFERENCES public."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReconciliationRepairExecution_proposalId_key"
  ON public."ReconciliationRepairExecution"("proposalId");
CREATE UNIQUE INDEX "ReconciliationRepairExecution_sourceRefundTransactionId_key"
  ON public."ReconciliationRepairExecution"("sourceRefundTransactionId");
CREATE UNIQUE INDEX "ReconciliationRepairExecution_reversalTransactionId_key"
  ON public."ReconciliationRepairExecution"("reversalTransactionId");
CREATE UNIQUE INDEX "ReconciliationRepairExecution_caseId_idempotencyKey_key"
  ON public."ReconciliationRepairExecution"("caseId", "idempotencyKey");
CREATE INDEX "ReconciliationRepairExecution_caseId_createdAt_idx"
  ON public."ReconciliationRepairExecution"("caseId", "createdAt");
CREATE INDEX "ReconciliationRepairExecution_orderId_createdAt_idx"
  ON public."ReconciliationRepairExecution"("orderId", "createdAt");

CREATE OR REPLACE FUNCTION public.reject_reconciliation_repair_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'financial reconciliation repair evidence is append-only';
END
$function$;

CREATE TRIGGER "ReconciliationRepairProposal_no_update_delete"
BEFORE UPDATE OR DELETE ON public."ReconciliationRepairProposal"
FOR EACH ROW EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();
CREATE TRIGGER "ReconciliationRepairProposal_no_truncate"
BEFORE TRUNCATE ON public."ReconciliationRepairProposal"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();
CREATE TRIGGER "ReconciliationRepairApproval_no_update_delete"
BEFORE UPDATE OR DELETE ON public."ReconciliationRepairApproval"
FOR EACH ROW EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();
CREATE TRIGGER "ReconciliationRepairApproval_no_truncate"
BEFORE TRUNCATE ON public."ReconciliationRepairApproval"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();
CREATE TRIGGER "ReconciliationRepairExecution_no_update_delete"
BEFORE UPDATE OR DELETE ON public."ReconciliationRepairExecution"
FOR EACH ROW EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();
CREATE TRIGGER "ReconciliationRepairExecution_no_truncate"
BEFORE TRUNCATE ON public."ReconciliationRepairExecution"
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();

CREATE FUNCTION public.guard_reconciliation_repair_source_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD."type" = 'REFUND' AND (
    EXISTS (
      SELECT 1 FROM public."ReconciliationRepairProposal" proposal
      WHERE proposal."sourceRefundTransactionId" = OLD."id"
    ) OR EXISTS (
      SELECT 1 FROM public."Transaction" reversal
      WHERE reversal."reversalOfTransactionId" = OLD."id"
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'refund evidence bound to a reconciliation repair is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "Transaction_repair_source_refund_immutable"
BEFORE UPDATE OR DELETE ON public."Transaction"
FOR EACH ROW EXECUTE FUNCTION public.guard_reconciliation_repair_source_refund();

CREATE FUNCTION public.guard_reconciliation_repair_proposal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_tx public."Transaction"%ROWTYPE;
  target_order public."Order"%ROWTYPE;
  target_wallet public."Wallet"%ROWTYPE;
  repair_case public."ReconciliationCase"%ROWTYPE;
  compensation public."PublisherCompensation"%ROWTYPE;
  compensation_tx public."Transaction"%ROWTYPE;
  purchase_count INTEGER;
  refund_count INTEGER;
BEGIN
  IF NOT guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
     OR NEW."initiatedByUserId" <> guestpost_rls.actor_id() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'repair proposal actor is not an authorized Finance staff member';
  END IF;

  SELECT * INTO repair_case FROM public."ReconciliationCase"
    WHERE "id" = NEW."caseId" FOR SHARE;
  SELECT * INTO target_order FROM public."Order"
    WHERE "id" = NEW."orderId" FOR SHARE;
  SELECT * INTO source_tx FROM public."Transaction"
    WHERE "id" = NEW."sourceRefundTransactionId" FOR SHARE;
  SELECT * INTO target_wallet FROM public."Wallet"
    WHERE "id" = NEW."walletId" FOR SHARE;
  SELECT * INTO compensation FROM public."PublisherCompensation"
    WHERE "orderId" = NEW."orderId" FOR SHARE;
  SELECT * INTO compensation_tx FROM public."Transaction"
    WHERE "id" = compensation."compensationTransactionId" FOR SHARE;
  SELECT COUNT(*) INTO purchase_count FROM public."Transaction"
    WHERE "orderId" = NEW."orderId" AND "type" = 'PURCHASE';
  SELECT COUNT(*) INTO refund_count FROM public."Transaction"
    WHERE "orderId" = NEW."orderId" AND "type" = 'REFUND';

  IF repair_case."id" IS NULL OR repair_case."orderId" <> NEW."orderId"
     OR repair_case."currentFingerprint" <> NEW."evidenceFingerprint"
     OR repair_case."version" <> NEW."expectedCaseVersion"
     OR target_order."id" IS NULL OR target_order."version" <> NEW."expectedOrderVersion"
     OR target_order."status" <> 'REFUNDED' OR target_order."paymentStatus" <> 'REFUNDED'
     OR target_order."amount" IS NULL OR target_order."currency" <> 'USD'
     OR target_order."refundResponsibility" IS DISTINCT FROM compensation."responsibility"
     OR compensation."responsibility" IN ('UNDETERMINED', 'PUBLISHER')
     OR compensation."effectiveOrderStatus" NOT IN ('PUBLISHED', 'VERIFIED', 'DELIVERED', 'COMPLETED')
     OR (target_order."fulfillmentChannel" IS DISTINCT FROM 'PUBLISHER' AND NOT EXISTS (
       SELECT 1 FROM public."Website" publisher_website
       WHERE publisher_website."id" = target_order."websiteId"
         AND publisher_website."ownershipType" = 'PUBLISHER'
     ))
     OR source_tx."id" IS NULL OR source_tx."type" <> 'REFUND'
     OR source_tx."orderId" IS DISTINCT FROM NEW."orderId" OR source_tx."walletId" IS DISTINCT FROM NEW."walletId"
     OR source_tx."amount" <> NEW."amount" OR source_tx."amount" <> target_order."amount"
     OR source_tx."currency" <> 'USD' OR source_tx."provider" IS NOT NULL
     OR source_tx."providerRef" IS NOT NULL
     OR source_tx."reference" IS NULL
     OR source_tx."reference" NOT LIKE ('force-cancel:' || NEW."orderId" || ':%')
     OR target_wallet."id" IS NULL OR target_wallet."version" <> NEW."expectedWalletVersion"
     OR target_wallet."organizationId" IS DISTINCT FROM target_order."organizationId"
     OR target_wallet."currency" <> 'USD'
     OR target_wallet."availableBalance" < NEW."amount"
     OR compensation."refundTransactionId" <> source_tx."id"
     OR compensation."disposition" <> 'EXACT_AMOUNT'
     OR compensation."amount" <> target_order."amount"
     OR compensation."currency" <> 'USD'
     OR compensation."reason" IS NULL OR LENGTH(BTRIM(compensation."reason")) < 20
     OR compensation."debtRepaymentTransactionId" IS NOT NULL
     OR compensation_tx."id" IS NULL
     OR compensation_tx."type" <> 'PUBLISHER_COMPENSATION'
     OR compensation_tx."orderId" <> NEW."orderId"
     OR compensation_tx."publisherId" <> compensation."publisherId"
     OR compensation_tx."amount" <> compensation."amount"
     OR compensation_tx."currency" <> 'USD'
     OR compensation."publisherId" IS DISTINCT FROM COALESCE(
       (SELECT settlement."publisherId" FROM public."Settlement" settlement
         WHERE settlement."orderId" = NEW."orderId"
         ORDER BY settlement."createdAt" DESC, settlement."id" DESC LIMIT 1),
       (SELECT website."publisherId" FROM public."Website" website WHERE website."id" = target_order."websiteId")
     )
     OR compensation."amount" IS DISTINCT FROM COALESCE(
       (SELECT settlement."publisherAmount" FROM public."Settlement" settlement
         WHERE settlement."orderId" = NEW."orderId"
         ORDER BY settlement."createdAt" DESC, settlement."id" DESC LIMIT 1),
       target_order."amount"
     )
     OR purchase_count <> 1 OR refund_count <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public."Transaction" purchase
       WHERE purchase."orderId" = NEW."orderId"
         AND purchase."type" = 'PURCHASE'
         AND purchase."walletId" = NEW."walletId"
         AND purchase."currency" = 'USD'
         AND purchase."amount" = -target_order."amount"
         AND purchase."provider" IS NULL AND purchase."providerRef" IS NULL
     )
     OR NOT EXISTS (
       SELECT 1 FROM public."OrderEvent" event
       WHERE event."orderId" = NEW."orderId"
         AND event."eventType" = 'REFUND_ISSUED'
         AND event."metadata"->>'refundTransactionId' = source_tx."id"
         AND event."metadata"->>'responsibility' = target_order."refundResponsibility"::text
     )
     OR NOT EXISTS (
       SELECT 1 FROM public."ReconciliationCaseSnapshot" snapshot
       WHERE snapshot."caseId" = NEW."caseId"
         AND snapshot."evidenceFingerprint" = NEW."evidenceFingerprint"
         AND cardinality(snapshot."findingCodes") = 2
         AND snapshot."findingCodes" @> ARRAY['REFUND_PARTIAL', 'REFUND_PUBLISHER_COMPENSATION_INVALID']::TEXT[]
     )
     OR EXISTS (
       SELECT 1 FROM public."Transaction" later
       WHERE later."walletId" = NEW."walletId"
         AND later."createdAt" >= source_tx."createdAt"
         AND later."id" <> source_tx."id"
         AND ((later."type" IN ('PURCHASE', 'WITHDRAWAL', 'CHARGEBACK', 'REFUND_REVERSAL') AND later."amount" < 0)
           OR later."type" = 'RESERVATION')
     )
     OR EXISTS (
       SELECT 1 FROM public."PaymentDispute" dispute
       WHERE dispute."walletId" = NEW."walletId"
         AND (dispute."status" = 'OPEN' OR dispute."currentExposureAmount" > 0)
     )
     OR EXISTS (
       SELECT 1 FROM public."OrderDispute" dispute
       WHERE dispute."orderId" = NEW."orderId" AND dispute."status" = 'OPEN'
     )
     OR EXISTS (
       SELECT 1 FROM public."DeliveryFraudFinding" finding
       WHERE finding."orderId" = NEW."orderId"
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'repair proposal evidence does not match the single supported internal refund-credit recipe';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "ReconciliationRepairProposal_guard"
BEFORE INSERT ON public."ReconciliationRepairProposal"
FOR EACH ROW EXECUTE FUNCTION public.guard_reconciliation_repair_proposal();

CREATE FUNCTION public.guard_reconciliation_repair_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  proposal public."ReconciliationRepairProposal"%ROWTYPE;
BEGIN
  SELECT * INTO proposal FROM public."ReconciliationRepairProposal"
    WHERE "id" = NEW."proposalId" FOR SHARE;
  IF NOT guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
     OR NEW."approvedByUserId" <> guestpost_rls.actor_id()
     OR proposal."id" IS NULL
     OR proposal."proposalDigest" <> NEW."proposalDigest"
     OR proposal."initiatedByUserId" = NEW."approvedByUserId"
     OR proposal."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'repair approval is stale, self-approved, or not bound to an authorized proposal';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "ReconciliationRepairApproval_guard"
BEFORE INSERT ON public."ReconciliationRepairApproval"
FOR EACH ROW EXECUTE FUNCTION public.guard_reconciliation_repair_approval();

CREATE FUNCTION public.guard_refund_credit_reversal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  source_tx public."Transaction"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."type" = 'REFUND_REVERSAL' OR NEW."type" = 'REFUND_REVERSAL') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'refund reversal ledger evidence is immutable';
  END IF;
  IF NEW."type" <> 'REFUND_REVERSAL' THEN
    IF NEW."reversalOfTransactionId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only refund reversal entries may link a reversed transaction';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO source_tx FROM public."Transaction"
    WHERE "id" = NEW."reversalOfTransactionId" FOR SHARE;
  IF NEW."reversalOfTransactionId" IS NULL
     OR NEW."amount" >= 0
     OR source_tx."id" IS NULL
     OR source_tx."type" <> 'REFUND'
     OR source_tx."amount" <= 0
     OR NEW."amount" <> -source_tx."amount"
     OR NEW."orderId" IS DISTINCT FROM source_tx."orderId"
     OR NEW."walletId" IS DISTINCT FROM source_tx."walletId"
     OR NEW."currency" <> source_tx."currency"
     OR NEW."provider" IS NOT NULL OR NEW."providerRef" IS NOT NULL
     OR NEW."publisherId" IS NOT NULL OR NEW."settlementId" IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM public."ReconciliationRepairProposal" proposal
       JOIN public."ReconciliationRepairApproval" approval
         ON approval."proposalId" = proposal."id"
       JOIN public."ReconciliationCase" repair_case ON repair_case."id" = proposal."caseId"
       JOIN public."Order" target_order ON target_order."id" = proposal."orderId"
       JOIN public."Wallet" target_wallet ON target_wallet."id" = proposal."walletId"
       WHERE proposal."sourceRefundTransactionId" = source_tx."id"
         AND proposal."expiresAt" > CURRENT_TIMESTAMP
         AND proposal."proposalDigest" = approval."proposalDigest"
         AND repair_case."currentFingerprint" = proposal."evidenceFingerprint"
         AND target_order."version" = proposal."expectedOrderVersion"
         AND target_wallet."version" = proposal."expectedWalletVersion" + 1
         AND target_wallet."availableBalance" >= 0
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'refund reversal must exactly offset one approved same-order, same-wallet, same-currency refund';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "Transaction_refund_credit_reversal_guard"
BEFORE INSERT OR UPDATE ON public."Transaction"
FOR EACH ROW EXECUTE FUNCTION public.guard_refund_credit_reversal();
CREATE TRIGGER "Transaction_refund_credit_reversal_no_delete"
BEFORE DELETE ON public."Transaction"
FOR EACH ROW WHEN (OLD."type" = 'REFUND_REVERSAL')
EXECUTE FUNCTION public.reject_reconciliation_repair_mutation();

CREATE FUNCTION public.guard_reconciliation_repair_execution()
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
BEGIN
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
     OR NEW."approverUserId" = proposal."initiatedByUserId"
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
CREATE TRIGGER "ReconciliationRepairExecution_guard"
BEFORE INSERT ON public."ReconciliationRepairExecution"
FOR EACH ROW EXECUTE FUNCTION public.guard_reconciliation_repair_execution();

CREATE FUNCTION public.assert_reconciliation_repair_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  execution public."ReconciliationRepairExecution"%ROWTYPE;
  reversal public."Transaction"%ROWTYPE;
  source_tx public."Transaction"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'Transaction' THEN
    IF NEW."type" <> 'REFUND_REVERSAL' THEN RETURN NULL; END IF;
    SELECT * INTO execution FROM public."ReconciliationRepairExecution"
      WHERE "reversalTransactionId" = NEW."id";
    SELECT * INTO source_tx FROM public."Transaction"
      WHERE "id" = NEW."reversalOfTransactionId";
    IF execution."id" IS NULL OR source_tx."id" IS NULL
       OR execution."sourceRefundTransactionId" <> source_tx."id"
       OR execution."reversalTransactionId" <> NEW."id"
       OR execution."amount" <> -NEW."amount"
       OR execution."orderId" <> NEW."orderId"
       OR execution."walletId" <> NEW."walletId"
       OR execution."currency" <> NEW."currency" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'refund reversal ledger entry requires one exact immutable repair execution';
    END IF;
  ELSE
    SELECT * INTO reversal FROM public."Transaction"
      WHERE "id" = NEW."reversalTransactionId";
    SELECT * INTO source_tx FROM public."Transaction"
      WHERE "id" = NEW."sourceRefundTransactionId";
    IF reversal."id" IS NULL OR source_tx."id" IS NULL
       OR reversal."type" <> 'REFUND_REVERSAL'
       OR reversal."reversalOfTransactionId" <> source_tx."id"
       OR reversal."amount" <> -source_tx."amount"
       OR NEW."amount" <> source_tx."amount"
       OR NEW."orderId" <> source_tx."orderId"
       OR NEW."walletId" <> source_tx."walletId"
       OR NEW."currency" <> source_tx."currency"
       OR NEW."beforeWalletVersion" + 1 <> NEW."afterWalletVersion" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'repair execution requires one exact linked source refund and reversal';
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "Transaction_refund_reversal_execution_pair"
AFTER INSERT ON public."Transaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_reconciliation_repair_pair();
CREATE CONSTRAINT TRIGGER "RepairExecution_refund_reversal_pair"
AFTER INSERT ON public."ReconciliationRepairExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.assert_reconciliation_repair_pair();

-- Finance may transition a case only when matching immutable evidence exists.
CREATE OR REPLACE FUNCTION public.guard_reconciliation_case()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."aggregateType" <> 'Order'
     OR NEW."orderId" IS NULL
     OR NEW."aggregateId" <> NEW."orderId"
     OR NEW."currentFingerprint" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reconciliation cases must be order-bound, canonical detector evidence';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."aggregateType" <> OLD."aggregateType"
       OR NEW."aggregateId" <> OLD."aggregateId"
       OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."detectedAt" <> OLD."detectedAt"
       OR NEW."lastDetectedAt" < OLD."lastDetectedAt"
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'reconciliation case identity and detection history are immutable';
    END IF;
    IF guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE']) AND (
      NEW."aggregateType" IS DISTINCT FROM OLD."aggregateType"
      OR NEW."aggregateId" IS DISTINCT FROM OLD."aggregateId"
      OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
      OR NEW."currentFingerprint" IS DISTINCT FROM OLD."currentFingerprint"
      OR NEW."detectedAt" IS DISTINCT FROM OLD."detectedAt"
      OR NEW."lastDetectedAt" IS DISTINCT FROM OLD."lastDetectedAt"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'Finance may only perform evidence-backed reconciliation case status transitions';
    END IF;
    IF OLD."status" IN ('APPLIED', 'VERIFIED') AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'terminal reconciliation case status is immutable';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
      IF NOT guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
         OR (NEW."status" = 'AWAITING_APPROVAL' AND NOT EXISTS (
           SELECT 1 FROM public."ReconciliationRepairProposal" proposal
           WHERE proposal."caseId" = NEW."id"
             AND proposal."evidenceFingerprint" = NEW."currentFingerprint"
             AND proposal."expiresAt" > CURRENT_TIMESTAMP
         ))
         OR (NEW."status" = 'APPLIED' AND NOT EXISTS (
           SELECT 1 FROM public."ReconciliationRepairExecution" execution
           WHERE execution."caseId" = NEW."id"
         ))
         OR NEW."status" NOT IN ('AWAITING_APPROVAL', 'APPLIED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'reconciliation case status requires an authorized matching repair record';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

-- Extend the Phase 1 status policy only for the Finance/Super Admin workflow.
DROP POLICY IF EXISTS "ReconciliationCase_full_boundary_update"
  ON public."ReconciliationCase";
CREATE POLICY "ReconciliationCase_full_boundary_update"
ON public."ReconciliationCase" FOR UPDATE
USING (
  (guestpost_rls.role_member(current_user, 'guestpost_worker_group')
   AND current_setting('guestpost.rls_workload', true) = 'WORKER'
   AND NULLIF(current_setting('guestpost.rls_worker', true), '') IS NOT NULL)
  OR guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
)
WITH CHECK (
  (guestpost_rls.role_member(current_user, 'guestpost_worker_group')
   AND current_setting('guestpost.rls_workload', true) = 'WORKER'
   AND NULLIF(current_setting('guestpost.rls_worker', true), '') IS NOT NULL)
  OR guestpost_rls.staff_role_in(ARRAY['SUPER_ADMIN', 'FINANCE'])
);

DO $repair_rls$
DECLARE
  model_name TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'ReconciliationCase'
      AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) THEN
    ALTER TABLE public."ReconciliationRepairProposal" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."ReconciliationRepairProposal" FORCE ROW LEVEL SECURITY;
    ALTER TABLE public."ReconciliationRepairApproval" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."ReconciliationRepairApproval" FORCE ROW LEVEL SECURITY;
    ALTER TABLE public."ReconciliationRepairExecution" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public."ReconciliationRepairExecution" FORCE ROW LEVEL SECURITY;
  END IF;

  FOREACH model_name IN ARRAY ARRAY[
    'ReconciliationRepairProposal', 'ReconciliationRepairApproval',
    'ReconciliationRepairExecution'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (' ||
      'current_user = ''guestpost_rls_authorizer'' OR ' ||
      'guestpost_rls.staff_role_in(ARRAY[''SUPER_ADMIN'', ''FINANCE'']))',
      model_name || '_finance_select', model_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (' ||
      'guestpost_rls.staff_role_in(ARRAY[''SUPER_ADMIN'', ''FINANCE'']))',
      model_name || '_finance_insert', model_name
    );
  END LOOP;
END
$repair_rls$;

DO $repair_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_api_group') THEN
    GRANT SELECT, INSERT ON public."ReconciliationRepairProposal",
      public."ReconciliationRepairApproval", public."ReconciliationRepairExecution"
      TO guestpost_api_group;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_rls_authorizer') THEN
    GRANT SELECT ON public."ReconciliationRepairProposal",
      public."ReconciliationRepairApproval", public."ReconciliationRepairExecution"
      TO guestpost_rls_authorizer;
  END IF;
END
$repair_grants$;

COMMIT;
