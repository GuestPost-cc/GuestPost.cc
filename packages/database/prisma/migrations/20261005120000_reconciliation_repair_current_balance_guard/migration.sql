-- Match the database proposal guard to the repair affordability contract:
-- wallet funds are fungible, so current unreserved available balance is the
-- authority. Historical debits after the refund are not by themselves a debt
-- or a reason to deny recovery when the exact reversal is currently funded.
-- The API locks the order and wallet and this trigger rechecks available funds
-- in the same transaction, so concurrent spending cannot create an overdraft.
BEGIN;

DO $repair_guard_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'ReconciliationCase'
      AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'guestpost_financial_repair_guard'
      AND rolcanlogin = false AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'forced-RLS repair requires the provisioned non-login repair guard role';
  END IF;
END
$repair_guard_preflight$;

CREATE OR REPLACE FUNCTION public.guard_reconciliation_repair_proposal()
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

  IF NOT NEW."providerRefundConfirmedAbsent"
     OR repair_case."id" IS NULL OR repair_case."orderId" <> NEW."orderId"
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

-- Keep the same least-privilege owner contract as the original trigger:
-- SECURITY DEFINER is used only when forced RLS requires the dedicated guard.
DO $repair_guard_owner$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'ReconciliationCase'
      AND relation.relrowsecurity AND relation.relforcerowsecurity
  ) THEN
    GRANT CREATE ON SCHEMA public TO guestpost_financial_repair_guard;
    ALTER FUNCTION public.guard_reconciliation_repair_proposal() SECURITY DEFINER;
    ALTER FUNCTION public.guard_reconciliation_repair_proposal()
      OWNER TO guestpost_financial_repair_guard;
    REVOKE CREATE ON SCHEMA public FROM guestpost_financial_repair_guard;
  ELSE
    ALTER FUNCTION public.guard_reconciliation_repair_proposal() SECURITY INVOKER;
  END IF;
END
$repair_guard_owner$;

COMMIT;
