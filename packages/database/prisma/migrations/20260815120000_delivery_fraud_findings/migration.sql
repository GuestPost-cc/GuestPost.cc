-- A confirmed fraud decision is not a resolution: it must preserve the
-- immutable signal and its settlement-blocking current hold. Record the
-- decision as separate append-only evidence, fenced against stale order and
-- delivery state, and make it mutually exclusive with clearance/restoration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

-- Drain all writers whose state is authenticated by the new finding guard,
-- including resolution writers while their mutual-exclusion guard is replaced.
LOCK TABLE
  public."Order",
  public."Transaction",
  public."OrderCancellationRequest",
  public."DeliveryFraudFlag",
  public."DeliveryFraudFlagResolution",
  public."DeliveryFraudHold",
  public."OrderDeliveryVersion",
  public."StaffMembership",
  public."User"
IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE public."DeliveryFraudFindingOutcome" AS ENUM (
  'CONFIRMED_FRAUD'
);

CREATE TABLE public."DeliveryFraudFinding" (
  "id" TEXT NOT NULL,
  "fraudFlagId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "deliveryVersionId" TEXT NOT NULL,
  "cancellationRequestId" TEXT NOT NULL,
  "outcome" public."DeliveryFraudFindingOutcome" NOT NULL DEFAULT 'CONFIRMED_FRAUD',
  "internalReason" VARCHAR(1000) NOT NULL,
  "decidedByUserId" TEXT NOT NULL,
  "decidedByRole" public."StaffRole" NOT NULL,
  "expectedOrderVersion" INTEGER NOT NULL,
  "expectedVerificationVersion" INTEGER NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeliveryFraudFinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeliveryFraudFinding_internalReason_check" CHECK (
    "internalReason" = btrim("internalReason")
    AND char_length("internalReason") BETWEEN 20 AND 1000
  ),
  CONSTRAINT "DeliveryFraudFinding_expectedOrderVersion_check" CHECK (
    "expectedOrderVersion" >= 0
  ),
  CONSTRAINT "DeliveryFraudFinding_expectedVerificationVersion_check" CHECK (
    "expectedVerificationVersion" >= 0
  ),
  CONSTRAINT "DeliveryFraudFinding_requestFingerprint_check" CHECK (
    "requestFingerprint" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "DeliveryFraudFinding_fraudFlagId_key"
  ON public."DeliveryFraudFinding"("fraudFlagId");
CREATE UNIQUE INDEX "DeliveryFraudFinding_decidedByUserId_idempotencyKey_key"
  ON public."DeliveryFraudFinding"("decidedByUserId", "idempotencyKey");
CREATE INDEX "DeliveryFraudFinding_orderId_idx"
  ON public."DeliveryFraudFinding"("orderId");
CREATE INDEX "DeliveryFraudFinding_deliveryVersionId_idx"
  ON public."DeliveryFraudFinding"("deliveryVersionId");
CREATE INDEX "DeliveryFraudFinding_cancellationRequestId_idx"
  ON public."DeliveryFraudFinding"("cancellationRequestId");
CREATE INDEX "DeliveryFraudFinding_decidedByUserId_idx"
  ON public."DeliveryFraudFinding"("decidedByUserId");
CREATE INDEX "DeliveryFraudFinding_outcome_createdAt_idx"
  ON public."DeliveryFraudFinding"("outcome", "createdAt");

ALTER TABLE public."DeliveryFraudFinding"
  ADD CONSTRAINT "DeliveryFraudFinding_fraudFlagId_fkey"
  FOREIGN KEY ("fraudFlagId") REFERENCES public."DeliveryFraudFlag"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."DeliveryFraudFinding"
  ADD CONSTRAINT "DeliveryFraudFinding_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES public."Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."DeliveryFraudFinding"
  ADD CONSTRAINT "DeliveryFraudFinding_deliveryVersionId_fkey"
  FOREIGN KEY ("deliveryVersionId") REFERENCES public."OrderDeliveryVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."DeliveryFraudFinding"
  ADD CONSTRAINT "DeliveryFraudFinding_cancellationRequestId_fkey"
  FOREIGN KEY ("cancellationRequestId") REFERENCES public."OrderCancellationRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE public."DeliveryFraudFinding"
  ADD CONSTRAINT "DeliveryFraudFinding_decidedByUserId_fkey"
  FOREIGN KEY ("decidedByUserId") REFERENCES public."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DO $cancellation_refund_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."OrderCancellationRequest" AS cancellation_request
    LEFT JOIN public."Transaction" AS refund
      ON refund."id" = cancellation_request."refundTransactionId"
    WHERE cancellation_request."refundTransactionId" IS NOT NULL
      AND refund."id" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'cancellation refund evidence contains an orphan transaction reference';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public."OrderCancellationRequest"
    WHERE "refundTransactionId" IS NOT NULL
    GROUP BY "refundTransactionId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a refund transaction cannot be linked to more than one cancellation request';
  END IF;
END
$cancellation_refund_preflight$;

CREATE UNIQUE INDEX "OrderCancellationRequest_refundTransactionId_key"
  ON public."OrderCancellationRequest"("refundTransactionId");

ALTER TABLE public."OrderCancellationRequest"
  ADD CONSTRAINT "OrderCancellationRequest_refundTransactionId_fkey"
  FOREIGN KEY ("refundTransactionId") REFERENCES public."Transaction"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION public."guard_delivery_fraud_finding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
-- This guard advances Order and therefore invokes the legacy
-- assert_financial_currency_links trigger, whose historical body uses
-- unqualified public relations. Keep the only required application schema
-- explicit and after pg_catalog; the runtime role is denied CREATE on public,
-- and explicitly placing pg_temp last prevents temporary-table shadowing.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_order_version INTEGER;
  current_order_status TEXT;
  current_verification_version INTEGER;
  cancellation_request_status TEXT;
  cancellation_request_resolution TEXT;
  cancellation_request_responsibility TEXT;
  cancellation_request_reviewer TEXT;
  cancellation_request_reason TEXT;
  flag_type TEXT;
  flag_created_at TIMESTAMP(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud finding evidence is append-only';
  END IF;

  -- This is the canonical settlement-blocker fence. Under READ COMMITTED it
  -- serializes the following checks; under SERIALIZABLE a stale waiter aborts
  -- and retries from a fresh snapshot instead of authorizing stale evidence.
  UPDATE public."Order" AS order_row
  SET "settlementGateVersion" = order_row."settlementGateVersion" + 1
  WHERE order_row."id" = NEW."orderId"
  RETURNING order_row."version", order_row."status"::TEXT
    INTO current_order_version, current_order_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'fraud finding order does not exist';
  END IF;

  IF current_order_version IS DISTINCT FROM NEW."expectedOrderVersion" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud finding expected order version is stale';
  END IF;
  IF current_order_status IN ('CANCELLED', 'REFUNDED', 'COMPLETED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud cannot be created after a terminal order outcome';
  END IF;
  -- A current hold can intentionally point to historical/superseded evidence.
  -- Bind the finding to that exact delivery and its captured verification CAS;
  -- do not silently redirect adjudication to Order.activeDeliveryVersionId.
  SELECT delivery."verificationVersion"
    INTO current_verification_version
  FROM public."OrderDeliveryVersion" AS delivery
  WHERE delivery."id" = NEW."deliveryVersionId"
    AND delivery."orderId" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud finding delivery identity is stale or mismatched';
  END IF;
  IF current_verification_version IS DISTINCT FROM NEW."expectedVerificationVersion" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud finding expected verification version is stale';
  END IF;

  SELECT flag."type", flag."createdAt"
    INTO flag_type, flag_created_at
  FROM public."DeliveryFraudFlag" AS flag
  WHERE flag."id" = NEW."fraudFlagId"
    AND flag."orderId" = NEW."orderId"
    AND flag."deliveryVersionId" = NEW."deliveryVersionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud finding identity does not match its immutable flag';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."DeliveryFraudFlagResolution" AS resolution
    WHERE resolution."fraudFlagId" = NEW."fraudFlagId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a resolved fraud flag cannot receive a confirmed finding';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."DeliveryFraudHold" AS hold
    WHERE hold."fraudFlagId" = NEW."fraudFlagId"
      AND hold."orderId" = NEW."orderId"
      AND hold."deliveryVersionId" = NEW."deliveryVersionId"
      AND hold."type" = flag_type
      AND hold."createdAt" = flag_created_at
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud requires the exact current unresolved hold';
  END IF;

  -- A confirmed operational decision must enter the existing role-separated
  -- cancellation workflow. Lock the linked case while this insert commits so
  -- a concurrent direct-SQL terminal transition cannot invalidate the handoff
  -- between this check and the finding becoming visible.
  SELECT
    cancellation_request."status"::TEXT,
    cancellation_request."resolution"::TEXT,
    cancellation_request."responsibility"::TEXT,
    cancellation_request."reviewedByUserId",
    cancellation_request."resolutionReason"
    INTO
      cancellation_request_status,
      cancellation_request_resolution,
      cancellation_request_responsibility,
      cancellation_request_reviewer,
      cancellation_request_reason
  FROM public."OrderCancellationRequest" AS cancellation_request
  WHERE cancellation_request."id" = NEW."cancellationRequestId"
    AND cancellation_request."orderId" = NEW."orderId"
  FOR SHARE OF cancellation_request;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud requires a cancellation review for the same order';
  END IF;
  IF cancellation_request_status NOT IN (
    'UNDER_REVIEW',
    'PENDING_FINANCE',
    'ESCALATED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud requires a nonterminal cancellation review';
  END IF;
  IF cancellation_request_status = 'PENDING_FINANCE'
    AND (
      cancellation_request_resolution IS DISTINCT FROM 'FULL_REFUND'
      OR cancellation_request_responsibility IS NULL
      OR cancellation_request_responsibility = 'UNDETERMINED'
      OR cancellation_request_reviewer IS NULL
      OR cancellation_request_reason IS NULL
      OR cancellation_request_reason <> btrim(cancellation_request_reason)
      OR char_length(cancellation_request_reason) NOT BETWEEN 20 AND 2000
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud requires a complete pending Finance full-refund review';
  END IF;

  -- Lock the authorization records in shared mode so a concurrent ban,
  -- user-type change, or role change cannot overtake this decision check.
  PERFORM 1
  FROM public."StaffMembership" AS membership
  JOIN public."User" AS decider
    ON decider."id" = membership."userId"
  WHERE membership."userId" = NEW."decidedByUserId"
    AND membership."role" = NEW."decidedByRole"
    AND membership."role" IN ('OPERATIONS', 'SUPER_ADMIN')
    AND decider."userType" = 'STAFF'
    AND NOT decider."banned"
  FOR SHARE OF membership, decider;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud requires a live Operations or Super Admin actor';
  END IF;

  -- Deliberately do not delete DeliveryFraudHold. The finding makes that hold
  -- permanent deny evidence; canonical refund/compensation records separately
  -- describe any financial result without manufacturing one here.
  RETURN NEW;
END
$$;

CREATE TRIGGER "DeliveryFraudFinding_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON public."DeliveryFraudFinding"
  FOR EACH ROW
  EXECUTE FUNCTION public."guard_delivery_fraud_finding"();

CREATE TRIGGER "DeliveryFraudFinding_truncate_guard"
  BEFORE TRUNCATE ON public."DeliveryFraudFinding"
  FOR EACH STATEMENT
  EXECUTE FUNCTION public."guard_delivery_fraud_finding"();

-- Once a cancellation review is linked to confirmed fraud, the permanent
-- settlement hold means that review may only progress toward a Finance-backed
-- full refund. Prevent direct SQL from rejecting, withdrawing, or diverting
-- the sole remediation path to a dispute after the operational finding exists.
CREATE FUNCTION public."guard_confirmed_fraud_cancellation_handoff"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  locked_order_status TEXT;
  locked_payment_status TEXT;
  locked_refund_responsibility TEXT;
  locked_order_amount NUMERIC;
  locked_order_currency TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud cancellation evidence cannot be truncated';
  END IF;

  -- Row-level UPDATE/DELETE triggers run after PostgreSQL has selected the
  -- cancellation tuple. Independently lock the canonical parent before
  -- consulting DeliveryFraudFinding so correctness does not depend on this
  -- trigger sorting before or after the older settlement-order-lock trigger.
  -- A concurrent finding advances this same Order fence; READ COMMITTED sees
  -- the winner after waiting and stricter isolation levels abort stale work.
  SELECT
    order_row."status"::TEXT,
    order_row."paymentStatus"::TEXT,
    order_row."refundResponsibility"::TEXT,
    order_row."amount",
    order_row."currency"
  INTO
    locked_order_status,
    locked_payment_status,
    locked_refund_responsibility,
    locked_order_amount,
    locked_order_currency
  FROM public."Order" AS order_row
  WHERE order_row."id" = OLD."orderId"
  FOR UPDATE OF order_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'confirmed fraud cancellation order does not exist';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM public."DeliveryFraudFinding" AS finding
      WHERE finding."cancellationRequestId" = OLD."id"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'a cancellation review linked to confirmed fraud cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."DeliveryFraudFinding" AS finding
    WHERE finding."cancellationRequestId" = OLD."id"
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
    OR NEW."requesterType" IS DISTINCT FROM OLD."requesterType"
    OR NEW."actorSnapshot" IS DISTINCT FROM OLD."actorSnapshot"
    OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
    OR NEW."note" IS DISTINCT FROM OLD."note"
    OR NEW."previousOrderStatus" IS DISTINCT FROM OLD."previousOrderStatus"
    OR NEW."fulfillmentChannel" IS DISTINCT FROM OLD."fulfillmentChannel"
    OR NEW."requestedResolution" IS DISTINCT FROM OLD."requestedResolution"
    OR NEW."responseDeadlineAt" IS DISTINCT FROM OLD."responseDeadlineAt"
    OR NEW."respondedByUserId" IS DISTINCT FROM OLD."respondedByUserId"
    OR NEW."responseNote" IS DISTINCT FROM OLD."responseNote"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud cancellation identity is immutable';
  END IF;

  IF OLD."status" = 'UNDER_REVIEW'
    AND NEW."status" NOT IN ('UNDER_REVIEW', 'ESCALATED', 'PENDING_FINANCE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud review must progress to Finance full-refund review';
  ELSIF OLD."status" = 'ESCALATED'
    AND NEW."status" NOT IN ('ESCALATED', 'PENDING_FINANCE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud escalation must progress to Finance full-refund review';
  ELSIF OLD."status" = 'PENDING_FINANCE'
    AND NEW."status" NOT IN ('PENDING_FINANCE', 'APPROVED')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud Finance review may only complete through an approved refund';
  ELSIF OLD."status" = 'APPROVED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'approved confirmed fraud cancellation evidence is append-only';
  ELSIF OLD."status" NOT IN (
    'UNDER_REVIEW',
    'ESCALATED',
    'PENDING_FINANCE',
    'APPROVED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud cancellation review has an invalid state';
  END IF;

  IF NEW."status" = 'PENDING_FINANCE' THEN
    IF NEW."resolution" IS DISTINCT FROM 'FULL_REFUND'
      OR NEW."responsibility" = 'UNDETERMINED'
      OR NEW."reviewedByUserId" IS NULL
      OR NEW."resolutionReason" IS NULL
      OR NEW."resolutionReason" <> btrim(NEW."resolutionReason")
      OR char_length(NEW."resolutionReason") NOT BETWEEN 20 AND 2000
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud requires a complete full-refund recommendation';
    END IF;

    PERFORM 1
    FROM public."StaffMembership" AS membership
    JOIN public."User" AS reviewer
      ON reviewer."id" = membership."userId"
    WHERE membership."userId" = NEW."reviewedByUserId"
      AND membership."role" IN ('OPERATIONS', 'SUPER_ADMIN')
      AND reviewer."userType" = 'STAFF'
      AND NOT reviewer."banned"
    FOR SHARE OF membership, reviewer;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud full-refund review requires live Operations or Super Admin authority';
    END IF;
  END IF;

  IF NEW."status" = 'APPROVED' THEN
    IF NEW."resolution" IS DISTINCT FROM 'FULL_REFUND'
      OR NEW."responsibility" = 'UNDETERMINED'
      OR NEW."financeApprovedByUserId" IS NULL
      OR NEW."refundTransactionId" IS NULL
      OR NEW."resolvedAt" IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud approval requires a complete Finance refund decision';
    END IF;

    PERFORM 1
    FROM public."StaffMembership" AS membership
    JOIN public."User" AS approver
      ON approver."id" = membership."userId"
    WHERE membership."userId" = NEW."financeApprovedByUserId"
      AND membership."role" IN ('FINANCE', 'SUPER_ADMIN')
      AND approver."userType" = 'STAFF'
      AND NOT approver."banned"
    FOR SHARE OF membership, approver;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud refund approval requires live Finance or Super Admin authority';
    END IF;

    IF locked_order_status IS DISTINCT FROM 'REFUNDED'
      OR locked_payment_status IS DISTINCT FROM 'REFUNDED'
      OR locked_refund_responsibility
        IS DISTINCT FROM NEW."responsibility"::TEXT
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud approval requires the canonical completed full refund';
    END IF;

    -- Order is already locked above. Lock the exact ledger row second and
    -- retain both locks through commit. A concurrent REFUND rewrite therefore
    -- either finishes before this validation or waits, rechecks the now-
    -- approved case in its own guard, and fails append-only enforcement.
    PERFORM 1
    FROM public."Transaction" AS refund
    WHERE refund."id" = NEW."refundTransactionId"
      AND refund."orderId" = NEW."orderId"
      AND refund."type" = 'REFUND'
      AND refund."amount" = locked_order_amount
      AND refund."currency" = locked_order_currency
    FOR SHARE OF refund;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud approval requires the canonical completed full refund';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "OrderCancellationRequest_confirmed_fraud_guard"
  BEFORE UPDATE OR DELETE ON public."OrderCancellationRequest"
  FOR EACH ROW
  EXECUTE FUNCTION public."guard_confirmed_fraud_cancellation_handoff"();

CREATE TRIGGER "OrderCancellationRequest_confirmed_fraud_truncate_guard"
  BEFORE TRUNCATE ON public."OrderCancellationRequest"
  FOR EACH STATEMENT
  EXECUTE FUNCTION public."guard_confirmed_fraud_cancellation_handoff"();

-- Refund primitives update the Order before the linked cancellation request is
-- finalized in the same transaction. Validate the aggregate at commit so that
-- canonical Finance approval can commit atomically, while force-cancel,
-- dispute, worker, and direct-SQL terminal shortcuts fail closed.
CREATE FUNCTION public."assert_confirmed_fraud_terminal_outcome"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  current_status TEXT;
  current_payment_status TEXT;
  current_refund_responsibility TEXT;
  current_amount NUMERIC;
  current_currency TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."DeliveryFraudFinding" AS finding
    WHERE finding."orderId" = NEW."id"
  ) THEN
    RETURN NEW;
  END IF;

  -- A constraint trigger may have been queued by an earlier UPDATE in the
  -- transaction. Always validate the final aggregate, never that historical
  -- NEW row image, so a later same-transaction rewrite cannot reopen or alter
  -- an already approved confirmed-fraud refund.
  SELECT
    order_row."status"::TEXT,
    order_row."paymentStatus"::TEXT,
    order_row."refundResponsibility"::TEXT,
    order_row."amount",
    order_row."currency"
  INTO
    current_status,
    current_payment_status,
    current_refund_responsibility,
    current_amount,
    current_currency
  FROM public."Order" AS order_row
  WHERE order_row."id" = NEW."id";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'confirmed fraud order evidence is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."DeliveryFraudFinding" AS finding
    JOIN public."OrderCancellationRequest" AS cancellation_request
      ON cancellation_request."id" = finding."cancellationRequestId"
    WHERE finding."orderId" = NEW."id"
      AND cancellation_request."status" = 'APPROVED'
  ) THEN
    IF current_status IS DISTINCT FROM 'REFUNDED'
      OR current_payment_status IS DISTINCT FROM 'REFUNDED'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'an approved confirmed fraud case requires the order to remain fully refunded';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public."DeliveryFraudFinding" AS finding
      JOIN public."OrderCancellationRequest" AS cancellation_request
        ON cancellation_request."id" = finding."cancellationRequestId"
      LEFT JOIN public."Transaction" AS refund
        ON refund."id" = cancellation_request."refundTransactionId"
      WHERE finding."orderId" = NEW."id"
        AND (
          cancellation_request."orderId" IS DISTINCT FROM NEW."id"
          OR cancellation_request."status" IS DISTINCT FROM 'APPROVED'
          OR cancellation_request."resolution" IS DISTINCT FROM 'FULL_REFUND'
          OR cancellation_request."responsibility" = 'UNDETERMINED'
          OR cancellation_request."financeApprovedByUserId" IS NULL
          OR cancellation_request."refundTransactionId" IS NULL
          OR cancellation_request."resolvedAt" IS NULL
          OR refund."id" IS NULL
          OR refund."orderId" IS DISTINCT FROM NEW."id"
          OR refund."type" IS DISTINCT FROM 'REFUND'
          OR refund."amount" IS DISTINCT FROM current_amount
          OR refund."currency" IS DISTINCT FROM current_currency
          OR cancellation_request."responsibility"::TEXT
            IS DISTINCT FROM current_refund_responsibility
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud refund requires its exact linked approved Finance evidence';
    END IF;
  ELSIF current_status IN ('CANCELLED', 'REFUNDED', 'COMPLETED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'an order with confirmed fraud may terminate only through its approved full-refund case';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "Order_confirmed_fraud_terminal_outcome_guard"
  AFTER INSERT OR UPDATE ON public."Order"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public."assert_confirmed_fraud_terminal_outcome"();

-- The cancellation FK prevents deletion or identifier changes, while this
-- trigger makes every financial fact on the referenced ledger row immutable.
-- Corrections must be compensating transactions, never in-place rewrites of
-- the evidence that authorized a confirmed-fraud cancellation outcome.
CREATE FUNCTION public."guard_confirmed_fraud_refund_transaction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (
      SELECT 1
      FROM public."OrderCancellationRequest" AS cancellation_request
      JOIN public."DeliveryFraudFinding" AS finding
        ON finding."cancellationRequestId" = cancellation_request."id"
      WHERE cancellation_request."status" = 'APPROVED'
        AND cancellation_request."refundTransactionId" IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'confirmed fraud refund evidence cannot be truncated';
    END IF;
    RETURN NULL;
  END IF;

  -- UPDATE/DELETE owns the ledger tuple before this row trigger runs. Take
  -- every affected REFUND parent Order in deterministic order before checking
  -- the linked case. This closes approval-vs-rewrite races without relying on
  -- a statement snapshot or trigger name order: canonical approval holds
  -- Order then REFUND, while an inverse raw writer deadlocks and one side is
  -- safely aborted rather than committing contradictory financial evidence.
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'REFUND' AND OLD."orderId" IS NOT NULL THEN
      PERFORM 1
      FROM public."Order" AS order_row
      WHERE order_row."id" = OLD."orderId"
      FOR UPDATE OF order_row;
    END IF;
  ELSIF OLD."type" = 'REFUND' OR NEW."type" = 'REFUND' THEN
    PERFORM 1
    FROM public."Order" AS order_row
    WHERE order_row."id" IN (OLD."orderId", NEW."orderId")
    ORDER BY order_row."id"
    FOR UPDATE OF order_row;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."OrderCancellationRequest" AS cancellation_request
    JOIN public."DeliveryFraudFinding" AS finding
      ON finding."cancellationRequestId" = cancellation_request."id"
    WHERE cancellation_request."status" = 'APPROVED'
      AND cancellation_request."refundTransactionId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'confirmed fraud refund ledger evidence is append-only';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "Transaction_confirmed_fraud_refund_guard"
  BEFORE UPDATE OR DELETE ON public."Transaction"
  FOR EACH ROW
  EXECUTE FUNCTION public."guard_confirmed_fraud_refund_transaction"();

CREATE TRIGGER "Transaction_confirmed_fraud_refund_truncate_guard"
  BEFORE TRUNCATE ON public."Transaction"
  FOR EACH STATEMENT
  EXECUTE FUNCTION public."guard_confirmed_fraud_refund_transaction"();

-- Resolution and confirmed-fraud insertion both advance the same Order row
-- before checking the opposite table. This makes the two terminal decisions
-- mutually exclusive under direct SQL as well as application transactions.
CREATE OR REPLACE FUNCTION public."guard_delivery_fraud_resolution"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
-- See guard_delivery_fraud_finding: this UPDATE fires the same legacy Order
-- currency trigger and therefore requires an explicit, trusted public lookup;
-- pg_temp remains explicit and last to prevent temporary-table shadowing.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  flag_type TEXT;
  flag_created_at TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivery fraud resolution evidence is append-only';
  END IF;

  UPDATE public."Order" AS order_row
  SET "settlementGateVersion" = order_row."settlementGateVersion" + 1
  WHERE order_row."id" = NEW."orderId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'fraud resolution order does not exist';
  END IF;

  SELECT flag."type", flag."createdAt"
    INTO flag_type, flag_created_at
  FROM public."DeliveryFraudFlag" AS flag
  WHERE flag."id" = NEW."fraudFlagId"
    AND flag."orderId" = NEW."orderId"
    AND flag."deliveryVersionId" = NEW."deliveryVersionId";

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud resolution identity does not match its immutable flag';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public."DeliveryFraudFinding" AS finding
    WHERE finding."fraudFlagId" = NEW."fraudFlagId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a confirmed fraud flag cannot be cleared or restored';
  END IF;

  IF NEW."kind" = 'LINK_RESTORED' THEN
    IF flag_type <> 'LINK_REMOVED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'only a link-removed flag can be resolved by automated restoration';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public."Order" AS order_row
      JOIN public."OrderDeliveryVersion" AS delivery
        ON delivery."id" = NEW."deliveryVersionId"
      JOIN public."DeliveryVerificationEvidence" AS verification
        ON verification."id" = NEW."evidenceId"
       AND verification."deliveryVersionId" = delivery."id"
      WHERE order_row."id" = NEW."orderId"
        AND order_row."activeDeliveryVersionId" = delivery."id"
        AND delivery."orderId" = order_row."id"
        AND delivery."supersededByVersion" IS NULL
        AND delivery."verificationStatus" = 'VERIFIED'
        AND verification."checkedAt" > flag_created_at
        AND verification."httpStatus" IN (200, 301, 302)
        AND verification."linkFound"
        AND verification."targetUrlMatched"
        AND verification."anchorFound"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'link-restored resolution requires the active delivery to be freshly verified';
    END IF;
  ELSE
    -- Match the finding guard's authorization linearization. Holding shared
    -- row locks through trigger completion makes a concurrent ban, user-type
    -- change, or role revoke wait; a stale SERIALIZABLE waiter must restart.
    PERFORM 1
    FROM public."StaffMembership" AS membership
    JOIN public."User" AS resolver
      ON resolver."id" = membership."userId"
    WHERE membership."userId" = NEW."resolvedByUserId"
      AND membership."role" = NEW."resolvedByRole"
      AND membership."role" IN ('SUPER_ADMIN', 'OPERATIONS', 'FINANCE')
      AND resolver."userType" = 'STAFF'
      AND NOT resolver."banned"
    FOR SHARE OF membership, resolver;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'staff-cleared fraud resolution requires an active allowed staff role';
    END IF;
  END IF;

  DELETE FROM public."DeliveryFraudHold"
  WHERE "fraudFlagId" = NEW."fraudFlagId";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'fraud resolution requires a current unresolved hold';
  END IF;

  RETURN NEW;
END
$$;

-- PostgreSQL grants new functions to PUBLIC by default. Trigger invocation is
-- unaffected; direct execution is not part of the application contract.
REVOKE ALL ON TABLE public."DeliveryFraudFinding" FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."guard_delivery_fraud_finding"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."guard_delivery_fraud_resolution"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."guard_confirmed_fraud_cancellation_handoff"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."assert_confirmed_fraud_terminal_outcome"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public."guard_confirmed_fraud_refund_transaction"() FROM PUBLIC;

COMMIT;
