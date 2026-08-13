-- Authenticated Stripe retrieval catch-up for deposits whose signed webhook
-- never reached the wallet-credit finalizer. Retrieval evidence intentionally
-- lives outside PaymentProviderEvent: it has no webhook envelope/signature.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
-- DDL below intentionally creates application types, tables, and functions in
-- public. Functions still pin pg_catalog first when they execute.
SET LOCAL search_path = public, pg_catalog, pg_temp;

-- The new FKs and evidence guards must see a stable attempt identity graph.
-- Reads stay available; concurrent attempt writers wait for this bounded
-- migration rather than racing constraint installation.
LOCK TABLE public."DepositAttempt" IN SHARE ROW EXCLUSIVE MODE;

CREATE TYPE "DepositCreditRecoveryStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'FAILED',
  'PROCESSED',
  'CLOSED_UNPAID',
  'SUPERSEDED',
  'QUARANTINED'
);

CREATE TYPE "DepositCreditEvidenceSource" AS ENUM (
  'AUTHENTICATED_PROVIDER_RETRIEVAL'
);

CREATE TABLE "DepositCreditRecovery" (
  "id" TEXT NOT NULL,
  "depositAttemptId" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL DEFAULT 'stripe',
  "status" "DepositCreditRecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "evidenceId" TEXT,
  "lastError" VARCHAR(100),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DepositCreditRecovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DepositCreditRecovery_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "DepositCreditRecovery_lease_shape_check" CHECK (
    "attempts" >= 0
    AND ("status" <> 'PROCESSING' OR "attempts" > 0)
    AND (("status" = 'PROCESSING') = ("lockedAt" IS NOT NULL))
    AND (
      ("status" IN ('PROCESSED', 'CLOSED_UNPAID', 'SUPERSEDED', 'QUARANTINED'))
      = ("processedAt" IS NOT NULL)
    )
    AND (
      "status" NOT IN ('PROCESSED', 'CLOSED_UNPAID')
      OR "evidenceId" IS NOT NULL
    )
    AND (
      "evidenceId" IS NULL
      OR "status" IN ('PROCESSED', 'CLOSED_UNPAID', 'QUARANTINED')
    )
  )
);

CREATE TABLE "DepositCreditEvidence" (
  "id" TEXT NOT NULL,
  "recoveryId" TEXT NOT NULL,
  "depositAttemptId" TEXT NOT NULL,
  "source" "DepositCreditEvidenceSource" NOT NULL DEFAULT 'AUTHENTICATED_PROVIDER_RETRIEVAL',
  "provider" VARCHAR(32) NOT NULL DEFAULT 'stripe',
  "providerSessionId" VARCHAR(191) NOT NULL,
  "providerPaymentId" VARCHAR(191),
  "providerChargeId" VARCHAR(191),
  "clientReferenceId" VARCHAR(191),
  "checkoutStatus" VARCHAR(64),
  "checkoutPaymentStatus" VARCHAR(64),
  "checkoutMode" VARCHAR(32),
  "checkoutAmountTotalMinor" BIGINT,
  "checkoutCurrency" VARCHAR(3),
  "checkoutLivemode" BOOLEAN NOT NULL,
  "checkoutMetadataAttemptId" VARCHAR(191),
  "checkoutMetadataReference" VARCHAR(32),
  "checkoutMetadataWalletId" VARCHAR(191),
  "checkoutMetadataUserId" VARCHAR(191),
  "checkoutMetadataOrgId" VARCHAR(191),
  "paymentIntentStatus" VARCHAR(64),
  "paymentIntentAmountMinor" BIGINT,
  "paymentIntentReceivedMinor" BIGINT,
  "paymentIntentCurrency" VARCHAR(3),
  "paymentIntentLivemode" BOOLEAN,
  "paymentMetadataAttemptId" VARCHAR(191),
  "paymentMetadataReference" VARCHAR(32),
  "paymentMetadataWalletId" VARCHAR(191),
  "chargePaid" BOOLEAN,
  "chargeCaptured" BOOLEAN,
  "chargeRefunded" BOOLEAN,
  "chargeAmountMinor" BIGINT,
  "chargeAmountCapturedMinor" BIGINT,
  "chargeCurrency" VARCHAR(3),
  "chargeLivemode" BOOLEAN,
  "evidenceFingerprint" VARCHAR(64) NOT NULL,
  "claimAttempt" INTEGER NOT NULL,
  "claimLockedAt" TIMESTAMP(3) NOT NULL,
  "retrievedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DepositCreditEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DepositCreditEvidence_provider_check" CHECK ("provider" = 'stripe'),
  CONSTRAINT "DepositCreditEvidence_fingerprint_check" CHECK (
    "evidenceFingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "DepositCreditEvidence_minor_amounts_check" CHECK (
    ("checkoutAmountTotalMinor" IS NULL OR "checkoutAmountTotalMinor" >= 0)
    AND ("paymentIntentAmountMinor" IS NULL OR "paymentIntentAmountMinor" >= 0)
    AND ("paymentIntentReceivedMinor" IS NULL OR "paymentIntentReceivedMinor" >= 0)
    AND ("chargeAmountMinor" IS NULL OR "chargeAmountMinor" >= 0)
    AND ("chargeAmountCapturedMinor" IS NULL OR "chargeAmountCapturedMinor" >= 0)
  ),
  CONSTRAINT "DepositCreditEvidence_provider_graph_check" CHECK (
    "source" = 'AUTHENTICATED_PROVIDER_RETRIEVAL'
    AND "provider" = 'stripe'
    AND (
      "providerPaymentId" IS NOT NULL
      OR (
        "providerChargeId" IS NULL
        AND "paymentIntentStatus" IS NULL
        AND "paymentIntentAmountMinor" IS NULL
        AND "paymentIntentReceivedMinor" IS NULL
        AND "paymentIntentCurrency" IS NULL
        AND "paymentIntentLivemode" IS NULL
        AND "paymentMetadataAttemptId" IS NULL
        AND "paymentMetadataReference" IS NULL
        AND "paymentMetadataWalletId" IS NULL
      )
    )
    AND (
      "providerChargeId" IS NOT NULL
      OR (
        "chargePaid" IS NULL
        AND "chargeCaptured" IS NULL
        AND "chargeRefunded" IS NULL
        AND "chargeAmountMinor" IS NULL
        AND "chargeAmountCapturedMinor" IS NULL
        AND "chargeCurrency" IS NULL
        AND "chargeLivemode" IS NULL
      )
    )
  ),
  CONSTRAINT "DepositCreditEvidence_claim_check" CHECK ("claimAttempt" > 0),
  CONSTRAINT "DepositCreditEvidence_session_id_check" CHECK (
    LENGTH(BTRIM("providerSessionId")) BETWEEN 1 AND 191
  )
);

CREATE UNIQUE INDEX "DepositCreditRecovery_depositAttemptId_key"
  ON "DepositCreditRecovery"("depositAttemptId");
CREATE UNIQUE INDEX "DepositCreditRecovery_evidenceId_key"
  ON "DepositCreditRecovery"("evidenceId");
CREATE INDEX "DepositCreditRecovery_status_availableAt_createdAt_idx"
  ON "DepositCreditRecovery"("status", "availableAt", "createdAt");
CREATE UNIQUE INDEX "DepositCreditEvidence_recoveryId_claimAttempt_evidenceFingerprint_key"
  ON "DepositCreditEvidence"("recoveryId", "claimAttempt", "evidenceFingerprint");
CREATE INDEX "DepositCreditEvidence_depositAttemptId_retrievedAt_idx"
  ON "DepositCreditEvidence"("depositAttemptId", "retrievedAt");
CREATE INDEX "DepositCreditEvidence_provider_providerSessionId_idx"
  ON "DepositCreditEvidence"("provider", "providerSessionId");

ALTER TABLE "DepositCreditRecovery"
  ADD CONSTRAINT "DepositCreditRecovery_depositAttemptId_fkey"
  FOREIGN KEY ("depositAttemptId") REFERENCES "DepositAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositCreditEvidence"
  ADD CONSTRAINT "DepositCreditEvidence_recoveryId_fkey"
  FOREIGN KEY ("recoveryId") REFERENCES "DepositCreditRecovery"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositCreditEvidence"
  ADD CONSTRAINT "DepositCreditEvidence_depositAttemptId_fkey"
  FOREIGN KEY ("depositAttemptId") REFERENCES "DepositAttempt"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DepositCreditRecovery"
  ADD CONSTRAINT "DepositCreditRecovery_evidenceId_fkey"
  FOREIGN KEY ("evidenceId") REFERENCES "DepositCreditEvidence"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION guard_deposit_attempt_recovery_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
        FROM "DepositCreditRecovery" r
       WHERE r."depositAttemptId" = OLD.id
    ) THEN
      RAISE EXCEPTION 'Recovery-linked DepositAttempt evidence cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "DepositCreditRecovery" r
     WHERE r."depositAttemptId" = OLD.id
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
     OR NEW."walletId" IS DISTINCT FROM OLD."walletId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW."walletCredit" IS DISTINCT FROM OLD."walletCredit"
     OR NEW."customerFee" IS DISTINCT FROM OLD."customerFee"
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW."providerSessionId" IS DISTINCT FROM OLD."providerSessionId"
  THEN
    RAISE EXCEPTION 'Recovery-linked DepositAttempt command identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DepositAttempt_recovery_identity_guard"
BEFORE UPDATE OR DELETE ON "DepositAttempt"
FOR EACH ROW EXECUTE FUNCTION guard_deposit_attempt_recovery_identity();

CREATE OR REPLACE FUNCTION guard_deposit_credit_recovery_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider <> 'stripe'
       OR NEW.status <> 'PENDING'
       OR NEW.attempts <> 0
       OR NEW."lockedAt" IS NOT NULL
       OR NEW."processedAt" IS NOT NULL
       OR NEW."evidenceId" IS NOT NULL
       OR NEW."lastError" IS NOT NULL THEN
      RAISE EXCEPTION 'deposit credit recovery must begin in canonical pending state'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposit credit recovery evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."depositAttemptId" IS DISTINCT FROM OLD."depositAttemptId"
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'deposit credit recovery identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('PROCESSED', 'CLOSED_UNPAID', 'SUPERSEDED', 'QUARANTINED') THEN
    RAISE EXCEPTION 'terminal deposit credit recovery is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('PENDING', 'FAILED') THEN
    IF NEW.status <> 'PROCESSING'
       OR NEW.attempts <> OLD.attempts + 1
       OR OLD."lockedAt" IS NOT NULL
       OR NEW."lockedAt" IS NULL
       OR NEW."processedAt" IS NOT NULL
       OR NEW."evidenceId" IS NOT NULL THEN
      RAISE EXCEPTION 'deposit credit recovery claim transition is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PROCESSING' THEN
    IF NEW.status NOT IN ('FAILED', 'PROCESSED', 'CLOSED_UNPAID', 'SUPERSEDED', 'QUARANTINED')
       OR NEW.attempts <> OLD.attempts
       OR NEW."lockedAt" IS NOT NULL
       -- A deterministic provider-retrieval failure can quarantine the
       -- command before an evidence row exists. Successful/closed authority
       -- decisions still require the exact selected evidence.
       OR (NEW.status IN ('PROCESSED', 'CLOSED_UNPAID') AND NEW."evidenceId" IS NULL)
       OR (NEW.status IN ('FAILED', 'SUPERSEDED') AND NEW."evidenceId" IS NOT NULL)
       OR (NEW.status = 'FAILED' AND NEW."processedAt" IS NOT NULL)
       OR (NEW.status = 'SUPERSEDED' AND NEW."processedAt" IS NULL)
       OR (NEW.status IN ('PROCESSED', 'CLOSED_UNPAID', 'QUARANTINED') AND NEW."processedAt" IS NULL) THEN
      RAISE EXCEPTION 'deposit credit recovery completion transition is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unsupported deposit credit recovery transition'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "DepositCreditRecovery_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "DepositCreditRecovery"
FOR EACH ROW EXECUTE FUNCTION guard_deposit_credit_recovery_lifecycle();

CREATE OR REPLACE FUNCTION validate_deposit_credit_recovery_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  evidence_recovery_id TEXT;
  evidence_attempt_id TEXT;
  evidence_claim_attempt INTEGER;
  evidence_claim_locked_at TIMESTAMP(3);
BEGIN
  IF NEW."evidenceId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "recoveryId", "depositAttemptId", "claimAttempt", "claimLockedAt"
    INTO evidence_recovery_id, evidence_attempt_id,
         evidence_claim_attempt, evidence_claim_locked_at
    FROM "DepositCreditEvidence"
    WHERE "id" = NEW."evidenceId";
  IF evidence_recovery_id IS DISTINCT FROM NEW."id"
     OR evidence_attempt_id IS DISTINCT FROM NEW."depositAttemptId"
     OR evidence_claim_attempt IS DISTINCT FROM NEW.attempts
     OR TG_OP <> 'UPDATE'
     OR evidence_claim_locked_at IS DISTINCT FROM OLD."lockedAt" THEN
    RAISE EXCEPTION 'selected deposit-credit evidence does not belong to recovery aggregate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DepositCreditRecovery_selected_evidence_guard"
BEFORE INSERT OR UPDATE OF "evidenceId", "depositAttemptId"
ON "DepositCreditRecovery"
FOR EACH ROW EXECUTE FUNCTION validate_deposit_credit_recovery_evidence();

CREATE OR REPLACE FUNCTION validate_deposit_credit_evidence_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  recovery_attempt_id TEXT;
  recovery_status "DepositCreditRecoveryStatus";
  recovery_attempts INTEGER;
  recovery_locked_at TIMESTAMP(3);
BEGIN
  SELECT "depositAttemptId", status, attempts, "lockedAt"
    INTO recovery_attempt_id, recovery_status, recovery_attempts, recovery_locked_at
    FROM "DepositCreditRecovery"
    WHERE id = NEW."recoveryId"
    FOR UPDATE;
  IF recovery_attempt_id IS DISTINCT FROM NEW."depositAttemptId"
     OR recovery_status IS DISTINCT FROM 'PROCESSING'
     OR recovery_attempts IS DISTINCT FROM NEW."claimAttempt"
     OR recovery_locked_at IS DISTINCT FROM NEW."claimLockedAt" THEN
    RAISE EXCEPTION 'deposit credit evidence is not owned by the current recovery lease'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "DepositCreditEvidence_claim_guard"
BEFORE INSERT ON "DepositCreditEvidence"
FOR EACH ROW EXECUTE FUNCTION validate_deposit_credit_evidence_insert();

CREATE OR REPLACE FUNCTION prevent_deposit_credit_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'deposit credit evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "DepositCreditEvidence_no_update"
BEFORE UPDATE ON "DepositCreditEvidence"
FOR EACH ROW EXECUTE FUNCTION prevent_deposit_credit_evidence_mutation();

CREATE TRIGGER "DepositCreditEvidence_no_delete"
BEFORE DELETE ON "DepositCreditEvidence"
FOR EACH ROW EXECUTE FUNCTION prevent_deposit_credit_evidence_mutation();

COMMIT;
