-- Durable provider-neutral customer-funding dispute cases.
--
-- The originating DEPOSIT transaction remains the sole owner of the unique
-- (provider, providerRef) external-payment identity. Dispute holds and
-- resolutions use server-owned Transaction.reference values and link through
-- this case instead of reusing the deposit's providerRef.

BEGIN;

-- Fail fast behind an unexpected old writer instead of hanging a finance
-- deploy indefinitely. The whole migration rolls back on either timeout.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- A verified dispute webhook must remain replayable without retaining the raw
-- provider body. Nullable columns preserve compatibility for the other payment
-- event types already stored in this shared inbox.
ALTER TABLE "PaymentProviderEvent"
  ADD COLUMN "paymentDisputeId" TEXT,
  ADD COLUMN "providerPaymentId" VARCHAR(191),
  ADD COLUMN "providerChargeId" VARCHAR(191),
  ADD COLUMN "disputeAmountMinor" BIGINT,
  ADD COLUMN "disputeCurrency" VARCHAR(3),
  ADD COLUMN "providerStatus" VARCHAR(64),
  ADD COLUMN "livemode" BOOLEAN,
  ADD COLUMN "eventFingerprint" VARCHAR(64);

ALTER TABLE "PaymentProviderEvent"
  ADD CONSTRAINT "PaymentProviderEvent_dispute_facts_check" CHECK (
    "eventType" NOT IN ('charge.dispute.created', 'charge.dispute.closed')
    OR status = 'QUARANTINED'
    OR (
      "objectId" IS NOT NULL
      AND "providerPaymentId" IS NOT NULL
      AND "disputeAmountMinor" > 0
      -- Customer funding disputes are certified for USD only. Supporting a
      -- second currency requires an explicit provider/minor-unit rollout.
      AND "disputeCurrency" = 'USD'
      AND "providerStatus" IS NOT NULL
      AND "livemode" IS NOT NULL
      AND "eventFingerprint" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

-- Events written before this migration did not retain a normalized dispute
-- envelope or test/live mode. The missing signed facts cannot be reconstructed
-- honestly from identifiers, so classify those rows as terminal quarantine
-- evidence before validating the constraint. A fresh signed provider
-- redelivery is required for recovery.
UPDATE "PaymentProviderEvent"
   SET status = 'QUARANTINED',
       "processedAt" = COALESCE("processedAt", CURRENT_TIMESTAMP),
       "lockedAt" = NULL,
       "lastError" = 'LEGACY_DISPUTE_FACTS_UNVERIFIED'
 WHERE "eventType" IN ('charge.dispute.created', 'charge.dispute.closed');

ALTER TABLE "PaymentProviderEvent"
  VALIDATE CONSTRAINT "PaymentProviderEvent_dispute_facts_check";

CREATE TYPE "PaymentDisputeStatus" AS ENUM ('OPEN', 'WON', 'LOST');

CREATE TABLE "PaymentDispute" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "providerDisputeId" VARCHAR(191) NOT NULL,
  "providerPaymentId" VARCHAR(191) NOT NULL,
  "providerChargeId" VARCHAR(191),
  "depositAttemptId" TEXT NOT NULL,
  "depositTransactionId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "heldAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "shortfallAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currentExposureAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "status" "PaymentDisputeStatus" NOT NULL,
  "providerStatus" VARCHAR(64) NOT NULL,
  "openedByEventId" TEXT,
  "resolvedByEventId" TEXT,
  "holdTransactionId" TEXT,
  "resolutionTransactionId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentDispute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentDispute_amounts_check" CHECK (
    "amount" > 0
    AND "heldAmount" >= 0
    AND "shortfallAmount" >= 0
    AND "currentExposureAmount" >= 0
    AND "heldAmount" + "shortfallAmount" = "amount"
    AND (
      (
        "status" IN ('OPEN', 'LOST')
        AND "currentExposureAmount" = "shortfallAmount"
      )
      OR
      (
        "status" = 'WON'
        AND "currentExposureAmount" = 0
      )
    )
  ),
  CONSTRAINT "PaymentDispute_usd_minor_units_check" CHECK (
    "currency" = 'USD'
    AND "amount" * 100 = trunc("amount" * 100)
    AND "heldAmount" * 100 = trunc("heldAmount" * 100)
    AND "shortfallAmount" * 100 = trunc("shortfallAmount" * 100)
    AND "currentExposureAmount" * 100 =
      trunc("currentExposureAmount" * 100)
  ),
  -- The opening event may legitimately arrive after a terminal close event,
  -- but its provider inbox evidence and timestamp must always be paired.
  CONSTRAINT "PaymentDispute_open_evidence_check" CHECK (
    ("openedByEventId" IS NULL) = ("openedAt" IS NULL)
  ),
  CONSTRAINT "PaymentDispute_resolution_evidence_check" CHECK (
    ("resolvedByEventId" IS NULL) = ("resolvedAt" IS NULL)
  ),
  CONSTRAINT "PaymentDispute_state_evidence_check" CHECK (
    (
      "status" = 'OPEN'
      AND "openedAt" IS NOT NULL
      AND "resolvedAt" IS NULL
      AND "resolutionTransactionId" IS NULL
      AND (
        ("heldAmount" > 0 AND "holdTransactionId" IS NOT NULL)
        OR
        ("heldAmount" = 0 AND "holdTransactionId" IS NULL)
      )
    )
    OR
    (
      "status" = 'WON'
      AND "resolvedAt" IS NOT NULL
      AND (
        ("heldAmount" > 0 AND "holdTransactionId" IS NOT NULL)
        OR
        ("heldAmount" = 0 AND "holdTransactionId" IS NULL)
      )
      AND (
        ("heldAmount" > 0 AND "resolutionTransactionId" IS NOT NULL)
        OR
        ("heldAmount" = 0 AND "resolutionTransactionId" IS NULL)
      )
    )
    OR
    (
      "status" = 'LOST'
      AND "resolvedAt" IS NOT NULL
      -- A positive LOST case with no holdTransactionId is the close-before-
      -- open path: funds were recovered directly instead of first being held.
      AND NOT ("heldAmount" = 0 AND "holdTransactionId" IS NOT NULL)
      AND (
        ("heldAmount" > 0 AND "resolutionTransactionId" IS NOT NULL)
        OR
        ("heldAmount" = 0 AND "resolutionTransactionId" IS NULL)
      )
    )
  ),
  CONSTRAINT "PaymentDispute_version_check" CHECK ("version" >= 0)
);

CREATE UNIQUE INDEX "PaymentDispute_provider_providerDisputeId_key"
  ON "PaymentDispute"("provider", "providerDisputeId");
CREATE UNIQUE INDEX "PaymentDispute_openedByEventId_key"
  ON "PaymentDispute"("openedByEventId");
CREATE UNIQUE INDEX "PaymentDispute_resolvedByEventId_key"
  ON "PaymentDispute"("resolvedByEventId");
CREATE UNIQUE INDEX "PaymentDispute_holdTransactionId_key"
  ON "PaymentDispute"("holdTransactionId");
CREATE UNIQUE INDEX "PaymentDispute_resolutionTransactionId_key"
  ON "PaymentDispute"("resolutionTransactionId");
CREATE INDEX "PaymentDispute_depositAttemptId_status_idx"
  ON "PaymentDispute"("depositAttemptId", "status");
CREATE INDEX "PaymentDispute_depositTransactionId_idx"
  ON "PaymentDispute"("depositTransactionId");
CREATE INDEX "PaymentDispute_walletId_status_idx"
  ON "PaymentDispute"("walletId", "status");
CREATE INDEX "PaymentDispute_provider_providerPaymentId_idx"
  ON "PaymentDispute"("provider", "providerPaymentId");
CREATE INDEX "PaymentDispute_status_createdAt_idx"
  ON "PaymentDispute"("status", "createdAt");
CREATE INDEX "PaymentProviderEvent_paymentDisputeId_eventType_idx"
  ON "PaymentProviderEvent"("paymentDisputeId", "eventType");

ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_depositAttemptId_fkey"
  FOREIGN KEY ("depositAttemptId") REFERENCES "DepositAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_depositTransactionId_fkey"
  FOREIGN KEY ("depositTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_openedByEventId_fkey"
  FOREIGN KEY ("openedByEventId") REFERENCES "PaymentProviderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_resolvedByEventId_fkey"
  FOREIGN KEY ("resolvedByEventId") REFERENCES "PaymentProviderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_holdTransactionId_fkey"
  FOREIGN KEY ("holdTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentDispute"
  ADD CONSTRAINT "PaymentDispute_resolutionTransactionId_fkey"
  FOREIGN KEY ("resolutionTransactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentProviderEvent"
  ADD CONSTRAINT "PaymentProviderEvent_paymentDisputeId_fkey"
  FOREIGN KEY ("paymentDisputeId") REFERENCES "PaymentDispute"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the credited-deposit definition centralized inside the database just
-- as `isWalletCreditBackedDepositStatus` does in shared application code.
-- Refund and dispute statuses are derivative views of an already-committed
-- wallet credit and remain valid evidence for exact replay/correlation.
CREATE FUNCTION "is_wallet_credit_backed_deposit_status"(
  input_status "DepositAttemptStatus"
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT input_status IN (
    'SUCCEEDED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'DISPUTED',
    'CHARGEBACK'
  );
$$;

-- Cross-table financial evidence cannot be expressed as a CHECK constraint.
-- Serialize each case against its originating DEPOSIT row, enforce the
-- cumulative disputed amount, and validate every linked inbox/ledger row.
CREATE FUNCTION "validate_payment_dispute_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  deposit_row "Transaction"%ROWTYPE;
  attempt_row "DepositAttempt"%ROWTYPE;
  event_row "PaymentProviderEvent"%ROWTYPE;
  ledger_row "Transaction"%ROWTYPE;
  cumulative_amount NUMERIC(65,30);
  reference_prefix TEXT;
BEGIN
  SELECT *
    INTO deposit_row
    FROM "Transaction"
   WHERE id = NEW."depositTransactionId"
   FOR UPDATE;
  IF NOT FOUND
    OR deposit_row.type <> 'DEPOSIT'
    OR deposit_row."walletId" IS DISTINCT FROM NEW."walletId"
    OR deposit_row.currency IS DISTINCT FROM NEW.currency
    OR deposit_row.provider IS DISTINCT FROM NEW.provider
    OR deposit_row."providerRef" IS DISTINCT FROM NEW."providerPaymentId"
  THEN
    RAISE EXCEPTION 'PaymentDispute has invalid originating deposit evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_evidence_guard';
  END IF;

  SELECT *
    INTO attempt_row
    FROM "DepositAttempt"
   WHERE id = NEW."depositAttemptId"
   FOR UPDATE;
  IF NOT FOUND
    OR attempt_row."ledgerTransactionId" IS DISTINCT FROM NEW."depositTransactionId"
    OR attempt_row."walletId" IS DISTINCT FROM NEW."walletId"
    OR attempt_row.currency IS DISTINCT FROM NEW.currency
    OR attempt_row.provider IS DISTINCT FROM NEW.provider
    OR attempt_row."providerPaymentId" IS DISTINCT FROM NEW."providerPaymentId"
    OR attempt_row."walletCredit" IS DISTINCT FROM deposit_row.amount
    OR NOT "is_wallet_credit_backed_deposit_status"(attempt_row.status)
  THEN
    RAISE EXCEPTION 'PaymentDispute has invalid deposit-attempt evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_evidence_guard';
  END IF;

  SELECT COALESCE(SUM(d.amount), 0)
    INTO cumulative_amount
    FROM "PaymentDispute" d
   WHERE d."depositTransactionId" = NEW."depositTransactionId"
     AND d.id <> NEW.id;
  IF cumulative_amount + NEW.amount > deposit_row.amount THEN
    RAISE EXCEPTION 'Cumulative PaymentDispute amount exceeds the originating deposit'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_cumulative_amount_guard';
  END IF;

  IF NEW."openedByEventId" IS NOT NULL THEN
    SELECT *
      INTO event_row
      FROM "PaymentProviderEvent"
     WHERE id = NEW."openedByEventId";
    IF NOT FOUND
      OR event_row.provider IS DISTINCT FROM NEW.provider
      OR event_row."eventType" <> 'charge.dispute.created'
      OR event_row."objectId" IS DISTINCT FROM NEW."providerDisputeId"
      OR event_row."providerPaymentId" IS DISTINCT FROM NEW."providerPaymentId"
      OR event_row."providerChargeId" IS DISTINCT FROM NEW."providerChargeId"
      OR event_row."disputeCurrency" IS DISTINCT FROM NEW.currency
      OR (
        NEW.currency = 'USD'
        AND event_row."disputeAmountMinor" IS DISTINCT FROM (NEW.amount * 100)::BIGINT
      )
      OR event_row.status NOT IN ('PROCESSING', 'PROCESSED')
      OR (
        event_row."paymentDisputeId" IS NOT NULL
        AND event_row."paymentDisputeId" IS DISTINCT FROM NEW.id
      )
      OR (
        NEW.status = 'OPEN'
        AND event_row."providerStatus" IS DISTINCT FROM NEW."providerStatus"
      )
    THEN
      RAISE EXCEPTION 'PaymentDispute has invalid opening-event evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_evidence_guard';
    END IF;
  END IF;

  IF NEW."resolvedByEventId" IS NOT NULL THEN
    SELECT *
      INTO event_row
      FROM "PaymentProviderEvent"
     WHERE id = NEW."resolvedByEventId";
    IF NOT FOUND
      OR event_row.provider IS DISTINCT FROM NEW.provider
      OR event_row."eventType" <> 'charge.dispute.closed'
      OR event_row."objectId" IS DISTINCT FROM NEW."providerDisputeId"
      OR event_row."providerPaymentId" IS DISTINCT FROM NEW."providerPaymentId"
      OR event_row."providerChargeId" IS DISTINCT FROM NEW."providerChargeId"
      OR event_row."disputeCurrency" IS DISTINCT FROM NEW.currency
      OR event_row."providerStatus" IS DISTINCT FROM NEW."providerStatus"
      OR (
        NEW.currency = 'USD'
        AND event_row."disputeAmountMinor" IS DISTINCT FROM (NEW.amount * 100)::BIGINT
      )
      OR event_row.status NOT IN ('PROCESSING', 'PROCESSED')
      OR (
        event_row."paymentDisputeId" IS NOT NULL
        AND event_row."paymentDisputeId" IS DISTINCT FROM NEW.id
      )
    THEN
      RAISE EXCEPTION 'PaymentDispute has invalid resolution-event evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_evidence_guard';
    END IF;
  END IF;

  IF NEW."openedByEventId" IS NOT NULL
     AND NEW."openedByEventId" IS NOT DISTINCT FROM NEW."resolvedByEventId"
  THEN
    RAISE EXCEPTION 'Opening and resolution evidence must be distinct provider events'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_evidence_guard';
  END IF;

  reference_prefix :=
    'payment-dispute:' || NEW.provider || ':' || NEW."providerDisputeId";

  IF NEW."holdTransactionId" IS NOT NULL THEN
    SELECT *
      INTO ledger_row
      FROM "Transaction"
     WHERE id = NEW."holdTransactionId";
    IF NOT FOUND
      OR ledger_row."walletId" IS DISTINCT FROM NEW."walletId"
      OR ledger_row.currency IS DISTINCT FROM NEW.currency
      OR ledger_row.type <> 'RESERVATION'
      OR ledger_row.amount IS DISTINCT FROM -NEW."heldAmount"
      OR ledger_row.reference IS DISTINCT FROM reference_prefix || ':hold'
      OR ledger_row.provider IS NOT NULL
      OR ledger_row."providerRef" IS NOT NULL
    THEN
      RAISE EXCEPTION 'PaymentDispute has invalid hold-ledger evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_evidence_guard';
    END IF;
  END IF;

  IF NEW."resolutionTransactionId" IS NOT NULL THEN
    SELECT *
      INTO ledger_row
      FROM "Transaction"
     WHERE id = NEW."resolutionTransactionId";
    IF NOT FOUND
      OR ledger_row."walletId" IS DISTINCT FROM NEW."walletId"
      OR ledger_row.currency IS DISTINCT FROM NEW.currency
      OR ledger_row.provider IS NOT NULL
      OR ledger_row."providerRef" IS NOT NULL
      OR (
        NEW.status = 'WON'
        AND (
          ledger_row.type <> 'RESERVATION'
          OR ledger_row.amount IS DISTINCT FROM NEW."heldAmount"
          OR ledger_row.reference IS DISTINCT FROM reference_prefix || ':won'
        )
      )
      OR (
        NEW.status = 'LOST'
        AND (
          ledger_row.type <> 'CHARGEBACK'
          OR ledger_row.amount IS DISTINCT FROM -NEW."heldAmount"
          OR ledger_row.reference IS DISTINCT FROM reference_prefix || ':lost'
        )
      )
    THEN
      RAISE EXCEPTION 'PaymentDispute has invalid resolution-ledger evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_evidence_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentDispute_evidence_guard"
BEFORE INSERT OR UPDATE ON "PaymentDispute"
FOR EACH ROW
EXECUTE FUNCTION "validate_payment_dispute_evidence"();

-- Dispute ledger rows are append-only. Corrections use a reviewed compensating
-- transaction; no application or ad-hoc query may rewrite the evidence.
CREATE FUNCTION "guard_payment_dispute_ledger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  protected BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(
      NEW.reference LIKE 'chargeback-hold-%'
      OR NEW.reference LIKE 'chargeback-release-%'
      OR NEW.reference LIKE 'chargeback-lost-%',
      FALSE
    ) THEN
      RAISE EXCEPTION 'Legacy chargeback ledger writers are disabled; use a durable PaymentDispute case'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_ledger_guard';
    END IF;
    IF NEW.reference LIKE 'payment-dispute:%' AND (
      NEW.reference !~ '^payment-dispute:[^:]+:[^:]+:(hold|won|lost)$'
      OR NEW.provider IS NOT NULL
      OR NEW."providerRef" IS NOT NULL
      OR NEW.type NOT IN ('RESERVATION', 'CHARGEBACK')
      OR NEW.amount = 0
    ) THEN
      RAISE EXCEPTION 'Invalid append-only PaymentDispute ledger row'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentDispute_ledger_guard';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM "PaymentDispute" d
     WHERE d."depositTransactionId" = OLD.id
        OR d."holdTransactionId" = OLD.id
        OR d."resolutionTransactionId" = OLD.id
  )
  OR EXISTS (
    SELECT 1
      FROM "DepositAttempt" a
     WHERE a."ledgerTransactionId" = OLD.id
       AND "is_wallet_credit_backed_deposit_status"(a.status)
  )
  OR COALESCE(
    OLD.reference LIKE 'payment-dispute:%'
    OR OLD.reference LIKE 'chargeback-hold-%'
    OR OLD.reference LIKE 'chargeback-release-%'
    OR OLD.reference LIKE 'chargeback-lost-%',
    FALSE
  )
  INTO protected;

  IF TG_OP = 'UPDATE' AND COALESCE(
    NEW.reference LIKE 'payment-dispute:%'
    OR NEW.reference LIKE 'chargeback-hold-%'
    OR NEW.reference LIKE 'chargeback-release-%'
    OR NEW.reference LIKE 'chargeback-lost-%',
    FALSE
  ) THEN
    protected := TRUE;
  END IF;

  IF protected THEN
    RAISE EXCEPTION 'PaymentDispute ledger evidence is append-only'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_ledger_guard';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "PaymentDispute_ledger_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "Transaction"
FOR EACH ROW
EXECUTE FUNCTION "guard_payment_dispute_ledger"();

-- A hold/resolution row is inserted before its case FK can be written. Check
-- linkage at transaction end so that legitimate case creation succeeds while
-- standalone rows that merely mimic the reference format cannot commit.
CREATE FUNCTION "require_payment_dispute_ledger_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reference LIKE 'payment-dispute:%'
     AND NOT EXISTS (
       SELECT 1
         FROM "PaymentDispute" d
        WHERE d."holdTransactionId" = NEW.id
           OR d."resolutionTransactionId" = NEW.id
     )
  THEN
    RAISE EXCEPTION 'PaymentDispute ledger row is not linked to a durable case'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_ledger_link_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PaymentDispute_ledger_link_guard"
AFTER INSERT OR UPDATE ON "Transaction"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_payment_dispute_ledger_link"();

-- Normalized signed dispute envelopes and their case association are immutable.
-- A failed/processing event may be retried, and any state may be quarantined,
-- but financial identity can never be replaced in place.
CREATE FUNCTION "guard_payment_provider_event"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  case_row "PaymentDispute"%ROWTYPE;
  attempt_row "DepositAttempt"%ROWTYPE;
  deposit_row "Transaction"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'QUARANTINED')
       OR NEW.attempts <> 0
       OR NEW."lockedAt" IS NOT NULL
       OR NEW."depositAttemptId" IS NOT NULL
       OR NEW."paymentDisputeId" IS NOT NULL
       OR btrim(NEW.provider) = ''
       OR btrim(NEW."providerEventId") = ''
       OR btrim(NEW."eventType") = ''
       OR (NEW.provider = 'stripe' AND NEW.livemode IS NULL)
       OR NEW."eventFingerprint" IS NULL
       OR NEW."eventFingerprint" !~ '^[0-9a-f]{64}$'
       OR (
         NEW.status = 'PENDING'
         AND (
           NEW."processedAt" IS NOT NULL
           OR NEW."lastError" IS NOT NULL
         )
       )
       OR (
         NEW.status = 'QUARANTINED'
         AND (
           NEW."processedAt" IS NULL
           OR NEW."lastError" IS NULL
         )
       )
    THEN
      RAISE EXCEPTION 'Payment provider events must enter as PENDING or malformed QUARANTINED evidence'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment provider events are immutable evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  -- The signature-verified identity/fingerprint envelope is immutable for
  -- every payment event, not only disputes. Workflow lease fields and
  -- server-owned relationship fields are governed separately below.
  IF NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId"
    OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
    OR NEW."objectId" IS DISTINCT FROM OLD."objectId"
    OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
    OR NEW."providerChargeId" IS DISTINCT FROM OLD."providerChargeId"
    OR NEW."disputeAmountMinor" IS DISTINCT FROM OLD."disputeAmountMinor"
    OR NEW."disputeCurrency" IS DISTINCT FROM OLD."disputeCurrency"
    OR NEW."providerStatus" IS DISTINCT FROM OLD."providerStatus"
    OR NEW.livemode IS DISTINCT FROM OLD.livemode
    OR NEW."eventFingerprint" IS DISTINCT FROM OLD."eventFingerprint"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Payment provider-event envelope is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW.status <> 'PROCESSING' AND NEW.attempts <> OLD.attempts THEN
    RAISE EXCEPTION 'Payment provider-event attempts may change only during an exact claim'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW."depositAttemptId" IS DISTINCT FROM OLD."depositAttemptId"
     AND NOT (
       OLD."depositAttemptId" IS NULL
       AND NEW."depositAttemptId" IS NOT NULL
       AND OLD.status = 'PROCESSING'
       AND NEW.status = 'PROCESSED'
     )
  THEN
    RAISE EXCEPTION 'Payment provider-event deposit association is immutable once set'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW."paymentDisputeId" IS DISTINCT FROM OLD."paymentDisputeId"
     AND NOT (
       OLD."paymentDisputeId" IS NULL
       AND NEW."paymentDisputeId" IS NOT NULL
       AND OLD.status = 'PROCESSING'
       AND NEW.status = 'PROCESSED'
     )
  THEN
    RAISE EXCEPTION 'Payment provider-event dispute-case association is immutable once set'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF (OLD.status = 'PENDING' AND NEW.status NOT IN ('PROCESSING', 'QUARANTINED'))
     OR (OLD.status = 'FAILED' AND NEW.status NOT IN ('PROCESSING', 'QUARANTINED'))
     OR (
       OLD.status = 'PROCESSING'
       AND NEW.status NOT IN ('PROCESSED', 'FAILED', 'IGNORED', 'QUARANTINED')
     )
  THEN
    RAISE EXCEPTION 'Invalid payment dispute provider-event state transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW.status = 'PROCESSING'
     AND (
       NEW.attempts <> OLD.attempts + 1
       OR NEW."lockedAt" IS NULL
       OR NEW."processedAt" IS NOT NULL
       OR NEW."lastError" IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Claimed payment provider events require a fresh lease and one attempt increment'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW.status IN ('PROCESSED', 'IGNORED')
     AND (
       NEW."processedAt" IS NULL
       OR NEW."lockedAt" IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Completed payment provider events require terminal processing evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW.status = 'FAILED'
     AND (
       NEW."lockedAt" IS NOT NULL
       OR NEW."lastError" IS NULL
     )
  THEN
    RAISE EXCEPTION 'Failed payment provider events require a durable error and no active lease'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW.status = 'QUARANTINED'
     AND (
       NEW."processedAt" IS NULL
       OR NEW."lockedAt" IS NOT NULL
       OR NEW."lastError" IS NULL
     )
  THEN
    RAISE EXCEPTION 'Quarantined payment provider events require terminal review evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW."eventType" NOT IN ('charge.dispute.created', 'charge.dispute.closed')
     AND NEW."paymentDisputeId" IS NOT NULL
  THEN
    RAISE EXCEPTION 'Only dispute events may be linked to PaymentDispute'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF OLD.status IN ('PROCESSED', 'IGNORED', 'QUARANTINED') THEN
    -- A conflicting duplicate may quarantine previously processed evidence,
    -- but it cannot rewrite the original processing time, scheduling state,
    -- claim count, or case/deposit association.
    IF OLD.status IN ('PROCESSED', 'IGNORED')
       AND NEW.status = 'QUARANTINED'
       AND NEW.attempts = OLD.attempts
       AND NEW."processedAt" IS NOT DISTINCT FROM OLD."processedAt"
       AND NEW."availableAt" IS NOT DISTINCT FROM OLD."availableAt"
       AND NEW."lockedAt" IS NULL
       AND NEW."depositAttemptId" IS NOT DISTINCT FROM OLD."depositAttemptId"
       AND NEW."paymentDisputeId" IS NOT DISTINCT FROM OLD."paymentDisputeId"
       AND NEW."lastError" IS NOT NULL
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Terminal payment dispute provider-event state is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
  END IF;

  IF NEW."eventType" NOT IN ('charge.dispute.created', 'charge.dispute.closed') THEN
    IF NEW."eventType" IN (
         'checkout.session.completed',
         'checkout.session.async_payment_succeeded'
       )
       AND NEW.status = 'PROCESSED'
    THEN
      IF NEW."depositAttemptId" IS NULL THEN
        RAISE EXCEPTION 'Processed deposit success event requires an exact DepositAttempt association'
          USING ERRCODE = '23514',
                CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
      END IF;
      SELECT *
        INTO attempt_row
        FROM "DepositAttempt"
       WHERE id = NEW."depositAttemptId";
      IF NOT FOUND
        OR attempt_row.provider <> NEW.provider
        OR attempt_row."providerSessionId" IS DISTINCT FROM NEW."objectId"
        OR NOT "is_wallet_credit_backed_deposit_status"(attempt_row.status)
        OR attempt_row."ledgerTransactionId" IS NULL
        OR (NEW.provider = 'stripe' AND NEW.livemode IS NULL)
      THEN
        RAISE EXCEPTION 'Processed deposit success event does not match a successful funding attempt'
          USING ERRCODE = '23514',
                CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
      END IF;

      SELECT *
        INTO deposit_row
        FROM "Transaction"
       WHERE id = attempt_row."ledgerTransactionId";
      IF NOT FOUND
        OR deposit_row.type <> 'DEPOSIT'
        OR deposit_row."walletId" IS DISTINCT FROM attempt_row."walletId"
        OR deposit_row.amount IS DISTINCT FROM attempt_row."walletCredit"
        OR deposit_row.currency IS DISTINCT FROM attempt_row.currency
        OR deposit_row.provider IS DISTINCT FROM attempt_row.provider
        OR deposit_row."providerRef" IS DISTINCT FROM attempt_row."providerPaymentId"
      THEN
        RAISE EXCEPTION 'Processed deposit success event does not match its wallet-credit ledger evidence'
          USING ERRCODE = '23514',
                CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'PROCESSED' THEN
    IF NEW."depositAttemptId" IS NULL OR NEW."paymentDisputeId" IS NULL THEN
      RAISE EXCEPTION 'Processed dispute events require exact deposit and case associations'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
    END IF;
    SELECT *
      INTO case_row
      FROM "PaymentDispute"
     WHERE id = NEW."paymentDisputeId";
    IF NOT FOUND
      OR case_row.provider IS DISTINCT FROM NEW.provider
      OR case_row."providerDisputeId" IS DISTINCT FROM NEW."objectId"
      OR case_row."providerPaymentId" IS DISTINCT FROM NEW."providerPaymentId"
      OR case_row."providerChargeId" IS DISTINCT FROM NEW."providerChargeId"
      OR case_row."depositAttemptId" IS DISTINCT FROM NEW."depositAttemptId"
      OR case_row.currency IS DISTINCT FROM NEW."disputeCurrency"
      OR (
        NEW."disputeCurrency" = 'USD'
        AND NEW."disputeAmountMinor" IS DISTINCT FROM (case_row.amount * 100)::BIGINT
      )
      OR (
        NEW."eventType" = 'charge.dispute.created'
        AND case_row."openedByEventId" IS NULL
      )
      OR (
        NEW."eventType" = 'charge.dispute.closed'
        AND (
          case_row.status = 'OPEN'
          OR case_row."resolvedByEventId" IS NULL
        )
      )
    THEN
      RAISE EXCEPTION 'Processed dispute event does not match its durable case'
        USING ERRCODE = '23514',
              CONSTRAINT = 'PaymentProviderEvent_evidence_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentProviderEvent_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PaymentProviderEvent"
FOR EACH ROW
EXECUTE FUNCTION "guard_payment_provider_event"();

-- A case must be able to point at a PROCESSING event while its wallet and
-- ledger changes are assembled, but that provisional association may never
-- commit. Validate the final graph from both tables at transaction end. The
-- reverse trigger matters when an already-designated event is terminalized or
-- quarantined after the case row itself was not touched in that transaction.
--
-- Additional provider events may correlate to the same case (for example an
-- exact semantic duplicate delivered with a distinct provider event ID).
-- Those rows are not opening/resolution evidence and are intentionally outside
-- this role-link constraint.
CREATE FUNCTION "assert_payment_dispute_role_event"(
  case_id TEXT,
  event_id TEXT,
  expected_event_type TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  case_row "PaymentDispute"%ROWTYPE;
  event_row "PaymentProviderEvent"%ROWTYPE;
BEGIN
  SELECT *
    INTO case_row
    FROM "PaymentDispute"
   WHERE id = case_id;
  SELECT *
    INTO event_row
    FROM "PaymentProviderEvent"
   WHERE id = event_id;

  IF case_row.id IS NULL
    OR event_row.id IS NULL
    OR event_row.status <> 'PROCESSED'
    OR event_row."eventType" IS DISTINCT FROM expected_event_type
    OR event_row.provider IS DISTINCT FROM case_row.provider
    OR event_row."objectId" IS DISTINCT FROM case_row."providerDisputeId"
    OR event_row."providerPaymentId" IS DISTINCT FROM case_row."providerPaymentId"
    OR event_row."providerChargeId" IS DISTINCT FROM case_row."providerChargeId"
    OR event_row."depositAttemptId" IS DISTINCT FROM case_row."depositAttemptId"
    OR event_row."paymentDisputeId" IS DISTINCT FROM case_row.id
    OR event_row."disputeCurrency" IS DISTINCT FROM case_row.currency
    OR event_row."disputeAmountMinor" IS DISTINCT FROM
       (case_row.amount * 100)::BIGINT
    OR (
      expected_event_type = 'charge.dispute.created'
      AND case_row.status = 'OPEN'
      AND event_row."providerStatus" IS DISTINCT FROM case_row."providerStatus"
    )
    OR (
      expected_event_type = 'charge.dispute.closed'
      AND event_row."providerStatus" IS DISTINCT FROM case_row."providerStatus"
    )
  THEN
    RAISE EXCEPTION 'PaymentDispute role event is not exact terminal inbox evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'PaymentDispute_event_link_guard';
  END IF;
END;
$$;

CREATE FUNCTION "require_payment_dispute_event_links"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  case_row "PaymentDispute"%ROWTYPE;
  event_row "PaymentProviderEvent"%ROWTYPE;
  role_case RECORD;
BEGIN
  IF TG_TABLE_NAME = 'PaymentDispute' THEN
    -- Constraint triggers may be queued more than once for a row changed
    -- repeatedly. Always validate the final committed candidate, not the
    -- transition snapshot captured in NEW.
    SELECT *
      INTO case_row
      FROM "PaymentDispute"
     WHERE id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF case_row."openedByEventId" IS NOT NULL THEN
      PERFORM "assert_payment_dispute_role_event"(
        case_row.id,
        case_row."openedByEventId",
        'charge.dispute.created'
      );
    END IF;
    IF case_row."resolvedByEventId" IS NOT NULL THEN
      PERFORM "assert_payment_dispute_role_event"(
        case_row.id,
        case_row."resolvedByEventId",
        'charge.dispute.closed'
      );
    END IF;
    RETURN NEW;
  END IF;

  SELECT *
    INTO event_row
    FROM "PaymentProviderEvent"
   WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  FOR role_case IN
    SELECT d.id, d."openedByEventId", d."resolvedByEventId"
      FROM "PaymentDispute" d
     WHERE d."openedByEventId" = event_row.id
        OR d."resolvedByEventId" = event_row.id
  LOOP
    IF role_case."openedByEventId" = event_row.id THEN
      PERFORM "assert_payment_dispute_role_event"(
        role_case.id,
        event_row.id,
        'charge.dispute.created'
      );
    END IF;
    IF role_case."resolvedByEventId" = event_row.id THEN
      PERFORM "assert_payment_dispute_role_event"(
        role_case.id,
        event_row.id,
        'charge.dispute.closed'
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PaymentDispute_event_link_guard"
AFTER INSERT OR UPDATE ON "PaymentDispute"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_payment_dispute_event_links"();

CREATE CONSTRAINT TRIGGER "PaymentProviderEvent_dispute_role_link_guard"
AFTER INSERT OR UPDATE ON "PaymentProviderEvent"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_payment_dispute_event_links"();

-- PaymentDispute is financial evidence, not mutable workflow scratch state.
-- Enforce its one-way lifecycle below the application layer so an ad-hoc query
-- cannot rewrite the amount allocation, wallet/deposit identity, or outcome.
CREATE FUNCTION "guard_payment_dispute_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentDispute rows are immutable financial evidence'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'PaymentDispute_lifecycle_guard';
  END IF;

  IF
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."providerDisputeId" IS DISTINCT FROM OLD."providerDisputeId"
    OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
    OR NEW."providerChargeId" IS DISTINCT FROM OLD."providerChargeId"
    OR NEW."depositAttemptId" IS DISTINCT FROM OLD."depositAttemptId"
    OR NEW."depositTransactionId" IS DISTINCT FROM OLD."depositTransactionId"
    OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."heldAmount" IS DISTINCT FROM OLD."heldAmount"
    OR NEW."shortfallAmount" IS DISTINCT FROM OLD."shortfallAmount"
    OR NEW."holdTransactionId" IS DISTINCT FROM OLD."holdTransactionId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'PaymentDispute booking and correlation fields are immutable'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'PaymentDispute_lifecycle_guard';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'PaymentDispute updates require a single version increment'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'PaymentDispute_lifecycle_guard';
  END IF;

  IF OLD."status" = 'OPEN' THEN
    IF NEW."status" NOT IN ('WON', 'LOST') THEN
      RAISE EXCEPTION 'An OPEN PaymentDispute may only transition to WON or LOST'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'PaymentDispute_lifecycle_guard';
    END IF;

    IF
      NEW."openedByEventId" IS DISTINCT FROM OLD."openedByEventId"
      OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
    THEN
      RAISE EXCEPTION 'Opening evidence is immutable after an OPEN case is recorded'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'PaymentDispute_lifecycle_guard';
    END IF;
  ELSE
    -- A terminal close may be delivered before the provider's opening event.
    -- That missing opening evidence can be attached exactly once; the terminal
    -- outcome and all resolution evidence remain immutable.
    IF
      OLD."openedByEventId" IS NOT NULL
      OR OLD."openedAt" IS NOT NULL
      OR NEW."openedByEventId" IS NULL
      OR NEW."openedAt" IS NULL
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."providerStatus" IS DISTINCT FROM OLD."providerStatus"
      OR NEW."resolvedByEventId" IS DISTINCT FROM OLD."resolvedByEventId"
      OR NEW."resolutionTransactionId" IS DISTINCT FROM OLD."resolutionTransactionId"
      OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
      OR NEW."currentExposureAmount" IS DISTINCT FROM OLD."currentExposureAmount"
    THEN
      RAISE EXCEPTION 'Terminal PaymentDispute evidence and outcome are immutable'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'PaymentDispute_lifecycle_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PaymentDispute_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "PaymentDispute"
FOR EACH ROW
EXECUTE FUNCTION "guard_payment_dispute_lifecycle"();

-- A credited DepositAttempt is immutable funding evidence before a dispute is
-- ever opened. Freezing its identity at that earlier boundary closes the race
-- where an ad-hoc rewrite begins just before the PaymentDispute FK becomes
-- visible. Only the customer-visible derivative status may continue to move.
CREATE FUNCTION "guard_deposit_attempt_dispute_evidence"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  has_case BOOLEAN;
  has_open BOOLEAN;
  has_lost BOOLEAN;
  expected_status "DepositAttemptStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF "is_wallet_credit_backed_deposit_status"(OLD.status)
       OR EXISTS (
         SELECT 1
           FROM "PaymentDispute" d
          WHERE d."depositAttemptId" = OLD.id
       )
    THEN
      RAISE EXCEPTION 'Credited or dispute-linked DepositAttempt evidence cannot be deleted'
        USING ERRCODE = '23514',
              CONSTRAINT = 'DepositAttempt_dispute_evidence_guard';
    END IF;
    RETURN OLD;
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = OLD.id
         ),
         EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = OLD.id
              AND d.status = 'OPEN'
         ),
         EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = OLD.id
              AND d.status = 'LOST'
         )
    INTO has_case, has_open, has_lost;

  IF ("is_wallet_credit_backed_deposit_status"(OLD.status) OR has_case)
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
       OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
       OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
       OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
       OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW."walletCredit" IS DISTINCT FROM OLD."walletCredit"
       OR NEW."customerFee" IS DISTINCT FROM OLD."customerFee"
       OR NEW."providerFee" IS DISTINCT FROM OLD."providerFee"
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
       OR NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId"
       OR NEW."providerPaymentId" IS DISTINCT FROM OLD."providerPaymentId"
       OR NEW."providerChargeId" IS DISTINCT FROM OLD."providerChargeId"
       OR NEW."intendedOrderId" IS DISTINCT FROM OLD."intendedOrderId"
       OR NEW."ledgerTransactionId" IS DISTINCT FROM OLD."ledgerTransactionId"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
       OR NEW."failedAt" IS DISTINCT FROM OLD."failedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     )
  THEN
    RAISE EXCEPTION 'Credited or dispute-linked DepositAttempt identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_evidence_guard';
  END IF;

  IF "is_wallet_credit_backed_deposit_status"(OLD.status)
     AND NOT "is_wallet_credit_backed_deposit_status"(NEW.status)
  THEN
    RAISE EXCEPTION 'A credited DepositAttempt cannot regress to a pre-credit state'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_status_guard';
  END IF;

  -- Refund and dispute facts are independent. Once the refund projection is
  -- published it is sticky; a partial refund may only advance to REFUNDED.
  IF OLD.status = 'REFUNDED' AND NEW.status <> 'REFUNDED'
  THEN
    RAISE EXCEPTION 'A REFUNDED DepositAttempt projection is terminal'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_status_guard';
  END IF;
  IF OLD.status = 'PARTIALLY_REFUNDED'
     AND NEW.status NOT IN ('PARTIALLY_REFUNDED', 'REFUNDED')
  THEN
    RAISE EXCEPTION 'A refund-derived DepositAttempt projection cannot regress'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_status_guard';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED')
  THEN
    RETURN NEW;
  END IF;

  IF has_lost THEN
    expected_status := 'CHARGEBACK';
  ELSIF has_open THEN
    expected_status := 'DISPUTED';
  ELSE
    expected_status := 'SUCCEEDED';
  END IF;

  IF has_case AND NEW.status IS DISTINCT FROM expected_status THEN
    RAISE EXCEPTION 'DepositAttempt status does not match its PaymentDispute aggregate'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_status_guard';
  END IF;
  IF NOT has_case AND NEW.status IN ('DISPUTED', 'CHARGEBACK') THEN
    RAISE EXCEPTION 'Dispute-derived DepositAttempt status requires a durable PaymentDispute'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_status_guard';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "DepositAttempt_dispute_evidence_guard"
BEFORE UPDATE OR DELETE ON "DepositAttempt"
FOR EACH ROW
EXECUTE FUNCTION "guard_deposit_attempt_dispute_evidence"();

-- The case and its DepositAttempt projection are written in separate
-- statements. Re-check the final aggregate from both directions at commit so
-- either statement order is safe and a case cannot commit without its
-- customer-visible projection (or vice versa).
CREATE FUNCTION "assert_deposit_attempt_dispute_projection"(
  attempt_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_row "DepositAttempt"%ROWTYPE;
  has_case BOOLEAN;
  has_open BOOLEAN;
  has_lost BOOLEAN;
  expected_status "DepositAttemptStatus";
BEGIN
  SELECT *
    INTO attempt_row
    FROM "DepositAttempt"
   WHERE id = attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PaymentDispute deposit attempt is missing'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_projection_guard';
  END IF;

  SELECT EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = attempt_row.id
         ),
         EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = attempt_row.id
              AND d.status = 'OPEN'
         ),
         EXISTS (
           SELECT 1
             FROM "PaymentDispute" d
            WHERE d."depositAttemptId" = attempt_row.id
              AND d.status = 'LOST'
         )
    INTO has_case, has_open, has_lost;
  IF NOT has_case THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "PaymentDispute" d
     WHERE d."depositAttemptId" = attempt_row.id
       AND (
         attempt_row."ledgerTransactionId" IS DISTINCT FROM
           d."depositTransactionId"
         OR attempt_row."walletId" IS DISTINCT FROM d."walletId"
         OR attempt_row.currency IS DISTINCT FROM d.currency
         OR attempt_row.provider IS DISTINCT FROM d.provider
         OR attempt_row."providerPaymentId" IS DISTINCT FROM
           d."providerPaymentId"
       )
  ) THEN
    RAISE EXCEPTION 'PaymentDispute no longer matches immutable DepositAttempt evidence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_projection_guard';
  END IF;

  IF attempt_row.status IN ('PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RETURN;
  END IF;
  IF has_lost THEN
    expected_status := 'CHARGEBACK';
  ELSIF has_open THEN
    expected_status := 'DISPUTED';
  ELSE
    expected_status := 'SUCCEEDED';
  END IF;
  IF attempt_row.status IS DISTINCT FROM expected_status THEN
    RAISE EXCEPTION 'DepositAttempt status does not match its committed PaymentDispute aggregate'
      USING ERRCODE = '23514',
            CONSTRAINT = 'DepositAttempt_dispute_projection_guard';
  END IF;
END;
$$;

CREATE FUNCTION "require_deposit_attempt_dispute_projection"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'PaymentDispute' THEN
    PERFORM "assert_deposit_attempt_dispute_projection"(
      NEW."depositAttemptId"
    );
  ELSE
    PERFORM "assert_deposit_attempt_dispute_projection"(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "PaymentDispute_deposit_projection_guard"
AFTER INSERT OR UPDATE ON "PaymentDispute"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_deposit_attempt_dispute_projection"();

CREATE CONSTRAINT TRIGGER "DepositAttempt_dispute_projection_guard"
AFTER UPDATE ON "DepositAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "require_deposit_attempt_dispute_projection"();

COMMIT;
