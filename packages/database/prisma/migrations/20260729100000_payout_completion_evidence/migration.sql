-- Canonical, evidence-backed payout completion provenance.
--
-- This migration is additive, but intentionally fail-closed:
--   * existing completed rows are honestly classified LEGACY_UNVERIFIED;
--   * new application code writes the full evidence record atomically;
--   * old writers are rejected by the completion CHECK after migration.
--
-- Freeze new payout sends, drain old API/worker instances, apply this migration,
-- deploy the canonical finalizer, then resume sends. Verified webhook inbox
-- rows remain durable and retry after the deploy.

-- Prisma 7 does not wrap migrations in a transaction. The preflight is the
-- first executable statement and every following DDL/backfill either commits
-- together or rolls back together.
BEGIN;

-- Fail fast behind an unexpected old writer instead of hanging a finance
-- deploy indefinitely. The whole migration rolls back on either timeout.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- Freeze every relation read by the preflight and provenance backfills before
-- the first READ COMMITTED snapshot. Otherwise an old writer could add a
-- conflicting actor or payout row after the DO block but before its later
-- backfill/constraint statement. Keep this list alphabetic as the stable
-- migration lock order. SHARE blocks concurrent INSERT/UPDATE/DELETE while
-- permitting reads; this transaction may still update and alter these tables.
LOCK TABLE
  "AuditLog",
  "PayoutExecution",
  "PayoutMethod",
  "PayoutProvider",
  "Withdrawal"
IN SHARE MODE;

-- Read-only preflight. Do not create a type/column/index until every existing
-- invariant needed by this migration is known to hold.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PayoutExecution"
    WHERE "status" IN ('PENDING', 'PROCESSING', 'COMPLETED')
    GROUP BY "withdrawalId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: multiple active/completed money movements exist for one withdrawal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PayoutExecution"
    WHERE "bankTraceReference" IS NOT NULL
    GROUP BY "providerId", "bankTraceReference"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: a provider-scoped bank trace reference is reused';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        "providerId",
        COALESCE(
          "providerPayoutId",
          "providerExecutionId",
          "bankTraceReference"
        ) AS "prospectiveEvidenceRef"
      FROM "PayoutExecution"
      WHERE "status" = 'COMPLETED'
    ) AS completed
    WHERE completed."prospectiveEvidenceRef" IS NOT NULL
    GROUP BY completed."providerId", completed."prospectiveEvidenceRef"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: a prospective provider-scoped completion evidence reference is reused';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Withdrawal"
    WHERE ("approvedBy" IS NULL) <> ("approvedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: existing withdrawal approval actor/timestamp provenance is mismatched';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PayoutMethod"
    WHERE "providerAccountId" IS NOT NULL
    GROUP BY "providerAccountId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: multiple managed payout methods reference one provider account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PayoutProvider"
    WHERE "configEncryptionKeyVersion" < 0
      OR NOT (
        "config" = '{}'::jsonb
        OR (
          jsonb_typeof("config") = 'string'
          AND LENGTH("config" #>> '{}') > 0
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: provider config must be encrypted ciphertext or an empty object';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AuditLog"
    WHERE "entityType" = 'Withdrawal'
      AND "action" IN (
        'WITHDRAWAL_REQUESTED',
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_REJECTED',
        'WITHDRAWAL_REVERSED'
      )
      AND "userId" IS NOT NULL
    GROUP BY "entityId", "action"
    HAVING COUNT(DISTINCT "userId") > 1
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration blocked: withdrawal provenance audits contain conflicting actors';
  END IF;
END $$;

CREATE TYPE "PayoutCompletionSource" AS ENUM (
  'PROVIDER_RESPONSE',
  'PROVIDER_WEBHOOK',
  'PROVIDER_STATUS_POLL',
  'MANUAL_BANK_CONFIRMATION',
  'LEGACY_UNVERIFIED'
);

CREATE TYPE "PayoutCancellationSource" AS ENUM (
  'PRE_PROVIDER_ABORT',
  'PROVIDER_RESPONSE',
  'LEGACY_UNVERIFIED'
);

CREATE TYPE "PayoutExecutionClaimKind" AS ENUM (
  'PROVIDER_SEND',
  'BANK_PAYOUT_SEND'
);

ALTER TABLE "Withdrawal"
  ADD COLUMN "requestedBy" TEXT,
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "reversedBy" TEXT,
  ADD COLUMN "reversedAt" TIMESTAMP(3);

ALTER TABLE "PayoutMethod"
  ADD COLUMN "nonterminalWithdrawalCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PayoutExecution"
  ADD COLUMN "initiatedByUserId" TEXT,
  ADD COLUMN "livemode" BOOLEAN,
  ADD COLUMN "completionSource" "PayoutCompletionSource",
  ADD COLUMN "completionEvidenceRef" VARCHAR(191),
  ADD COLUMN "completionEvidenceAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "completionActorUserId" TEXT,
  ADD COLUMN "completionWebhookEventId" TEXT,
  ADD COLUMN "cancellationSource" "PayoutCancellationSource",
  ADD COLUMN "cancellationEvidenceRef" VARCHAR(191),
  ADD COLUMN "cancellationEvidenceAt" TIMESTAMP(3),
  ADD COLUMN "cancellationPayoutStatus" VARCHAR(32),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationActorUserId" TEXT;

ALTER TABLE "PayoutWebhookEvent"
  ADD COLUMN "providerAccountExternalId" VARCHAR(191),
  ADD COLUMN "payoutAmountMinor" BIGINT,
  ADD COLUMN "payoutCurrency" VARCHAR(3),
  ADD COLUMN "livemode" BOOLEAN;

-- One immutable row authorizes one external money-moving call family. The
-- exact idempotency key is retained so PostgreSQL can bind the claim to its
-- execution; the fingerprint is retained for safe application/provider logs.
CREATE TABLE "PayoutExecutionClaim" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "kind" "PayoutExecutionClaimKind" NOT NULL,
  "idempotencyKey" VARCHAR(191) NOT NULL,
  "idempotencyKeyFingerprint" VARCHAR(64) NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL,
  "lastClaimedAt" TIMESTAMP(3) NOT NULL,
  "claimedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PayoutExecutionClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayoutExecutionClaim_executionId_kind_key"
  ON "PayoutExecutionClaim"("executionId", "kind");
CREATE INDEX "PayoutExecutionClaim_claimedByUserId_idx"
  ON "PayoutExecutionClaim"("claimedByUserId");
CREATE INDEX "PayoutExecutionClaim_kind_lastClaimedAt_idx"
  ON "PayoutExecutionClaim"("kind", "lastClaimedAt");

ALTER TABLE "PayoutExecutionClaim"
  ADD CONSTRAINT "PayoutExecutionClaim_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "PayoutExecution"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutExecutionClaim"
  ADD CONSTRAINT "PayoutExecutionClaim_claimedByUserId_fkey"
  FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Denormalize the number of still-reserved withdrawals onto the payout
-- method. Withdrawal lifecycle triggers maintain this counter by atomic row
-- updates, which serializes deactivation against both new reservations and
-- terminal liability releases without taking locks in the inverse
-- Withdrawal -> PayoutMethod order used by payout execution.
UPDATE "PayoutMethod" AS method
SET "nonterminalWithdrawalCount" = (
  SELECT COUNT(*)::INTEGER
  FROM "Withdrawal" AS withdrawal
  WHERE withdrawal."payoutMethodId" = method."id"
    AND withdrawal."status" IN (
      'PENDING',
      'APPROVED',
      'PROCESSING',
      'FAILED'
    )
);

ALTER TABLE "PayoutMethod"
  ADD CONSTRAINT "PayoutMethod_nonterminal_withdrawal_count_check"
  CHECK ("nonterminalWithdrawalCount" >= 0);

-- Provider credentials are either authenticated ciphertext or absent. The
-- empty object is a deliberate sentinel for built-ins whose secrets live in
-- process environment; non-empty plaintext JSON would expose credentials.
ALTER TABLE "PayoutProvider"
  ADD CONSTRAINT "PayoutProvider_config_ciphertext_or_empty_check"
  CHECK (
    "configEncryptionKeyVersion" >= 0
    AND (
      "config" = '{}'::jsonb
      OR (
        jsonb_typeof("config") = 'string'
        AND LENGTH("config" #>> '{}') > 0
      )
    )
  );

-- PostgreSQL permits multiple NULLs in a UNIQUE index, so manual methods stay
-- unrestricted while each provider-managed destination has exactly one
-- lifecycle row. The preflight above rejects ambiguous historical ownership
-- rather than selecting or deactivating a winner during a financial migration.
DROP INDEX "PayoutMethod_providerAccountId_idx";
CREATE UNIQUE INDEX "PayoutMethod_providerAccountId_key"
  ON "PayoutMethod"("providerAccountId");

CREATE FUNCTION "guard_payout_method_liability_state"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."nonterminalWithdrawalCount" <> 0 THEN
      RAISE EXCEPTION
        'New payout methods cannot begin with reserved withdrawal liability'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."type" = 'stripe_connect'
      OR NEW."providerAccountId" IS NOT NULL THEN
      IF NEW."type" <> 'stripe_connect'
        OR NEW."providerAccountId" IS NULL THEN
        RAISE EXCEPTION
          'Managed payout method requires a canonical Stripe account binding'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1
      FROM "PublisherProviderAccount" AS account
      WHERE account."id" = NEW."providerAccountId"
        AND account."publisherId" = NEW."publisherId"
        AND account."provider" = 'stripe_connect'
        AND account."isActive" = TRUE
        AND account."status" = 'ENABLED'
        AND account."transfersEnabled" = TRUE
        AND account."payoutsEnabled" = TRUE
        AND account."detailsSubmitted" = TRUE
        AND account."payoutScheduleConfigured" = TRUE
        AND UPPER(account."defaultCurrency") = 'USD'
      ;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Managed Stripe payout method requires a fully ready provider account'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Only the nested Withdrawal lifecycle trigger may mutate this authority
  -- counter. This rejects stale/manual attempts to zero the counter and
  -- deactivate a method in one statement.
  IF NEW."nonterminalWithdrawalCount"
      IS DISTINCT FROM OLD."nonterminalWithdrawalCount"
    AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION
      'Payout method withdrawal-liability count is trigger-maintained'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" THEN
    RAISE EXCEPTION
      'Payout method routing identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."isActive" = TRUE
    AND NEW."isActive" = FALSE
    AND OLD."nonterminalWithdrawalCount" <> 0 THEN
    RAISE EXCEPTION
      'Payout method has nonterminal reserved withdrawals'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."isActive" = FALSE
    AND NEW."isActive" = TRUE
    AND NEW."nonterminalWithdrawalCount" <> 0 THEN
    RAISE EXCEPTION
      'Payout method with reserved withdrawal liability cannot be activated'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."isActive" = FALSE
    AND NEW."isActive" = TRUE
    AND (
      NEW."type" = 'stripe_connect'
      OR NEW."providerAccountId" IS NOT NULL
    ) THEN
    IF NEW."type" <> 'stripe_connect'
      OR NEW."providerAccountId" IS NULL THEN
      RAISE EXCEPTION
        'Managed payout method requires a canonical Stripe account binding'
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM "PublisherProviderAccount" AS account
    WHERE account."id" = NEW."providerAccountId"
      AND account."publisherId" = NEW."publisherId"
      AND account."provider" = 'stripe_connect'
      AND account."isActive" = TRUE
      AND account."status" = 'ENABLED'
      AND account."transfersEnabled" = TRUE
      AND account."payoutsEnabled" = TRUE
      AND account."detailsSubmitted" = TRUE
      AND account."payoutScheduleConfigured" = TRUE
      AND UPPER(account."defaultCurrency") = 'USD'
    ;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Managed Stripe payout method requires a fully ready provider account'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutMethod_liability_state_guard"
BEFORE INSERT OR UPDATE ON "PayoutMethod"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_method_liability_state"();

-- Provider account rows are immutable routing identities. Stripe sync may
-- update readiness/status facts, but no runtime writer may rebind or erase
-- the account that payout-method and execution evidence references.
CREATE FUNCTION "guard_publisher_provider_account_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Publisher provider accounts are routing evidence and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Publisher provider account routing identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PublisherProviderAccount_identity_guard"
BEFORE UPDATE OR DELETE ON "PublisherProviderAccount"
FOR EACH ROW
EXECUTE FUNCTION "guard_publisher_provider_account_identity"();

-- The deployed predecessor performed its first provider call while an
-- execution still said CREATED. A pre-existing row at that stage therefore
-- cannot prove that no request escaped. Quarantine it instead of letting the
-- new pre-provider abort path release liability or authorize a replacement.
UPDATE "PayoutExecution"
SET
  "stage" = 'LEGACY_PROVIDER_OUTCOME_UNKNOWN',
  "errorMessage" = COALESCE(
    "errorMessage",
    'Pre-migration provider-call outcome is not provably absent'
  )
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED')
  AND "stage" IN ('CREATED', 'DESTINATION_VALIDATED')
  AND "providerExecutionId" IS NULL
  AND "providerTransferId" IS NULL
  AND "providerPayoutId" IS NULL;

-- Mutable JSON must never shadow first-class authorization. No deployed
-- writer used externalClaims before this migration, but remove any stray
-- pre-release metadata defensively and reject it in the trigger below.
UPDATE "PayoutExecution"
SET "providerMetadata" = "providerMetadata" - 'externalClaims'
WHERE JSONB_TYPEOF("providerMetadata") = 'object'
  AND "providerMetadata" ? 'externalClaims';

-- Requester provenance is recoverable only from the immutable request audit.
-- Rows without such an audit remain NULL and fail approval closed; never
-- guess an actor from current publisher membership.
UPDATE "Withdrawal" AS w
SET "requestedBy" = (
  SELECT a."userId"
  FROM "AuditLog" AS a
  WHERE a."entityType" = 'Withdrawal'
    AND a."entityId" = w."id"
    AND a."action" = 'WITHDRAWAL_REQUESTED'
    AND a."userId" IS NOT NULL
  ORDER BY a."createdAt" ASC, a."id" ASC
  LIMIT 1
)
WHERE w."requestedBy" IS NULL
  AND 1 = (
    SELECT COUNT(DISTINCT a."userId")
    FROM "AuditLog" AS a
    WHERE a."entityType" = 'Withdrawal'
      AND a."entityId" = w."id"
      AND a."action" = 'WITHDRAWAL_REQUESTED'
      AND a."userId" IS NOT NULL
  );

-- Recover the execution initiator only from the immutable start audit. Active
-- manual rows without this evidence remain blocked from manual completion.
UPDATE "PayoutExecution" AS execution
SET "initiatedByUserId" = (
  SELECT audit."userId"
  FROM "AuditLog" AS audit
  WHERE audit."entityType" = 'PayoutExecution'
    AND audit."entityId" = execution."id"
    AND audit."action" = 'PAYOUT_EXECUTION_STARTED'
    AND audit."userId" IS NOT NULL
  ORDER BY audit."createdAt" ASC, audit."id" ASC
  LIMIT 1
)
WHERE execution."initiatedByUserId" IS NULL
  AND 1 = (
    SELECT COUNT(DISTINCT audit."userId")
    FROM "AuditLog" AS audit
    WHERE audit."entityType" = 'PayoutExecution'
      AND audit."entityId" = execution."id"
      AND audit."action" = 'PAYOUT_EXECUTION_STARTED'
      AND audit."userId" IS NOT NULL
  );

-- Historical rejection/reversal code overloaded approvedBy/approvedAt. Recover
-- an actor and timestamp from the same immutable audit row. If no such row
-- exists, preserve the legacy approval fields only when they form a complete
-- pair; otherwise leave both dedicated fields NULL rather than inventing
-- provenance.
WITH rejection_source AS (
  SELECT
    w."id",
    COALESCE(
      audit."userId",
      CASE
        WHEN w."approvedBy" IS NOT NULL AND w."approvedAt" IS NOT NULL
          THEN w."approvedBy"
        ELSE NULL
      END
    ) AS actor,
    COALESCE(
      audit."createdAt",
      CASE
        WHEN w."approvedBy" IS NOT NULL AND w."approvedAt" IS NOT NULL
          THEN w."approvedAt"
        ELSE NULL
      END
    ) AS acted_at
  FROM "Withdrawal" AS w
  LEFT JOIN LATERAL (
    SELECT a."userId", a."createdAt"
    FROM "AuditLog" AS a
    WHERE a."entityType" = 'Withdrawal'
      AND a."entityId" = w."id"
      AND a."action" = 'WITHDRAWAL_REJECTED'
      AND a."userId" IS NOT NULL
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT 1
  ) AS audit ON TRUE
  WHERE w."status" = 'REJECTED'
)
UPDATE "Withdrawal" AS w
SET
  "rejectedBy" = source.actor,
  "rejectedAt" = source.acted_at,
  "approvedBy" = NULL,
  "approvedAt" = NULL
FROM rejection_source AS source
WHERE w."id" = source."id";

WITH reversal_source AS (
  SELECT
    w."id",
    COALESCE(
      reversal."userId",
      CASE
        WHEN w."approvedBy" IS NOT NULL AND w."approvedAt" IS NOT NULL
          THEN w."approvedBy"
        ELSE NULL
      END
    ) AS reversal_actor,
    COALESCE(
      reversal."createdAt",
      CASE
        WHEN w."approvedBy" IS NOT NULL AND w."approvedAt" IS NOT NULL
          THEN w."approvedAt"
        ELSE NULL
      END
    ) AS reversed_at,
    approval."userId" AS approval_actor,
    approval."createdAt" AS approved_at
  FROM "Withdrawal" AS w
  LEFT JOIN LATERAL (
    SELECT a."userId", a."createdAt"
    FROM "AuditLog" AS a
    WHERE a."entityType" = 'Withdrawal'
      AND a."entityId" = w."id"
      AND a."action" = 'WITHDRAWAL_REVERSED'
      AND a."userId" IS NOT NULL
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT 1
  ) AS reversal ON TRUE
  LEFT JOIN LATERAL (
    SELECT a."userId", a."createdAt"
    FROM "AuditLog" AS a
    WHERE a."entityType" = 'Withdrawal'
      AND a."entityId" = w."id"
      AND a."action" = 'WITHDRAWAL_APPROVED'
      AND a."userId" IS NOT NULL
    ORDER BY a."createdAt" ASC, a."id" ASC
    LIMIT 1
  ) AS approval ON TRUE
  WHERE w."status" = 'REVERSED'
)
UPDATE "Withdrawal" AS w
SET
  "reversedBy" = source.reversal_actor,
  "reversedAt" = source.reversed_at,
  "approvedBy" = source.approval_actor,
  "approvedAt" = source.approved_at
FROM reversal_source AS source
WHERE w."id" = source."id";

-- Preserve what is actually known. Existing route/stage/JSON metadata cannot
-- prove which terminal evidence was used, so every historical completion is
-- explicitly legacy-unverified even when a provider reference is available.
WITH legacy_completion AS (
  SELECT
    pe."id",
    COALESCE(
      pe."providerPayoutId",
      pe."providerExecutionId",
      pe."bankTraceReference"
    ) AS "evidenceRef",
    COALESCE(
      (
        SELECT a."createdAt"
        FROM "AuditLog" AS a
        WHERE (
          (
            a."entityType" = 'PayoutExecution'
            AND a."entityId" = pe."id"
          )
          OR (
            a."entityType" = 'Withdrawal'
            AND a."entityId" = pe."withdrawalId"
          )
        )
        AND a."action" IN (
          'PAYOUT_EXECUTION_COMPLETED',
          'PAYOUT_EXECUTION_RECOVERED_COMPLETED',
          'PAYOUT_WEBHOOK_COMPLETED',
          'PAYOUT_STATUS_POLL_COMPLETED',
          'WITHDRAWAL_COMPLETED',
          'WITHDRAWAL_MANUAL_COMPLETED'
        )
        ORDER BY a."createdAt" ASC, a."id" ASC
        LIMIT 1
      ),
      pe."updatedAt"
    ) AS "localCompletedAt"
  FROM "PayoutExecution" AS pe
  WHERE pe."status" = 'COMPLETED'
)
UPDATE "PayoutExecution" AS pe
SET
  "completionSource" = 'LEGACY_UNVERIFIED',
  "completionEvidenceRef" = legacy."evidenceRef",
  "completedAt" = legacy."localCompletedAt"
FROM legacy_completion AS legacy
WHERE pe."id" = legacy."id";

-- Historical cancellations predate typed provider reversal evidence. Preserve
-- them honestly for reconciliation, but never let a runtime writer create a
-- new LEGACY_UNVERIFIED cancellation after this migration.
UPDATE "PayoutExecution"
SET
  "cancellationSource" = 'LEGACY_UNVERIFIED',
  "cancelledAt" = "updatedAt"
WHERE "status" = 'CANCELLED';

CREATE UNIQUE INDEX "PayoutExecution_one_money_movement_per_withdrawal_key"
  ON "PayoutExecution"("withdrawalId")
  WHERE "status" IN ('PENDING', 'PROCESSING', 'COMPLETED');
CREATE UNIQUE INDEX "PayoutExecution_providerId_bankTraceReference_key"
  ON "PayoutExecution"("providerId", "bankTraceReference");
CREATE UNIQUE INDEX "PayoutExecution_providerId_completionEvidenceRef_key"
  ON "PayoutExecution"("providerId", "completionEvidenceRef");
CREATE UNIQUE INDEX "PayoutExecution_providerId_cancellationEvidenceRef_key"
  ON "PayoutExecution"("providerId", "cancellationEvidenceRef");
CREATE UNIQUE INDEX "PayoutExecution_completionWebhookEventId_key"
  ON "PayoutExecution"("completionWebhookEventId");

CREATE INDEX "Withdrawal_requestedBy_idx" ON "Withdrawal"("requestedBy");
CREATE INDEX "Withdrawal_rejectedBy_idx" ON "Withdrawal"("rejectedBy");
CREATE INDEX "Withdrawal_reversedBy_idx" ON "Withdrawal"("reversedBy");
CREATE INDEX "PayoutExecution_completionActorUserId_idx"
  ON "PayoutExecution"("completionActorUserId");
CREATE INDEX "PayoutExecution_initiatedByUserId_idx"
  ON "PayoutExecution"("initiatedByUserId");
CREATE INDEX "PayoutExecution_cancellationActorUserId_idx"
  ON "PayoutExecution"("cancellationActorUserId");

ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_requestedBy_fkey"
  FOREIGN KEY ("requestedBy") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal"
  DROP CONSTRAINT "Withdrawal_approvedBy_fkey";
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_approvedBy_fkey"
  FOREIGN KEY ("approvedBy") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_rejectedBy_fkey"
  FOREIGN KEY ("rejectedBy") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_reversedBy_fkey"
  FOREIGN KEY ("reversedBy") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_initiatedByUserId_fkey"
  FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_completionActorUserId_fkey"
  FOREIGN KEY ("completionActorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_completionWebhookEventId_fkey"
  FOREIGN KEY ("completionWebhookEventId") REFERENCES "PayoutWebhookEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_cancellationActorUserId_fkey"
  FOREIGN KEY ("cancellationActorUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Source-specific consistency is enforced immediately. This intentionally
-- rejects any old writer that attempts a completion after the migration.
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_completion_evidence_check" CHECK (
    (
      "status" <> 'COMPLETED'
      AND "completionSource" IS NULL
      AND "completionEvidenceRef" IS NULL
      AND "completionEvidenceAt" IS NULL
      AND "completedAt" IS NULL
      AND "completionActorUserId" IS NULL
      AND "completionWebhookEventId" IS NULL
    )
    OR
    (
      "status" = 'COMPLETED'
      AND "completionSource" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND (
        "completionSource" = 'LEGACY_UNVERIFIED'
        OR (
          "completionEvidenceRef" IS NOT NULL
          AND LENGTH(BTRIM("completionEvidenceRef")) > 0
          AND "completionEvidenceAt" IS NOT NULL
          AND "completionEvidenceAt" <= "completedAt"
        )
      )
      AND (
        (
          "completionSource" = 'MANUAL_BANK_CONFIRMATION'
          AND "completionWebhookEventId" IS NULL
          AND
          "completionActorUserId" IS NOT NULL
          AND "bankTraceReference" IS NOT NULL
          AND "bankTraceReference" = "completionEvidenceRef"
        )
        OR (
          "completionSource" = 'PROVIDER_WEBHOOK'
          AND "completionWebhookEventId" IS NOT NULL
          AND "completionActorUserId" IS NULL
        )
        OR (
          "completionSource" IN ('PROVIDER_RESPONSE', 'PROVIDER_STATUS_POLL')
          AND "completionWebhookEventId" IS NULL
          AND "completionActorUserId" IS NULL
        )
        OR (
          "completionSource" = 'LEGACY_UNVERIFIED'
          AND "completionWebhookEventId" IS NULL
          AND "completionActorUserId" IS NULL
        )
      )
    )
  );

-- Cancellation is a liability-releasing decision too. Runtime cancellations
-- are either provably before every provider send, or carry typed Stripe
-- transfer-reversal evidence. Legacy rows are retained but quarantined from
-- all new runtime transitions.
ALTER TABLE "PayoutExecution"
  ADD CONSTRAINT "PayoutExecution_cancellation_evidence_check" CHECK (
    (
      "status" <> 'CANCELLED'
      AND "cancellationSource" IS NULL
      AND "cancellationEvidenceRef" IS NULL
      AND "cancellationEvidenceAt" IS NULL
      AND "cancellationPayoutStatus" IS NULL
      AND "cancelledAt" IS NULL
      AND "cancellationActorUserId" IS NULL
    )
    OR
    (
      "status" = 'CANCELLED'
      AND "cancellationSource" IS NOT NULL
      AND "cancelledAt" IS NOT NULL
      AND (
        (
          "cancellationSource" = 'PRE_PROVIDER_ABORT'
          AND "stage" = 'PRE_PROVIDER_ABORTED'
          AND "providerExecutionId" IS NULL
          AND "providerTransferId" IS NULL
          AND "providerPayoutId" IS NULL
          AND "cancellationEvidenceRef" IS NULL
          AND "cancellationEvidenceAt" IS NULL
          AND "cancellationPayoutStatus" IS NULL
          AND "cancellationActorUserId" IS NOT NULL
        )
        OR (
          "cancellationSource" = 'PROVIDER_RESPONSE'
          AND "stage" = 'CANCELLED_REVERSED'
          AND "providerExecutionId" IS NOT NULL
          AND "providerTransferId" IS NOT NULL
          AND "cancellationEvidenceRef" IS NOT NULL
          AND LENGTH(BTRIM("cancellationEvidenceRef")) > 0
          AND "cancellationEvidenceAt" IS NOT NULL
          AND "cancellationEvidenceAt" <= "cancelledAt"
          AND "cancellationActorUserId" IS NOT NULL
          AND (
            (
              "providerPayoutId" IS NULL
              AND "cancellationPayoutStatus" IS NULL
            )
            OR (
              "providerPayoutId" IS NOT NULL
              AND LOWER("cancellationPayoutStatus") IN ('canceled', 'failed')
            )
          )
        )
        OR (
          "cancellationSource" = 'LEGACY_UNVERIFIED'
          AND "cancellationEvidenceRef" IS NULL
          AND "cancellationEvidenceAt" IS NULL
          AND "cancellationPayoutStatus" IS NULL
          AND "cancellationActorUserId" IS NULL
        )
      )
    )
  );

ALTER TABLE "PayoutWebhookEvent"
  ADD CONSTRAINT "PayoutWebhookEvent_payout_amount_currency_check" CHECK (
    (
      "payoutAmountMinor" IS NULL
      AND "payoutCurrency" IS NULL
    )
    OR (
      "payoutAmountMinor" IS NOT NULL
      AND "payoutCurrency" IS NOT NULL
      AND "payoutAmountMinor" > 0
      AND "payoutCurrency" = UPPER("payoutCurrency")
      AND LENGTH("payoutCurrency") = 3
    )
  );

-- An external-call claim is safe to replay only when its command identity,
-- routing snapshots, and first provider references cannot be rewritten by a
-- stale or compromised application writer. Provider references may be
-- appended once after an HTTP response, but never replaced or cleared.
-- Claims are the sole database authority for provider sends. They are
-- append-only, bind one exact key to one execution/call family, and permit
-- only a monotonic lease timestamp update for exact-key recovery.
CREATE FUNCTION "guard_payout_execution_claim"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  execution_status TEXT;
  execution_stage TEXT;
  execution_key TEXT;
  execution_withdrawal_id TEXT;
  execution_provider_name TEXT;
  withdrawal_status TEXT;
  expected_key TEXT;
  key_version TEXT;
  actor_user_type TEXT;
  actor_banned BOOLEAN;
  actor_staff_role TEXT;
  withdrawal_approved_by TEXT;
  approver_user_type TEXT;
  approver_banned BOOLEAN;
  approver_staff_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payout execution claims are financial authority and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."executionId" IS DISTINCT FROM OLD."executionId"
      OR NEW."kind" IS DISTINCT FROM OLD."kind"
      OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
      OR NEW."idempotencyKeyFingerprint"
        IS DISTINCT FROM OLD."idempotencyKeyFingerprint"
      OR NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt"
      OR NEW."claimedByUserId" IS DISTINCT FROM OLD."claimedByUserId"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION
        'Payout execution claim identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."lastClaimedAt" <= OLD."lastClaimedAt"
      OR NEW."lastClaimedAt" < NEW."claimedAt"
      OR NEW."lastClaimedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION
        'Payout execution claim replay timestamp must advance monotonically'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT execution."withdrawalId", provider."name"
  INTO execution_withdrawal_id, execution_provider_name
  FROM "PayoutExecution" AS execution
  JOIN "PayoutProvider" AS provider
    ON provider."id" = execution."providerId"
  WHERE execution."id" = NEW."executionId";

  SELECT "status"::TEXT
  INTO withdrawal_status
  FROM "Withdrawal"
  WHERE "id" = execution_withdrawal_id
  FOR UPDATE;

  SELECT
    "status"::TEXT,
    "stage",
    "idempotencyKey"
  INTO
    execution_status,
    execution_stage,
    execution_key
  FROM "PayoutExecution"
  WHERE "id" = NEW."executionId"
    AND "withdrawalId" = execution_withdrawal_id
  FOR UPDATE;

  IF NOT FOUND
    OR execution_status IS DISTINCT FROM 'PROCESSING'
    OR withdrawal_status IS DISTINCT FROM 'PROCESSING' THEN
    RAISE EXCEPTION
      'Payout execution claims require one locked processing execution'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT'
    AND execution_provider_name NOT IN ('manual', 'stripe_connect') THEN
    RAISE EXCEPTION
      'New payout execution claims require a certified provider'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'PROVIDER_SEND' THEN
    expected_key := execution_key;
    IF TG_OP = 'INSERT'
      AND execution_stage IS DISTINCT FROM 'DESTINATION_VALIDATED' THEN
      RAISE EXCEPTION
        'Provider-send claim requires a destination-validated execution'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'BANK_PAYOUT_SEND' THEN
    IF TG_OP = 'INSERT'
      AND execution_provider_name IS DISTINCT FROM 'stripe_connect' THEN
      RAISE EXCEPTION
        'Bank-payout claims require the certified Stripe provider'
        USING ERRCODE = '23514';
    END IF;
    key_version := SUBSTRING(execution_key FROM '-v([0-9]+)$');
    expected_key :=
      'payout-bank-' || execution_withdrawal_id || '-v' || key_version;
    IF key_version IS NULL
      OR (
        TG_OP = 'INSERT'
        AND execution_stage NOT IN (
          'TRANSFER_CREATED',
          'TRANSFER_RECOVERY_REQUIRED'
        )
      ) THEN
      RAISE EXCEPTION
        'Bank-payout claim requires a persisted Transfer and canonical key'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION
      'Unsupported payout execution claim kind'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."idempotencyKey" IS DISTINCT FROM expected_key
    OR COALESCE(
      NEW."idempotencyKeyFingerprint",
      ''
    ) !~ '^[0-9a-f]{64}$'
    OR NEW."claimedAt" > NEW."lastClaimedAt"
    OR NEW."claimedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes'
    OR NEW."lastClaimedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION
      'Payout execution claim does not match its immutable idempotency identity'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT
      actor."userType"::TEXT,
      actor."banned",
      staff."role"::TEXT
    INTO
      actor_user_type,
      actor_banned,
      actor_staff_role
    FROM "User" AS actor
    JOIN "StaffMembership" AS staff
      ON staff."userId" = actor."id"
    WHERE actor."id" = NEW."claimedByUserId"
    FOR SHARE OF actor, staff;

    IF NOT FOUND
      OR actor_user_type IS DISTINCT FROM 'STAFF'
      OR actor_banned IS DISTINCT FROM FALSE
      OR actor_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION
        'Payout execution claim actor must be a current unbanned Finance or Super Admin staff member'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."kind" = 'PROVIDER_SEND' THEN
      SELECT "approvedBy"
      INTO withdrawal_approved_by
      FROM "Withdrawal"
      WHERE "id" = execution_withdrawal_id;

      SELECT
        approver."userType"::TEXT,
        approver."banned",
        staff."role"::TEXT
      INTO
        approver_user_type,
        approver_banned,
        approver_staff_role
      FROM "User" AS approver
      JOIN "StaffMembership" AS staff
        ON staff."userId" = approver."id"
      WHERE approver."id" = withdrawal_approved_by
      FOR SHARE OF approver, staff;

      IF NOT FOUND
        OR approver_user_type IS DISTINCT FROM 'STAFF'
        OR approver_banned IS DISTINCT FROM FALSE
        OR approver_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN')
        OR withdrawal_approved_by = NEW."claimedByUserId" THEN
        RAISE EXCEPTION
          'Provider-send claim requires a current eligible approver distinct from its actor'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutExecutionClaim_authority_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PayoutExecutionClaim"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_execution_claim"();

CREATE FUNCTION "guard_payout_execution_claim_stage_commit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_stage TEXT;
  current_status TEXT;
BEGIN
  SELECT "stage", "status"::TEXT
  INTO current_stage, current_status
  FROM "PayoutExecution"
  WHERE "id" = NEW."executionId";

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NEW."kind" = 'PROVIDER_SEND'
    AND current_stage IN (
      'CREATED',
      'DESTINATION_VALIDATED',
      'PRE_PROVIDER_ABORTED'
    ) THEN
    RAISE EXCEPTION
      'Provider-send claim and execution stage must commit atomically'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."kind" = 'BANK_PAYOUT_SEND'
    AND current_stage IN (
      'CREATED',
      'DESTINATION_VALIDATED',
      'PROVIDER_SEND_CLAIMED',
      'PROVIDER_SEND_CLAIM_EXPIRED',
      'TRANSFER_CREATED',
      'TRANSFER_RECOVERY_REQUIRED',
      'PRE_PROVIDER_ABORTED'
    ) THEN
    RAISE EXCEPTION
      'Bank-payout claim and execution stage must commit atomically'
      USING ERRCODE = '23514';
  END IF;

  IF current_status = 'CANCELLED'
    AND current_stage = 'PRE_PROVIDER_ABORTED' THEN
    RAISE EXCEPTION
      'Pre-provider-aborted executions cannot retain an external-call claim'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PayoutExecutionClaim_stage_commit_guard"
AFTER INSERT OR UPDATE ON "PayoutExecutionClaim"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_execution_claim_stage_commit"();

CREATE FUNCTION "guard_payout_execution_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_destination_snapshot JSONB;
  new_destination_snapshot JSONB;
  old_provider_snapshot JSONB;
  new_provider_snapshot JSONB;
  cancellation_evidence JSONB;
  provider_name TEXT;
  provider_is_active BOOLEAN;
  provider_version INTEGER;
  provider_config_encryption_key_version INTEGER;
  withdrawal_status TEXT;
  withdrawal_amount NUMERIC;
  withdrawal_net_amount NUMERIC;
  withdrawal_currency TEXT;
  withdrawal_reference TEXT;
  withdrawal_payout_method_id TEXT;
  withdrawal_publisher_id TEXT;
  withdrawal_approved_by TEXT;
  withdrawal_method TEXT;
  payout_method_publisher_id TEXT;
  payout_method_type TEXT;
  payout_method_is_active BOOLEAN;
  payout_method_version INTEGER;
  payout_method_encryption_key_version INTEGER;
  destination_provider_account_id TEXT;
  observed_provider_account_id TEXT;
  provider_account_publisher_id TEXT;
  provider_account_provider TEXT;
  provider_account_external_id TEXT;
  provider_account_status TEXT;
  provider_account_is_active BOOLEAN;
  provider_account_transfers_enabled BOOLEAN;
  provider_account_payouts_enabled BOOLEAN;
  provider_account_details_submitted BOOLEAN;
  provider_account_schedule_configured BOOLEAN;
  provider_account_default_currency TEXT;
  initiator_user_type TEXT;
  initiator_banned BOOLEAN;
  initiator_staff_role TEXT;
  approver_user_type TEXT;
  approver_banned BOOLEAN;
  approver_staff_role TEXT;
  cancellation_actor_user_type TEXT;
  cancellation_actor_banned BOOLEAN;
  cancellation_actor_staff_role TEXT;
  provider_claim_count INTEGER;
  bank_claim_count INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_destination_snapshot :=
      NEW."providerMetadata" -> 'destinationSnapshot';
    new_provider_snapshot := NEW."providerMetadata" -> 'providerSnapshot';

    IF NEW."status" <> 'PROCESSING'
      OR NEW."stage" <> 'CREATED'
      OR NEW."version" <> 0
      OR NEW."providerExecutionId" IS NOT NULL
      OR NEW."providerTransferId" IS NOT NULL
      OR NEW."providerPayoutId" IS NOT NULL
      OR NEW."acceptedReference" IS NOT NULL
      OR NEW."bankTraceReference" IS NOT NULL
      OR NEW."initiatedByUserId" IS NULL
      OR NEW."idempotencyKey" IS NULL
      OR LENGTH(BTRIM(NEW."idempotencyKey")) = 0
      OR NEW."requestedReference" IS NULL
      OR LENGTH(BTRIM(NEW."requestedReference")) = 0
      OR NEW."amount" <= 0
      OR NEW."destinationAmount" IS NULL
      OR NEW."destinationAmount" <= 0
      OR NEW."sourceCurrency" <> UPPER(NEW."sourceCurrency")
      OR LENGTH(NEW."sourceCurrency") <> 3
      OR NEW."destinationCurrency" <> NEW."sourceCurrency"
      OR (
        JSONB_TYPEOF(NEW."providerMetadata") = 'object'
        AND NEW."providerMetadata" ? 'externalClaims'
      )
      OR JSONB_TYPEOF(new_destination_snapshot) IS DISTINCT FROM 'object'
      OR NOT COALESCE((
        new_destination_snapshot ?& ARRAY[
          'payoutMethodId',
          'payoutMethodVersion',
          'encryptionKeyVersion',
          'encryptedDetailsFingerprint',
          'providerAccountRowId',
          'providerAccountExternalId',
          'providerAccountProvider',
          'providerAccountFingerprint',
          'destinationCurrency',
          'recipientFingerprint'
        ]
      ), FALSE)
      OR new_destination_snapshot ->> 'destinationCurrency'
        IS DISTINCT FROM NEW."destinationCurrency"
      OR new_destination_snapshot -> 'recipientFingerprint'
        IS DISTINCT FROM 'null'::JSONB
      OR JSONB_TYPEOF(new_provider_snapshot) IS DISTINCT FROM 'object'
      OR NOT COALESCE((
        new_provider_snapshot ?& ARRAY[
          'providerId',
          'providerName',
          'providerVersion',
          'configEncryptionKeyVersion',
          'configFingerprint'
        ]
      ), FALSE)
      OR new_provider_snapshot ->> 'providerId'
        IS DISTINCT FROM NEW."providerId"
      OR COALESCE(
        LENGTH(BTRIM(new_provider_snapshot ->> 'providerName')),
        0
      ) = 0 THEN
      RAISE EXCEPTION
        'Payout executions must be inserted from a canonical immutable command snapshot'
        USING ERRCODE = '23514';
    END IF;

    -- Aggregate/provider lock first. PayoutMethod is deliberately only
    -- pre-read below so a managed route can lock ProviderAccount before
    -- locking and revalidating Method.
    SELECT
      provider."name",
      provider."isActive",
      provider."version",
      provider."configEncryptionKeyVersion",
      withdrawal."status"::TEXT,
      withdrawal."amount",
      withdrawal."netAmount",
      withdrawal."currency",
      withdrawal."publicReference",
      withdrawal."payoutMethodId",
      withdrawal."publisherId",
      withdrawal."approvedBy",
      withdrawal."method"
    INTO
      provider_name,
      provider_is_active,
      provider_version,
      provider_config_encryption_key_version,
      withdrawal_status,
      withdrawal_amount,
      withdrawal_net_amount,
      withdrawal_currency,
      withdrawal_reference,
      withdrawal_payout_method_id,
      withdrawal_publisher_id,
      withdrawal_approved_by,
      withdrawal_method
    FROM "Withdrawal" AS withdrawal
    JOIN "PayoutProvider" AS provider
      ON provider."id" = NEW."providerId"
    WHERE withdrawal."id" = NEW."withdrawalId"
    FOR SHARE OF provider, withdrawal;

    IF NOT FOUND
      OR withdrawal_status IS DISTINCT FROM 'PROCESSING'
      OR provider_is_active IS DISTINCT FROM TRUE
      OR withdrawal_payout_method_id IS NULL THEN
      RAISE EXCEPTION
        'Payout execution command does not match its locked withdrawal, method, or provider'
        USING ERRCODE = '23514';
    END IF;

    IF (
        provider_name = 'stripe_connect'
        AND NEW."livemode" IS NULL
      ) OR (
        provider_name <> 'stripe_connect'
        AND NEW."livemode" IS NOT NULL
      ) THEN
      RAISE EXCEPTION
        'Payout execution mode evidence does not match its provider route'
        USING ERRCODE = '23514';
    END IF;

    SELECT method."providerAccountId"
    INTO observed_provider_account_id
    FROM "PayoutMethod" AS method
    WHERE method."id" = withdrawal_payout_method_id
      AND method."publisherId" = withdrawal_publisher_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Payout execution has no matching payout method'
        USING ERRCODE = '23514';
    END IF;

    IF provider_name = 'stripe_connect' THEN
      IF withdrawal_method <> 'stripe_connect'
        OR observed_provider_account_id IS NULL THEN
        RAISE EXCEPTION
          'Stripe execution requires the canonical Stripe payout-method route'
          USING ERRCODE = '23514';
      END IF;
      SELECT
        account."publisherId",
        account."provider",
        account."providerAccountId",
        account."status"::TEXT,
        account."isActive",
        account."transfersEnabled",
        account."payoutsEnabled",
        account."detailsSubmitted",
        account."payoutScheduleConfigured",
        account."defaultCurrency"
      INTO
        provider_account_publisher_id,
        provider_account_provider,
        provider_account_external_id,
        provider_account_status,
        provider_account_is_active,
        provider_account_transfers_enabled,
        provider_account_payouts_enabled,
        provider_account_details_submitted,
        provider_account_schedule_configured,
        provider_account_default_currency
      FROM "PublisherProviderAccount" AS account
      WHERE account."id" = observed_provider_account_id
      FOR SHARE OF account;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Stripe execution has no locked provider account'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    SELECT
      method."publisherId",
      method."type",
      method."isActive",
      method."version",
      method."encryptionKeyVersion",
      method."providerAccountId"
    INTO
      payout_method_publisher_id,
      payout_method_type,
      payout_method_is_active,
      payout_method_version,
      payout_method_encryption_key_version,
      destination_provider_account_id
    FROM "PayoutMethod" AS method
    WHERE method."id" = withdrawal_payout_method_id
    FOR SHARE OF method;

    IF NOT FOUND
      OR destination_provider_account_id
        IS DISTINCT FROM observed_provider_account_id
      OR payout_method_is_active IS DISTINCT FROM TRUE
      OR payout_method_publisher_id IS DISTINCT FROM withdrawal_publisher_id
      OR NEW."amount" IS DISTINCT FROM withdrawal_amount
      OR NEW."destinationAmount" IS DISTINCT FROM COALESCE(
        withdrawal_net_amount,
        withdrawal_amount
      )
      OR NEW."sourceCurrency" IS DISTINCT FROM withdrawal_currency
      OR NEW."requestedReference" IS DISTINCT FROM withdrawal_reference
      OR new_destination_snapshot ->> 'payoutMethodId'
        IS DISTINCT FROM withdrawal_payout_method_id
      OR new_destination_snapshot ->> 'payoutMethodVersion'
        IS DISTINCT FROM payout_method_version::TEXT
      OR new_destination_snapshot ->> 'encryptionKeyVersion'
        IS DISTINCT FROM payout_method_encryption_key_version::TEXT
      OR new_destination_snapshot ->> 'destinationCurrency'
        IS DISTINCT FROM withdrawal_currency
      OR new_provider_snapshot ->> 'providerId'
        IS DISTINCT FROM NEW."providerId"
      OR new_provider_snapshot ->> 'providerName'
        IS DISTINCT FROM provider_name
      OR new_provider_snapshot ->> 'providerVersion'
        IS DISTINCT FROM provider_version::TEXT
      OR new_provider_snapshot ->> 'configEncryptionKeyVersion'
        IS DISTINCT FROM provider_config_encryption_key_version::TEXT
      OR COALESCE(
        new_destination_snapshot ->> 'encryptedDetailsFingerprint',
        ''
      ) !~ '^[0-9a-f]{64}$'
      OR COALESCE(
        new_provider_snapshot ->> 'configFingerprint',
        ''
      ) !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION
        'Payout execution command does not match its locked withdrawal, method, or provider'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      initiator."userType"::TEXT,
      initiator."banned",
      staff."role"::TEXT
    INTO
      initiator_user_type,
      initiator_banned,
      initiator_staff_role
    FROM "User" AS initiator
    JOIN "StaffMembership" AS staff
      ON staff."userId" = initiator."id"
    WHERE initiator."id" = NEW."initiatedByUserId"
    FOR SHARE OF initiator, staff;

    IF NOT FOUND
      OR initiator_user_type IS DISTINCT FROM 'STAFF'
      OR initiator_banned IS DISTINCT FROM FALSE
      OR initiator_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION
        'Payout execution initiator must be a current unbanned Finance or Super Admin staff member'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      approver."userType"::TEXT,
      approver."banned",
      staff."role"::TEXT
    INTO
      approver_user_type,
      approver_banned,
      approver_staff_role
    FROM "User" AS approver
    JOIN "StaffMembership" AS staff
      ON staff."userId" = approver."id"
    WHERE approver."id" = withdrawal_approved_by
    FOR SHARE OF approver, staff;

    IF NOT FOUND
      OR approver_user_type IS DISTINCT FROM 'STAFF'
      OR approver_banned IS DISTINCT FROM FALSE
      OR approver_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN')
      OR withdrawal_approved_by = NEW."initiatedByUserId" THEN
      RAISE EXCEPTION
        'Payout execution requires a current eligible approver distinct from its initiator'
        USING ERRCODE = '23514';
    END IF;

    IF provider_name = 'stripe_connect' THEN
      IF withdrawal_method <> 'stripe_connect'
        OR payout_method_type <> 'stripe_connect'
        OR destination_provider_account_id IS NULL THEN
        RAISE EXCEPTION
          'Stripe execution requires the canonical Stripe payout-method route'
          USING ERRCODE = '23514';
      END IF;

      IF provider_account_publisher_id
          IS DISTINCT FROM withdrawal_publisher_id
        OR provider_account_provider IS DISTINCT FROM 'stripe_connect'
        OR provider_account_status IS DISTINCT FROM 'ENABLED'
        OR provider_account_is_active IS DISTINCT FROM TRUE
        OR provider_account_transfers_enabled IS DISTINCT FROM TRUE
        OR provider_account_payouts_enabled IS DISTINCT FROM TRUE
        OR provider_account_details_submitted IS DISTINCT FROM TRUE
        OR provider_account_schedule_configured IS DISTINCT FROM TRUE
        OR UPPER(provider_account_default_currency)
          IS DISTINCT FROM withdrawal_currency
        OR new_destination_snapshot ->> 'providerAccountRowId'
          IS DISTINCT FROM destination_provider_account_id
        OR new_destination_snapshot ->> 'providerAccountExternalId'
          IS DISTINCT FROM provider_account_external_id
        OR new_destination_snapshot ->> 'providerAccountProvider'
          IS DISTINCT FROM provider_account_provider
        OR COALESCE(
          new_destination_snapshot ->> 'providerAccountFingerprint',
          ''
        ) !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION
          'Stripe execution destination does not match a fully enabled locked connected account'
          USING ERRCODE = '23514';
      END IF;
    ELSIF provider_name = 'manual' THEN
      IF withdrawal_method <> 'bank_transfer'
        OR payout_method_type <> 'bank_transfer'
        OR destination_provider_account_id IS NOT NULL
        OR new_destination_snapshot -> 'providerAccountRowId'
          IS DISTINCT FROM 'null'::JSONB
        OR new_destination_snapshot -> 'providerAccountExternalId'
          IS DISTINCT FROM 'null'::JSONB
        OR new_destination_snapshot -> 'providerAccountProvider'
          IS DISTINCT FROM 'null'::JSONB
        OR new_destination_snapshot ->> 'providerAccountFingerprint'
          IS DISTINCT FROM
            '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b' THEN
        RAISE EXCEPTION
          'Manual execution requires the canonical bank-transfer route without a provider account'
          USING ERRCODE = '23514';
      END IF;
    ELSIF provider_name = 'wise' THEN
      RAISE EXCEPTION
        'New Wise payout executions are not certified'
        USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION
        'Payout execution provider route is unsupported'
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "PayoutExecution" AS prior
      WHERE prior."withdrawalId" = NEW."withdrawalId"
        AND (
          prior."status" <> 'CANCELLED'
          OR prior."cancellationSource" IS NULL
          OR prior."cancellationSource" NOT IN (
            'PRE_PROVIDER_ABORT',
            'PROVIDER_RESPONSE'
          )
        )
    ) THEN
      RAISE EXCEPTION
        'A replacement payout execution requires typed cancellation of every prior execution'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW."withdrawalId" IS DISTINCT FROM OLD."withdrawalId"
    OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
    OR NEW."livemode" IS DISTINCT FROM OLD."livemode"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."sourceCurrency" IS DISTINCT FROM OLD."sourceCurrency"
    OR NEW."destinationCurrency" IS DISTINCT FROM OLD."destinationCurrency"
    OR NEW."destinationAmount" IS DISTINCT FROM OLD."destinationAmount"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."requestedReference" IS DISTINCT FROM OLD."requestedReference"
    OR NEW."initiatedByUserId" IS DISTINCT FROM OLD."initiatedByUserId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Payout execution command identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF JSONB_TYPEOF(NEW."providerMetadata") = 'object'
    AND NEW."providerMetadata" ? 'externalClaims' THEN
    RAISE EXCEPTION
      'Payout provider metadata cannot contain external-call authority'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION
      'Payout execution updates require an exact version increment'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      (OLD."status" = 'PROCESSING'
        AND NEW."status" IN ('FAILED', 'COMPLETED', 'CANCELLED'))
      OR (OLD."status" = 'FAILED' AND NEW."status" = 'COMPLETED')
    ) THEN
    RAISE EXCEPTION
      'Invalid payout execution status transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."stage" IS DISTINCT FROM OLD."stage"
    AND NOT (
      (OLD."stage" = 'CREATED'
        AND NEW."stage" IN (
          'DESTINATION_VALIDATED',
          'PRE_PROVIDER_ABORTED'
        ))
      OR (OLD."stage" = 'DESTINATION_VALIDATED'
        AND NEW."stage" IN (
          'PROVIDER_SEND_CLAIMED',
          'PRE_PROVIDER_ABORTED'
        ))
      OR (OLD."stage" = 'PROVIDER_SEND_CLAIMED'
        AND NEW."stage" IN (
          'PROVIDER_SEND_CLAIM_EXPIRED',
          'TRANSFER_CREATED',
          'TRANSFER_RECOVERY_REQUIRED',
          'PROVIDER_SENT',
          'PROVIDER_OUTCOME_UNKNOWN',
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
        ))
      OR (OLD."stage" = 'TRANSFER_CREATED'
        AND NEW."stage" IN (
          'BANK_PAYOUT_SEND_CLAIMED',
          'TRANSFER_RECOVERY_REQUIRED'
        ))
      OR (OLD."stage" = 'TRANSFER_RECOVERY_REQUIRED'
        AND NEW."stage" IN (
          'BANK_PAYOUT_RESUME_CLAIMED',
          'CANCEL_REQUESTED'
        ))
      OR (OLD."stage" IN (
          'BANK_PAYOUT_SEND_CLAIMED',
          'BANK_PAYOUT_RESUME_CLAIMED'
        )
        AND NEW."stage" IN (
          'BANK_PAYOUT_CLAIM_EXPIRED',
          'BANK_PAID',
          'BANK_PAYOUT_CREATED',
          'BANK_PAYOUT_RECOVERY_REQUIRED',
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
        ))
      OR (OLD."stage" IN (
          'BANK_PAYOUT_CREATED',
          'BANK_PAYOUT_PENDING',
          'BANK_PAYOUT_RECOVERY_REQUIRED'
        )
        AND NEW."stage" IN (
          'BANK_PAID',
          'CANCEL_REQUESTED',
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED',
          'BANK_PAYOUT_RECOVERY_REQUIRED'
        ))
      OR (OLD."stage" = 'BANK_PAID'
        AND NEW."stage" IN (
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED',
          'BANK_PAYOUT_RECOVERY_REQUIRED'
        ))
      OR (OLD."stage" IN (
          'PROVIDER_SENT',
          'PROVIDER_OUTCOME_UNKNOWN'
        )
        AND NEW."stage" IN (
          'MANUAL_CONFIRMED',
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED',
          'PROVIDER_FAILURE_REVIEW_REQUIRED'
        ))
      OR (OLD."stage" = 'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
        AND NEW."stage" IN (
          'BANK_PAID',
          'BANK_PAYOUT_RECOVERY_REQUIRED',
          'PROVIDER_FAILURE_REVIEW_REQUIRED'
        ))
      OR (OLD."stage" = 'CANCEL_REQUESTED'
        AND NEW."stage" IN ('BANK_PAID', 'CANCELLED_REVERSED'))
    ) THEN
    RAISE EXCEPTION
      'Invalid payout execution stage transition'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE claim."kind" = 'PROVIDER_SEND'),
    COUNT(*) FILTER (WHERE claim."kind" = 'BANK_PAYOUT_SEND')
  INTO provider_claim_count, bank_claim_count
  FROM "PayoutExecutionClaim" AS claim
  WHERE claim."executionId" = NEW."id";

  IF NEW."stage" = 'PROVIDER_SEND_CLAIMED'
    AND provider_claim_count <> 1 THEN
    RAISE EXCEPTION
      'Provider-send stage requires one durable external-call claim'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."stage" IN (
      'BANK_PAYOUT_SEND_CLAIMED',
      'BANK_PAYOUT_RESUME_CLAIMED'
    )
    AND bank_claim_count <> 1 THEN
    RAISE EXCEPTION
      'Bank-payout stage requires one durable external-call claim'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD."providerExecutionId" IS NOT NULL
    AND NEW."providerExecutionId" IS DISTINCT FROM OLD."providerExecutionId"
  ) OR (
    OLD."providerTransferId" IS NOT NULL
    AND NEW."providerTransferId" IS DISTINCT FROM OLD."providerTransferId"
  ) OR (
    OLD."providerPayoutId" IS NOT NULL
    AND NEW."providerPayoutId" IS DISTINCT FROM OLD."providerPayoutId"
  ) OR (
    OLD."acceptedReference" IS NOT NULL
    AND NEW."acceptedReference" IS DISTINCT FROM OLD."acceptedReference"
  ) OR (
    OLD."bankTraceReference" IS NOT NULL
    AND NEW."bankTraceReference" IS DISTINCT FROM OLD."bankTraceReference"
  ) THEN
    RAISE EXCEPTION
      'Payout provider references are append-once'
      USING ERRCODE = '23514';
  END IF;

  old_destination_snapshot :=
    OLD."providerMetadata" -> 'destinationSnapshot';
  new_destination_snapshot :=
    NEW."providerMetadata" -> 'destinationSnapshot';
  old_provider_snapshot := OLD."providerMetadata" -> 'providerSnapshot';
  new_provider_snapshot := NEW."providerMetadata" -> 'providerSnapshot';

  IF new_provider_snapshot IS DISTINCT FROM old_provider_snapshot THEN
    RAISE EXCEPTION
      'Payout provider routing snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF new_destination_snapshot IS DISTINCT FROM old_destination_snapshot
    AND NOT (
      OLD."stage" = 'CREATED'
      AND NEW."stage" = 'DESTINATION_VALIDATED'
      AND JSONB_TYPEOF(old_destination_snapshot) = 'object'
      AND JSONB_TYPEOF(new_destination_snapshot) = 'object'
      AND (
        old_destination_snapshot - 'recipientFingerprint'
      ) = (
        new_destination_snapshot - 'recipientFingerprint'
      )
      AND (
        NOT (old_destination_snapshot ? 'recipientFingerprint')
        OR old_destination_snapshot -> 'recipientFingerprint' = 'null'::JSONB
      )
      AND JSONB_TYPEOF(
        new_destination_snapshot -> 'recipientFingerprint'
      ) = 'string'
      AND LENGTH(BTRIM(
        new_destination_snapshot ->> 'recipientFingerprint'
      )) > 0
    ) THEN
    RAISE EXCEPTION
      'Payout destination routing snapshot is immutable after validation'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD."providerExecutionId" IS NULL
      AND NEW."providerExecutionId" IS NOT NULL
  ) OR (
    OLD."providerTransferId" IS NULL
      AND NEW."providerTransferId" IS NOT NULL
  ) OR (
    OLD."providerPayoutId" IS NULL
      AND NEW."providerPayoutId" IS NOT NULL
  ) OR (
    OLD."stage" <> 'CANCEL_REQUESTED'
      AND NEW."stage" = 'CANCEL_REQUESTED'
  ) THEN
    SELECT
      provider."name",
      withdrawal."method",
      payout_method."type"
    INTO provider_name, withdrawal_method, payout_method_type
    FROM "PayoutProvider" AS provider
    JOIN "Withdrawal" AS withdrawal
      ON withdrawal."id" = NEW."withdrawalId"
    JOIN "PayoutMethod" AS payout_method
      ON payout_method."id" = withdrawal."payoutMethodId"
    WHERE provider."id" = NEW."providerId"
    FOR SHARE OF provider, withdrawal, payout_method;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Provider evidence attachment requires an active locked payout route'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Provider object references may be appended only as the response to the
  -- exact durable external-call claim that owned the idempotency key.
  IF OLD."providerExecutionId" IS NULL
    AND NEW."providerExecutionId" IS NOT NULL THEN
    IF provider_name = 'stripe_connect' THEN
      destination_provider_account_id :=
        new_destination_snapshot ->> 'providerAccountExternalId';
      IF withdrawal_method <> 'stripe_connect'
        OR payout_method_type <> 'stripe_connect'
        OR old_provider_snapshot ->> 'providerName'
          IS DISTINCT FROM 'stripe_connect'
        OR OLD."stage" <> 'PROVIDER_SEND_CLAIMED'
        OR NEW."stage" NOT IN (
          'TRANSFER_CREATED',
          'TRANSFER_RECOVERY_REQUIRED'
        )
        OR LEFT(NEW."providerExecutionId", 3) <> 'tr_'
        OR NEW."providerTransferId"
          IS DISTINCT FROM NEW."providerExecutionId"
        OR NEW."providerPayoutId" IS NOT NULL
        OR provider_claim_count <> 1
        OR NEW."destinationCurrency" <> 'USD'
        OR NEW."destinationAmount" * 100
          IS DISTINCT FROM TRUNC(NEW."destinationAmount" * 100)
        OR NEW."providerMetadata"
          #>> '{providerEvidence,providerAmountMinor}'
          IS DISTINCT FROM (
            (NEW."destinationAmount" * 100)::BIGINT
          )::TEXT
        OR NEW."providerMetadata"
          #>> '{providerEvidence,providerCurrency}'
          IS DISTINCT FROM NEW."destinationCurrency"
        OR NEW."providerMetadata"
          #>> '{providerEvidence,connectedAccountId}'
          IS DISTINCT FROM destination_provider_account_id
        OR NEW."providerMetadata"
          #>> '{providerEvidence,providerPublicReference}'
          IS DISTINCT FROM NEW."requestedReference"
        OR NEW."providerMetadata"
          #>> '{providerEvidence,livemode}'
          IS DISTINCT FROM NEW."livemode"::TEXT THEN
        RAISE EXCEPTION
          'Stripe Transfer evidence must follow its claimed immutable command'
          USING ERRCODE = '23514';
      END IF;
    ELSIF provider_name IN ('manual', 'wise') THEN
      IF (
          provider_name = 'manual'
          AND (
            withdrawal_method <> 'bank_transfer'
            OR payout_method_type <> 'bank_transfer'
          )
        ) OR (
          provider_name = 'wise'
          AND (
            withdrawal_method <> 'wise'
            OR payout_method_type <> 'wise'
          )
        )
        OR old_provider_snapshot ->> 'providerName'
          IS DISTINCT FROM provider_name
        OR OLD."stage" <> 'PROVIDER_SEND_CLAIMED'
        OR NEW."stage" NOT IN (
          'PROVIDER_SENT',
          'PROVIDER_OUTCOME_UNKNOWN',
          'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
        )
        OR NEW."providerTransferId" IS NOT NULL
        OR NEW."providerPayoutId" IS NOT NULL
        OR provider_claim_count <> 1 THEN
        RAISE EXCEPTION
          'Provider transfer evidence must follow its claimed immutable command'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Provider execution evidence uses an unsupported payout route'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."providerTransferId" IS NULL
    AND NEW."providerTransferId" IS NOT NULL
    AND NOT (
      provider_name = 'stripe_connect'
      AND OLD."providerExecutionId" IS NULL
      AND NEW."providerTransferId" = NEW."providerExecutionId"
      AND LEFT(NEW."providerTransferId", 3) = 'tr_'
      AND OLD."stage" = 'PROVIDER_SEND_CLAIMED'
      AND NEW."stage" IN (
        'TRANSFER_CREATED',
        'TRANSFER_RECOVERY_REQUIRED'
      )
    ) THEN
    RAISE EXCEPTION
      'Stripe Transfer identity must be attached atomically with its claimed response'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."providerPayoutId" IS NULL
    AND NEW."providerPayoutId" IS NOT NULL THEN
    destination_provider_account_id :=
      new_destination_snapshot ->> 'providerAccountExternalId';
    IF provider_name <> 'stripe_connect'
      OR withdrawal_method <> 'stripe_connect'
      OR payout_method_type <> 'stripe_connect'
      OR old_provider_snapshot ->> 'providerName'
        IS DISTINCT FROM 'stripe_connect'
      OR OLD."providerExecutionId" IS NULL
      OR OLD."providerTransferId"
        IS DISTINCT FROM OLD."providerExecutionId"
      OR LEFT(OLD."providerTransferId", 3) <> 'tr_'
      OR LEFT(NEW."providerPayoutId", 3) <> 'po_'
      OR OLD."stage" NOT IN (
        'BANK_PAYOUT_SEND_CLAIMED',
        'BANK_PAYOUT_RESUME_CLAIMED'
      )
      OR NEW."stage" NOT IN (
        'BANK_PAID',
        'BANK_PAYOUT_CREATED',
        'BANK_PAYOUT_RECOVERY_REQUIRED'
      )
      OR bank_claim_count <> 1
      OR NEW."destinationCurrency" <> 'USD'
      OR NEW."destinationAmount" * 100
        IS DISTINCT FROM TRUNC(NEW."destinationAmount" * 100)
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerAmountMinor}'
        IS DISTINCT FROM (
          (NEW."destinationAmount" * 100)::BIGINT
        )::TEXT
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerCurrency}'
        IS DISTINCT FROM NEW."destinationCurrency"
      OR NEW."providerMetadata"
        #>> '{providerEvidence,connectedAccountId}'
        IS DISTINCT FROM destination_provider_account_id
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerPublicReference}'
        IS DISTINCT FROM NEW."requestedReference"
      OR NEW."providerMetadata"
        #>> '{providerEvidence,livemode}'
        IS DISTINCT FROM NEW."livemode"::TEXT THEN
      RAISE EXCEPTION
        'Stripe Payout evidence must follow its claimed Transfer and bank command'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."acceptedReference" IS NULL
    AND NEW."acceptedReference" IS NOT NULL
    AND NOT (
      (OLD."providerPayoutId" IS NULL
        AND NEW."providerPayoutId" IS NOT NULL)
      OR (
        NEW."status" = 'COMPLETED'
        AND NEW."completionSource" = 'MANUAL_BANK_CONFIRMATION'
        AND NEW."acceptedReference" = NEW."completionEvidenceRef"
      )
    ) THEN
    RAISE EXCEPTION
      'Accepted payout references require typed provider or manual evidence'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."bankTraceReference" IS NULL
    AND NEW."bankTraceReference" IS NOT NULL
    AND NOT (
      NEW."status" = 'COMPLETED'
      AND NEW."completionSource" = 'MANUAL_BANK_CONFIRMATION'
      AND NEW."bankTraceReference" = NEW."completionEvidenceRef"
    ) THEN
    RAISE EXCEPTION
      'Bank trace references require manual completion evidence'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."stage" <> 'CANCEL_REQUESTED'
    AND NEW."stage" = 'CANCEL_REQUESTED' THEN
    destination_provider_account_id :=
      new_destination_snapshot ->> 'providerAccountExternalId';
    IF provider_name <> 'stripe_connect'
      OR withdrawal_method <> 'stripe_connect'
      OR payout_method_type <> 'stripe_connect'
      OR NEW."status" NOT IN ('PENDING', 'PROCESSING')
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR OLD."stage" NOT IN (
        'TRANSFER_RECOVERY_REQUIRED',
        'BANK_PAYOUT_CREATED',
        'BANK_PAYOUT_PENDING',
        'BANK_PAYOUT_RECOVERY_REQUIRED'
      )
      OR NEW."providerExecutionId" IS NULL
      OR NEW."providerTransferId"
        IS DISTINCT FROM NEW."providerExecutionId"
      OR LEFT(NEW."providerTransferId", 3) <> 'tr_'
      OR (
        NEW."providerPayoutId" IS NOT NULL
        AND LEFT(NEW."providerPayoutId", 3) <> 'po_'
      )
      OR COALESCE(LENGTH(BTRIM(destination_provider_account_id)), 0) = 0
      OR provider_claim_count <> 1
      OR (
        NEW."providerPayoutId" IS NOT NULL
        AND bank_claim_count <> 1
      )
      OR NEW."destinationCurrency" <> 'USD'
      OR NEW."destinationAmount" * 100
        IS DISTINCT FROM TRUNC(NEW."destinationAmount" * 100)
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerAmountMinor}'
        IS DISTINCT FROM (
          (NEW."destinationAmount" * 100)::BIGINT
        )::TEXT
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerCurrency}'
        IS DISTINCT FROM NEW."destinationCurrency"
      OR NEW."providerMetadata"
        #>> '{providerEvidence,connectedAccountId}'
        IS DISTINCT FROM destination_provider_account_id
      OR NEW."providerMetadata"
        #>> '{providerEvidence,providerPublicReference}'
        IS DISTINCT FROM NEW."requestedReference"
      OR NEW."providerMetadata"
        #>> '{providerEvidence,livemode}'
        IS DISTINCT FROM NEW."livemode"::TEXT THEN
      RAISE EXCEPTION
        'Stripe cancellation requires a stage-bound authenticated object chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."status" <> 'CANCELLED' AND NEW."status" = 'CANCELLED' THEN
    SELECT
      actor."userType"::TEXT,
      actor."banned",
      staff."role"::TEXT
    INTO
      cancellation_actor_user_type,
      cancellation_actor_banned,
      cancellation_actor_staff_role
    FROM "User" AS actor
    JOIN "StaffMembership" AS staff
      ON staff."userId" = actor."id"
    WHERE actor."id" = NEW."cancellationActorUserId"
    FOR SHARE OF actor, staff;

    IF NOT FOUND
      OR cancellation_actor_user_type IS DISTINCT FROM 'STAFF'
      OR cancellation_actor_banned IS DISTINCT FROM FALSE
      OR cancellation_actor_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN') THEN
      RAISE EXCEPTION
        'Payout cancellation actor must be a current unbanned Finance or Super Admin staff member'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."cancellationEvidenceAt"
        < OLD."createdAt" - INTERVAL '5 minutes'
      OR NEW."cancellationEvidenceAt"
        > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
      OR NEW."cancelledAt"
        > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION
        'Payout cancellation timestamps fall outside the trusted command window'
        USING ERRCODE = '23514';
    END IF;

    IF NEW."cancellationSource" = 'LEGACY_UNVERIFIED' THEN
      RAISE EXCEPTION
        'LEGACY_UNVERIFIED cannot be used for a new payout cancellation'
        USING ERRCODE = '23514';
    ELSIF NEW."cancellationSource" = 'PRE_PROVIDER_ABORT' THEN
      IF OLD."stage" NOT IN ('CREATED', 'DESTINATION_VALIDATED')
        OR NEW."stage" <> 'PRE_PROVIDER_ABORTED'
        OR OLD."providerExecutionId" IS NOT NULL
        OR OLD."providerTransferId" IS NOT NULL
        OR OLD."providerPayoutId" IS NOT NULL
        OR provider_claim_count <> 0
        OR bank_claim_count <> 0 THEN
        RAISE EXCEPTION
          'Pre-provider payout abort requires proof that no provider call was claimed'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."cancellationSource" = 'PROVIDER_RESPONSE' THEN
      SELECT
        provider."name",
        withdrawal."method",
        payout_method."type"
      INTO provider_name, withdrawal_method, payout_method_type
      FROM "PayoutProvider" AS provider
      JOIN "Withdrawal" AS withdrawal
        ON withdrawal."id" = NEW."withdrawalId"
      JOIN "PayoutMethod" AS payout_method
        ON payout_method."id" = withdrawal."payoutMethodId"
      WHERE provider."id" = NEW."providerId"
      FOR SHARE OF provider, withdrawal, payout_method;

      cancellation_evidence :=
        NEW."providerMetadata" -> 'cancellation';
      destination_provider_account_id :=
        NEW."providerMetadata"
          #>> '{destinationSnapshot,providerAccountExternalId}';
      IF NOT FOUND
        OR OLD."stage" <> 'CANCEL_REQUESTED'
        OR NEW."stage" <> 'CANCELLED_REVERSED'
        OR provider_name <> 'stripe_connect'
        OR withdrawal_method <> 'stripe_connect'
        OR payout_method_type <> 'stripe_connect'
        OR NEW."providerExecutionId" IS NULL
        OR NEW."providerTransferId"
          IS DISTINCT FROM NEW."providerExecutionId"
        OR LEFT(NEW."providerTransferId", 3) <> 'tr_'
        OR (
          NEW."providerPayoutId" IS NOT NULL
          AND LEFT(NEW."providerPayoutId", 3) <> 'po_'
        )
        OR COALESCE(
          LENGTH(BTRIM(destination_provider_account_id)),
          0
        ) = 0
        OR JSONB_TYPEOF(cancellation_evidence) IS DISTINCT FROM 'object'
        OR cancellation_evidence ->> 'source'
          IS DISTINCT FROM 'PROVIDER_RESPONSE'
        OR cancellation_evidence ->> 'provider'
          IS DISTINCT FROM 'stripe_connect'
        OR cancellation_evidence ->> 'providerExecutionId'
          IS DISTINCT FROM NEW."providerExecutionId"
        OR cancellation_evidence ->> 'providerTransferId'
          IS DISTINCT FROM NEW."providerTransferId"
        OR cancellation_evidence ->> 'providerPayoutId'
          IS DISTINCT FROM NEW."providerPayoutId"
        OR cancellation_evidence ->> 'reversalId'
          IS DISTINCT FROM NEW."cancellationEvidenceRef"
        OR LEFT(NEW."cancellationEvidenceRef", 4) <> 'trr_'
        OR cancellation_evidence ->> 'payoutStatus'
          IS DISTINCT FROM NEW."cancellationPayoutStatus"
        OR cancellation_evidence ->> 'connectedAccountId'
          IS DISTINCT FROM destination_provider_account_id
        OR cancellation_evidence ->> 'providerAmountMinor'
          IS DISTINCT FROM (
            (NEW."destinationAmount" * 100)::BIGINT
          )::TEXT
        OR cancellation_evidence ->> 'providerCurrency'
          IS DISTINCT FROM NEW."destinationCurrency"
        OR cancellation_evidence ->> 'providerPublicReference'
          IS DISTINCT FROM NEW."requestedReference"
        OR cancellation_evidence ->> 'livemode'
          IS DISTINCT FROM NEW."livemode"::TEXT
        OR cancellation_evidence ->> 'actorUserId'
          IS DISTINCT FROM NEW."cancellationActorUserId"
        OR (
          (cancellation_evidence ->> 'evidenceAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."cancellationEvidenceAt"
        OR (
          (cancellation_evidence ->> 'cancelledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."cancelledAt"
        OR NEW."destinationCurrency" <> 'USD'
        OR NEW."destinationAmount" * 100
          IS DISTINCT FROM TRUNC(NEW."destinationAmount" * 100)
        OR NEW."cancellationEvidenceAt"
          < OLD."createdAt" - INTERVAL '5 minutes'
        OR NEW."cancellationEvidenceAt"
          > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
        OR NEW."cancelledAt"
          > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION
          'Provider cancellation requires matching typed Stripe reversal evidence'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Payout cancellation requires a supported evidence source'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutExecution_identity_guard"
BEFORE INSERT OR UPDATE ON "PayoutExecution"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_execution_identity"();

-- Terminal payout provenance is immutable. Operational repair must use a
-- separately reviewed compensating command; ordinary application updates may
-- never regress COMPLETED or replace the evidence that released liability.
CREATE FUNCTION "guard_completed_payout_immutability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  withdrawal_requester TEXT;
  withdrawal_approver TEXT;
  withdrawal_method TEXT;
  withdrawal_status TEXT;
  payout_method_type TEXT;
  provider_name TEXT;
  destination_provider_account_id TEXT;
  completion_metadata JSONB;
  webhook_provider TEXT;
  webhook_event_type TEXT;
  webhook_provider_execution_id TEXT;
  webhook_provider_account_id TEXT;
  webhook_provider_status TEXT;
  webhook_status TEXT;
  webhook_attempts INTEGER;
  webhook_livemode BOOLEAN;
  webhook_payout_amount_minor BIGINT;
  webhook_payout_currency TEXT;
  webhook_received_at TIMESTAMP(3);
  webhook_locked_at TIMESTAMP(3);
  completion_actor_user_type TEXT;
  completion_actor_banned BOOLEAN;
  completion_actor_staff_role TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payout execution rows are financial evidence and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  -- Completion is a transition performed by the canonical finalizer. Never
  -- allow a row to enter the database already terminal, since that would skip
  -- the locked withdrawal/balance checks in that finalizer.
  IF TG_OP = 'INSERT' AND NEW."status" IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION
      'Payout executions cannot be inserted in a terminal state'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION
      'Completed payout execution rows are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION
      'Cancelled payout execution rows are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."status" <> 'COMPLETED'
    AND NEW."status" = 'COMPLETED' THEN
    SELECT
      provider."name",
      withdrawal."requestedBy",
      withdrawal."approvedBy",
      withdrawal."method",
      withdrawal."status"::TEXT,
      payout_method."type"
    INTO
      provider_name,
      withdrawal_requester,
      withdrawal_approver,
      withdrawal_method,
      withdrawal_status,
      payout_method_type
    FROM "PayoutProvider" AS provider
    JOIN "Withdrawal" AS withdrawal
      ON withdrawal."id" = NEW."withdrawalId"
    JOIN "PayoutMethod" AS payout_method
      ON payout_method."id" = withdrawal."payoutMethodId"
    WHERE provider."id" = NEW."providerId"
    FOR SHARE OF provider, withdrawal, payout_method;

    IF NOT FOUND
      OR OLD."status" NOT IN ('PROCESSING', 'FAILED')
      OR withdrawal_status NOT IN ('PROCESSING', 'FAILED') THEN
      RAISE EXCEPTION
        'Payout completion requires a locked active provider and withdrawal route'
        USING ERRCODE = '23514';
    END IF;

    completion_metadata := NEW."providerMetadata" -> 'completion';

    -- LEGACY_UNVERIFIED is migration-only. Historical rows were backfilled
    -- before this trigger was installed; no runtime writer may use it to
    -- bypass the source-specific evidence requirements.
    IF NEW."completionSource" = 'LEGACY_UNVERIFIED' THEN
      RAISE EXCEPTION
        'LEGACY_UNVERIFIED cannot be used for a new payout completion'
        USING ERRCODE = '23514';
    ELSIF NEW."completionSource" = 'MANUAL_BANK_CONFIRMATION' THEN
      SELECT
        actor."userType"::TEXT,
        actor."banned",
        staff."role"::TEXT
      INTO
        completion_actor_user_type,
        completion_actor_banned,
        completion_actor_staff_role
      FROM "User" AS actor
      JOIN "StaffMembership" AS staff
        ON staff."userId" = actor."id"
      WHERE actor."id" = NEW."completionActorUserId"
      FOR SHARE OF actor, staff;

      IF provider_name <> 'manual'
        OR withdrawal_method <> 'bank_transfer'
        OR payout_method_type <> 'bank_transfer'
        OR NOT FOUND
        OR completion_actor_user_type IS DISTINCT FROM 'STAFF'
        OR completion_actor_banned IS DISTINCT FROM FALSE
        OR completion_actor_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN')
        OR OLD."providerExecutionId" IS NULL
        OR NEW."providerExecutionId"
          IS DISTINCT FROM OLD."providerExecutionId"
        OR OLD."stage" <> 'PROVIDER_SENT'
        OR NEW."stage" <> 'MANUAL_CONFIRMED'
        OR NEW."bankTraceReference"
          IS DISTINCT FROM NEW."completionEvidenceRef"
        OR NEW."acceptedReference"
          IS DISTINCT FROM NEW."completionEvidenceRef"
        OR JSONB_TYPEOF(completion_metadata) IS DISTINCT FROM 'object'
        OR completion_metadata ->> 'source'
          IS DISTINCT FROM 'MANUAL_BANK_CONFIRMATION'
        OR completion_metadata ->> 'evidenceReference'
          IS DISTINCT FROM NEW."completionEvidenceRef"
        OR completion_metadata ->> 'actorUserId'
          IS DISTINCT FROM NEW."completionActorUserId"
        OR JSONB_TYPEOF(completion_metadata -> 'reason')
          IS DISTINCT FROM 'string'
        OR completion_metadata ->> 'reason'
          IS DISTINCT FROM BTRIM(completion_metadata ->> 'reason')
        OR LENGTH(completion_metadata ->> 'reason') NOT BETWEEN 10 AND 2000
        OR (
          (completion_metadata ->> 'evidenceAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."completionEvidenceAt"
        OR (
          (completion_metadata ->> 'completedAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."completedAt"
        OR NEW."completionEvidenceAt"
          < OLD."createdAt" - INTERVAL '5 minutes'
        OR NEW."completionEvidenceAt"
          > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
        OR NEW."completedAt"
          > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '5 minutes' THEN
        RAISE EXCEPTION
          'Manual payout completion requires the sent manual bank route and matching bank evidence'
          USING ERRCODE = '23514';
      END IF;

      IF NEW."completionActorUserId" IS NULL
        OR withdrawal_requester IS NULL
        OR withdrawal_approver IS NULL
        OR NEW."initiatedByUserId" IS NULL
        OR NEW."completionActorUserId" = withdrawal_requester
        OR NEW."completionActorUserId" = withdrawal_approver
        OR NEW."completionActorUserId" = NEW."initiatedByUserId" THEN
        RAISE EXCEPTION
          'Manual payout completion requires known requester, approver, and initiator provenance, with the checker distinct from each'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."completionSource" IN (
      'PROVIDER_RESPONSE',
      'PROVIDER_STATUS_POLL',
      'PROVIDER_WEBHOOK'
    ) THEN
      destination_provider_account_id :=
        NEW."providerMetadata"
          #>> '{destinationSnapshot,providerAccountExternalId}';

      IF JSONB_TYPEOF(completion_metadata) IS DISTINCT FROM 'object'
        OR completion_metadata ->> 'source'
          IS DISTINCT FROM NEW."completionSource"::TEXT
        OR completion_metadata ->> 'evidenceReference'
          IS DISTINCT FROM NEW."completionEvidenceRef"
        OR (
          (completion_metadata ->> 'evidenceAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."completionEvidenceAt"
        OR (
          (completion_metadata ->> 'completedAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
          IS DISTINCT FROM NEW."completedAt"
        OR NEW."destinationCurrency" <> 'USD'
        OR NEW."destinationAmount" * 100
          IS DISTINCT FROM TRUNC(NEW."destinationAmount" * 100)
        OR completion_metadata ->> 'providerAmountMinor'
          IS DISTINCT FROM (
            (NEW."destinationAmount" * 100)::BIGINT
          )::TEXT
        OR completion_metadata ->> 'providerCurrency'
          IS DISTINCT FROM NEW."destinationCurrency"
        OR completion_metadata ->> 'livemode'
          IS DISTINCT FROM NEW."livemode"::TEXT THEN
        RAISE EXCEPTION
          'Automated payout completion requires exact provider amount and currency evidence'
          USING ERRCODE = '23514';
      END IF;

      IF provider_name = 'stripe_connect' THEN
        IF withdrawal_method <> 'stripe_connect'
          OR payout_method_type <> 'stripe_connect'
          OR NEW."livemode" IS NULL
          OR destination_provider_account_id IS NULL
          OR LENGTH(BTRIM(destination_provider_account_id)) = 0
          OR OLD."providerPayoutId" IS NULL
          OR NEW."providerPayoutId"
            IS DISTINCT FROM OLD."providerPayoutId"
          OR NEW."completionEvidenceRef"
            IS DISTINCT FROM NEW."providerPayoutId"
          OR LEFT(NEW."completionEvidenceRef", 3) <> 'po_'
          OR OLD."stage" NOT IN (
            'BANK_PAID',
            'BANK_PAYOUT_CREATED',
            'BANK_PAYOUT_PENDING',
            'BANK_PAYOUT_RECOVERY_REQUIRED',
            'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
          )
          OR NEW."stage" <> 'BANK_PAID' THEN
          RAISE EXCEPTION
            'Stripe payout completion requires the persisted bank Payout object and a terminal recovery stage'
            USING ERRCODE = '23514';
        END IF;
      ELSIF provider_name = 'wise' THEN
        IF withdrawal_method <> 'wise'
          OR payout_method_type <> 'wise'
          OR OLD."providerExecutionId" IS NULL
          OR NEW."providerExecutionId"
            IS DISTINCT FROM OLD."providerExecutionId"
          OR NEW."completionEvidenceRef"
            IS DISTINCT FROM NEW."providerExecutionId"
          OR OLD."stage" NOT IN (
            'PROVIDER_SENT',
            'PROVIDER_OUTCOME_UNKNOWN',
            'PROVIDER_COMPLETION_RECOVERY_REQUIRED'
          )
          OR NEW."stage" IS DISTINCT FROM OLD."stage" THEN
          RAISE EXCEPTION
            'Wise payout completion requires the persisted transfer and a terminal recovery stage'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION
          'Automated payout completion requires a supported automated provider route'
          USING ERRCODE = '23514';
      END IF;

      IF NEW."completionSource" = 'PROVIDER_WEBHOOK' THEN
        SELECT
          event."provider",
          event."eventType",
          event."providerExecutionId",
          event."providerAccountExternalId",
          event."providerStatus",
          event."status"::TEXT,
          event."attempts",
          event."livemode",
          event."payoutAmountMinor",
          event."payoutCurrency",
          event."receivedAt",
          event."lockedAt"
        INTO
          webhook_provider,
          webhook_event_type,
          webhook_provider_execution_id,
          webhook_provider_account_id,
          webhook_provider_status,
          webhook_status,
          webhook_attempts,
          webhook_livemode,
          webhook_payout_amount_minor,
          webhook_payout_currency,
          webhook_received_at,
          webhook_locked_at
        FROM "PayoutWebhookEvent" AS event
        WHERE event."id" = NEW."completionWebhookEventId"
        FOR UPDATE;

        IF NOT FOUND
          OR webhook_provider IS DISTINCT FROM provider_name
          OR webhook_provider_execution_id
            IS DISTINCT FROM NEW."completionEvidenceRef"
          OR webhook_provider_status IS DISTINCT FROM 'COMPLETED'
          OR webhook_status IS DISTINCT FROM 'PROCESSING'
          OR webhook_locked_at IS NULL
          OR webhook_livemode IS DISTINCT FROM NEW."livemode"
          OR COALESCE(
            completion_metadata ->> 'webhookClaimAttempt',
            ''
          ) !~ '^[1-9][0-9]*$'
          OR (completion_metadata ->> 'webhookClaimAttempt')::INTEGER
            IS DISTINCT FROM webhook_attempts
          OR (
            (
              completion_metadata ->> 'webhookClaimLockedAt'
            )::TIMESTAMPTZ AT TIME ZONE 'UTC'
          ) IS DISTINCT FROM webhook_locked_at
          OR webhook_received_at
            IS DISTINCT FROM NEW."completionEvidenceAt"
          OR (
            provider_name = 'stripe_connect'
            AND (
              webhook_event_type IS DISTINCT FROM 'payout.paid'
              OR destination_provider_account_id IS NULL
              OR LENGTH(BTRIM(destination_provider_account_id)) = 0
              OR webhook_provider_account_id
                IS DISTINCT FROM destination_provider_account_id
              OR webhook_payout_amount_minor
                IS DISTINCT FROM (NEW."destinationAmount" * 100)
              OR webhook_payout_currency
                IS DISTINCT FROM NEW."destinationCurrency"
            )
          )
          OR (
            provider_name = 'wise'
            AND (
              webhook_event_type
                IS DISTINCT FROM 'transfers#state-change'
              OR webhook_provider_account_id IS NOT NULL
            )
          ) THEN
          RAISE EXCEPTION
            'Webhook payout completion requires matching locked provider evidence'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION
        'Payout completion requires a supported evidence source'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutExecution_completed_immutability_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PayoutExecution"
FOR EACH ROW
EXECUTE FUNCTION "guard_completed_payout_immutability"();

-- The worker/finalizer trusts the normalized inbox envelope. Keep those
-- evidence fields immutable and constrain the operational state machine so a
-- stale writer cannot rewrite provider truth or revive terminal evidence.
CREATE FUNCTION "guard_payout_webhook_event_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Payout webhook events are financial evidence and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING'
      OR NEW."attempts" <> 0
      OR NEW."lockedAt" IS NOT NULL
      OR NEW."processedAt" IS NOT NULL
      OR (
        NEW."provider" = 'stripe_connect'
        AND NEW."livemode" IS NULL
      )
      OR (
        NEW."provider" <> 'stripe_connect'
        AND NEW."livemode" IS NOT NULL
      )
      OR (
        NEW."provider" = 'stripe_connect'
        AND NEW."eventType" LIKE 'payout.%'
        AND (
          NEW."payoutAmountMinor" IS NULL
          OR NEW."payoutCurrency" IS NULL
        )
      ) THEN
      RAISE EXCEPTION
        'Payout webhook events must enter with canonical pending evidence'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."dedupKey" IS DISTINCT FROM OLD."dedupKey"
    OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
    OR NEW."providerExecutionId" IS DISTINCT FROM OLD."providerExecutionId"
    OR NEW."providerAccountExternalId"
      IS DISTINCT FROM OLD."providerAccountExternalId"
    OR NEW."payoutAmountMinor" IS DISTINCT FROM OLD."payoutAmountMinor"
    OR NEW."payoutCurrency" IS DISTINCT FROM OLD."payoutCurrency"
    OR NEW."livemode" IS DISTINCT FROM OLD."livemode"
    OR NEW."providerStatus" IS DISTINCT FROM OLD."providerStatus"
    OR NEW."rawStatus" IS DISTINCT FROM OLD."rawStatus"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Payout webhook normalized evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('PENDING', 'FAILED')
    AND NEW."status" = 'PROCESSING'
    AND NEW."attempts" <> OLD."attempts" + 1 THEN
    RAISE EXCEPTION
      'Payout webhook claims require exactly one new lease attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
      OLD."status" IN ('PENDING', 'FAILED')
      AND NEW."status" = 'PROCESSING'
    )
    AND NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN
    RAISE EXCEPTION
      'Payout webhook attempts may change only during an exact claim'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'PROCESSING'
    AND NEW."status" = 'PROCESSING'
    AND NEW."lockedAt" IS DISTINCT FROM OLD."lockedAt" THEN
    RAISE EXCEPTION
      'Payout webhook processing leases cannot be replaced in place'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('PROCESSED', 'IGNORED', 'QUARANTINED')
    AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION
      'Terminal payout webhook operational evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('PROCESSED', 'IGNORED')
    AND NEW."status" = 'QUARANTINED'
    AND (
      NEW."processedAt" IS DISTINCT FROM OLD."processedAt"
      OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt"
      OR NEW."lastError" IS NULL
      OR LENGTH(BTRIM(NEW."lastError")) = 0
    ) THEN
    RAISE EXCEPTION
      'Payout webhook quarantine escalation must preserve terminal timestamps and record a reason'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      (OLD."status" IN ('PENDING', 'FAILED')
        AND NEW."status" IN ('PROCESSING', 'QUARANTINED'))
      OR (OLD."status" = 'PROCESSING'
        AND NEW."status" IN ('FAILED', 'PROCESSED', 'IGNORED', 'QUARANTINED'))
      OR (OLD."status" IN ('PROCESSED', 'IGNORED')
        AND NEW."status" = 'QUARANTINED')
    ) THEN
    RAISE EXCEPTION
      'Invalid payout webhook inbox lifecycle transition'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'PROCESSING' AND NEW."lockedAt" IS NULL THEN
    RAISE EXCEPTION
      'Processing payout webhook events require a lock lease'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'PROCESSING' AND NEW."lockedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'Non-processing payout webhook events cannot retain a lock lease'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('PROCESSED', 'IGNORED', 'QUARANTINED')
    AND NEW."processedAt" IS NULL THEN
    RAISE EXCEPTION
      'Terminal payout webhook inbox states require processedAt'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IN ('PENDING', 'FAILED')
    AND NEW."processedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'Retryable payout webhook inbox states cannot have processedAt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutWebhookEvent_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "PayoutWebhookEvent"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_webhook_event_evidence"();

-- Completion links are deliberately two-step inside the canonical transaction:
-- the execution records which verified event authorized liability release, then
-- the event becomes PROCESSED. At commit both sides must agree. Unlinked
-- processed events (nonterminal updates, failures, unsupported types) remain
-- valid and are not forced to manufacture a payout completion.
CREATE FUNCTION "guard_payout_completion_webhook_link_commit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_execution_id TEXT;
  target_event_id TEXT;
  execution_status TEXT;
  execution_completion_source TEXT;
  execution_webhook_event_id TEXT;
  event_status TEXT;
  event_provider TEXT;
  event_type TEXT;
  event_provider_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'PayoutExecution' THEN
    target_execution_id := NEW."id";
    SELECT
      execution."status"::TEXT,
      execution."completionSource"::TEXT,
      execution."completionWebhookEventId"
    INTO
      execution_status,
      execution_completion_source,
      execution_webhook_event_id
    FROM "PayoutExecution" AS execution
    WHERE execution."id" = target_execution_id;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF execution_webhook_event_id IS NULL THEN
      IF execution_status = 'COMPLETED'
        AND execution_completion_source = 'PROVIDER_WEBHOOK' THEN
        RAISE EXCEPTION
          'Webhook-completed payout execution requires a processed linked event'
          USING ERRCODE = '23514';
      END IF;
      RETURN NULL;
    END IF;
    target_event_id := execution_webhook_event_id;
  ELSE
    target_event_id := NEW."id";
    SELECT
      execution."id",
      execution."status"::TEXT,
      execution."completionSource"::TEXT,
      execution."completionWebhookEventId"
    INTO
      target_execution_id,
      execution_status,
      execution_completion_source,
      execution_webhook_event_id
    FROM "PayoutExecution" AS execution
    WHERE execution."completionWebhookEventId" = target_event_id;

  END IF;

  SELECT
    event."status"::TEXT,
    event."provider",
    event."eventType",
    event."providerStatus"
  INTO
    event_status,
    event_provider,
    event_type,
    event_provider_status
  FROM "PayoutWebhookEvent" AS event
  WHERE event."id" = target_event_id;

  IF target_execution_id IS NULL THEN
    -- Non-completion/failure/account events may be consumed without releasing
    -- payout liability. A recognized successful payout event may not: it must
    -- commit with the exact completed execution it authorized.
    IF event_status = 'PROCESSED'
      AND (
        (
          event_provider = 'stripe_connect'
          AND event_type = 'payout.paid'
          AND event_provider_status = 'COMPLETED'
        )
        OR (
          event_provider = 'wise'
          AND event_type = 'transfers#state-change'
          AND event_provider_status = 'COMPLETED'
        )
      ) THEN
      RAISE EXCEPTION
        'Completion-authorizing payout webhook cannot be processed without its completed execution'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF event_status IS NULL
    OR execution_status IS DISTINCT FROM 'COMPLETED'
    OR execution_completion_source IS DISTINCT FROM 'PROVIDER_WEBHOOK'
    OR execution_webhook_event_id IS DISTINCT FROM target_event_id
    OR event_status IS DISTINCT FROM 'PROCESSED' THEN
    RAISE EXCEPTION
      'Payout webhook completion link must commit as COMPLETED to PROCESSED'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PayoutExecution_completion_webhook_link_guard"
AFTER INSERT OR UPDATE ON "PayoutExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_completion_webhook_link_commit"();

CREATE CONSTRAINT TRIGGER "PayoutWebhookEvent_completion_link_guard"
AFTER INSERT OR UPDATE ON "PayoutWebhookEvent"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_completion_webhook_link_commit"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Withdrawal"
    WHERE ("approvedBy" IS NULL) <> ("approvedAt" IS NULL)
      OR ("rejectedBy" IS NULL) <> ("rejectedAt" IS NULL)
      OR ("reversedBy" IS NULL) <> ("reversedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION
      'Payout completion migration backfill failed: a withdrawal actor/timestamp pair is mismatched';
  END IF;
END $$;

ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "Withdrawal_actor_timestamp_pairs_check" CHECK (
    ("approvedBy" IS NULL) = ("approvedAt" IS NULL)
    AND ("rejectedBy" IS NULL) = ("rejectedAt" IS NULL)
    AND ("reversedBy" IS NULL) = ("reversedAt" IS NULL)
  );

-- Terminal withdrawal accounting/provenance is immutable. For non-terminal
-- rows, requester and decision actor/timestamp pairs may be appended once but
-- never replaced or cleared.
CREATE FUNCTION "guard_withdrawal_financial_provenance"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  completed_execution_count INTEGER;
  safe_latest_cancellation_count INTEGER;
  actor_user_type TEXT;
  actor_banned BOOLEAN;
  actor_staff_role TEXT;
  requester_eligible BOOLEAN;
  payout_method_eligible BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Withdrawal rows are financial evidence and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING'
      OR NEW."version" <> 0
      OR NEW."requestedBy" IS NULL
      OR NEW."idempotencyKey" IS NULL
      OR LENGTH(BTRIM(NEW."idempotencyKey")) = 0
      OR NEW."payoutMethodId" IS NULL
      OR NEW."publicReference" IS NULL
      OR LENGTH(BTRIM(NEW."publicReference")) = 0
      OR NEW."currency" <> 'USD'
      OR NEW."amount" <= 0
      OR NEW."amount" * 100 IS DISTINCT FROM TRUNC(NEW."amount" * 100)
      OR NEW."payoutFee" < 0
      OR NEW."payoutFee" * 100
        IS DISTINCT FROM TRUNC(NEW."payoutFee" * 100)
      OR NEW."netAmount" IS NULL
      OR NEW."netAmount" <= 0
      OR NEW."netAmount" * 100
        IS DISTINCT FROM TRUNC(NEW."netAmount" * 100)
      OR NEW."amount"
        IS DISTINCT FROM NEW."netAmount" + NEW."payoutFee"
      OR NEW."feePolicyVersion" IS NULL
      OR LENGTH(BTRIM(NEW."feePolicyVersion")) = 0
      OR NEW."availableAt" IS NULL
      OR NEW."approvedBy" IS NOT NULL
      OR NEW."approvedAt" IS NOT NULL
      OR NEW."rejectedBy" IS NOT NULL
      OR NEW."rejectedAt" IS NOT NULL
      OR NEW."reversedBy" IS NOT NULL
      OR NEW."reversedAt" IS NOT NULL THEN
      RAISE EXCEPTION
        'Withdrawals must be inserted as canonical provenance-backed requests'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "PublisherMembership" AS membership
      JOIN "User" AS requester
        ON requester."id" = membership."userId"
      WHERE membership."publisherId" = NEW."publisherId"
        AND membership."userId" = NEW."requestedBy"
        AND membership."role" = 'PUBLISHER_OWNER'
        AND requester."userType" = 'PUBLISHER'
        AND requester."banned" = FALSE
      FOR SHARE OF membership, requester
    )
    INTO requester_eligible;

    IF requester_eligible IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'Withdrawal requester must be a current unbanned publisher owner'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM "PayoutMethod" AS method
      WHERE method."id" = NEW."payoutMethodId"
        AND method."publisherId" = NEW."publisherId"
        AND method."type" = NEW."method"
        AND method."isActive" = TRUE
    )
    INTO payout_method_eligible;

    IF NEW."payoutMethodId" IS NULL
      OR payout_method_eligible IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'Withdrawal requires a current active payout method matching its command'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('COMPLETED', 'REJECTED', 'REVERSED') THEN
    RAISE EXCEPTION
      'Terminal withdrawal rows are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."publicReference" IS DISTINCT FROM OLD."publicReference"
    OR NEW."payoutFee" IS DISTINCT FROM OLD."payoutFee"
    OR NEW."netAmount" IS DISTINCT FROM OLD."netAmount"
    OR NEW."feePolicyVersion" IS DISTINCT FROM OLD."feePolicyVersion"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."availableAt" IS DISTINCT FROM OLD."availableAt"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."payoutMethodId" IS DISTINCT FROM OLD."payoutMethodId"
    OR NEW."payoutBatchId" IS DISTINCT FROM OLD."payoutBatchId"
    OR NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Withdrawal command envelope is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION
      'Withdrawal updates require an exact version increment'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      (OLD."status" = 'PENDING'
        AND NEW."status" IN ('APPROVED', 'REJECTED'))
      OR (OLD."status" = 'APPROVED'
        AND NEW."status" IN ('PROCESSING', 'REJECTED'))
      OR (OLD."status" = 'PROCESSING'
        AND NEW."status" IN ('APPROVED', 'FAILED', 'COMPLETED'))
      OR (OLD."status" = 'FAILED'
        AND NEW."status" IN ('APPROVED', 'COMPLETED', 'REVERSED'))
    ) THEN
    RAISE EXCEPTION
      'Invalid withdrawal status transition'
      USING ERRCODE = '23514';
  END IF;

  IF (
      NEW."status" = 'PENDING'
      AND (
        NEW."approvedBy" IS NOT NULL
        OR NEW."approvedAt" IS NOT NULL
        OR NEW."rejectedBy" IS NOT NULL
        OR NEW."rejectedAt" IS NOT NULL
        OR NEW."reversedBy" IS NOT NULL
        OR NEW."reversedAt" IS NOT NULL
      )
    ) OR (
      NEW."status" IN ('APPROVED', 'PROCESSING', 'FAILED', 'COMPLETED')
      AND (
        NEW."approvedBy" IS NULL
        OR NEW."approvedAt" IS NULL
        OR NEW."rejectedBy" IS NOT NULL
        OR NEW."rejectedAt" IS NOT NULL
        OR NEW."reversedBy" IS NOT NULL
        OR NEW."reversedAt" IS NOT NULL
      )
    ) OR (
      NEW."status" = 'REJECTED'
      AND (
        NEW."rejectedBy" IS NULL
        OR NEW."rejectedAt" IS NULL
        OR NEW."reversedBy" IS NOT NULL
        OR NEW."reversedAt" IS NOT NULL
      )
    ) OR (
      NEW."status" = 'REVERSED'
      AND (
        NEW."approvedBy" IS NULL
        OR NEW."approvedAt" IS NULL
        OR NEW."rejectedBy" IS NOT NULL
        OR NEW."rejectedAt" IS NOT NULL
        OR NEW."reversedBy" IS NULL
        OR NEW."reversedAt" IS NULL
      )
    ) THEN
    RAISE EXCEPTION
      'Withdrawal status does not match its actor provenance'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "PublisherMembership" AS membership
      JOIN "User" AS requester
        ON requester."id" = membership."userId"
      WHERE membership."publisherId" = NEW."publisherId"
        AND membership."userId" = NEW."requestedBy"
        AND membership."role" = 'PUBLISHER_OWNER'
        AND requester."userType" = 'PUBLISHER'
        AND requester."banned" = FALSE
      FOR SHARE OF membership, requester
    )
    INTO requester_eligible;

    IF NEW."requestedBy" IS NULL
      OR requester_eligible IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'Withdrawal approval requires a current unbanned publisher-owner requester'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      actor."userType"::TEXT,
      actor."banned",
      staff."role"::TEXT
    INTO
      actor_user_type,
      actor_banned,
      actor_staff_role
    FROM "User" AS actor
    JOIN "StaffMembership" AS staff
      ON staff."userId" = actor."id"
    WHERE actor."id" = NEW."approvedBy"
    FOR SHARE OF actor, staff;

    IF NOT FOUND
      OR actor_user_type IS DISTINCT FROM 'STAFF'
      OR actor_banned IS DISTINCT FROM FALSE
      OR actor_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN')
      OR NEW."approvedAt" < NEW."createdAt"
      OR NEW."approvedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION
        'Withdrawal approval requires a current unbanned Finance or Super Admin staff member'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."status" <> 'REJECTED' AND NEW."status" = 'REJECTED' THEN
    IF OLD."status" = 'PENDING' THEN
      IF NEW."approvedBy" IS NOT NULL
        OR NEW."approvedAt" IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM "PayoutExecution"
          WHERE "withdrawalId" = NEW."id"
        ) THEN
        RAISE EXCEPTION
          'Pending withdrawal rejection requires no approval or execution history'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."status" = 'APPROVED' THEN
      IF NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
        OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
        OR NEW."rejectedAt" < OLD."approvedAt"
        OR EXISTS (
          SELECT 1
          FROM "PayoutExecution" AS execution
          WHERE execution."withdrawalId" = NEW."id"
            AND (
              execution."status" IS DISTINCT FROM 'CANCELLED'
              OR execution."stage" IS DISTINCT FROM 'PRE_PROVIDER_ABORTED'
              OR execution."cancellationSource"
                IS DISTINCT FROM 'PRE_PROVIDER_ABORT'
              OR execution."providerExecutionId" IS NOT NULL
              OR execution."providerTransferId" IS NOT NULL
              OR execution."providerPayoutId" IS NOT NULL
              OR execution."acceptedReference" IS NOT NULL
              OR execution."bankTraceReference" IS NOT NULL
            )
        )
        OR EXISTS (
          SELECT 1
          FROM "PayoutExecutionClaim" AS claim
          JOIN "PayoutExecution" AS execution
            ON execution."id" = claim."executionId"
          WHERE execution."withdrawalId" = NEW."id"
        ) THEN
        RAISE EXCEPTION
          'Approved withdrawal abandonment requires exclusively claim-free pre-provider-aborted execution history'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION
        'Withdrawal rejection is allowed only from pending or safely abandoned approved state'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      actor."userType"::TEXT,
      actor."banned",
      staff."role"::TEXT
    INTO
      actor_user_type,
      actor_banned,
      actor_staff_role
    FROM "User" AS actor
    JOIN "StaffMembership" AS staff
      ON staff."userId" = actor."id"
    WHERE actor."id" = NEW."rejectedBy"
    FOR SHARE OF actor, staff;

    IF NOT FOUND
      OR actor_user_type IS DISTINCT FROM 'STAFF'
      OR actor_banned IS DISTINCT FROM FALSE
      OR actor_staff_role NOT IN ('FINANCE', 'SUPER_ADMIN')
      OR NEW."rejectedAt" < NEW."createdAt"
      OR NEW."rejectedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
      RAISE EXCEPTION
        'Withdrawal rejection requires a current unbanned Finance or Super Admin staff member'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- No runtime reversal workflow currently carries typed provider
  -- cancellation/failure evidence. Fail closed so an old instance cannot
  -- restore reserved funds and make the same liability withdrawable again.
  IF OLD."status" <> 'REVERSED' AND NEW."status" = 'REVERSED' THEN
    RAISE EXCEPTION
      'Withdrawal reversal requires typed provider cancellation or reversal evidence'
      USING ERRCODE = '23514';
  END IF;

  -- Returning PROCESSING to APPROVED is only valid after the latest execution
  -- became a typed safe cancellation in the same transaction. This makes an
  -- old two-phase cancellation writer roll back both the execution mutation
  -- and the liability reopen when its provider call returned no evidence.
  IF OLD."status" NOT IN ('PENDING', 'APPROVED')
    AND NEW."status" = 'APPROVED' THEN
    SELECT COUNT(*)
    INTO safe_latest_cancellation_count
    FROM "PayoutExecution" AS candidate
    WHERE candidate."id" = (
      SELECT latest."id"
      FROM "PayoutExecution" AS latest
      WHERE latest."withdrawalId" = NEW."id"
      ORDER BY latest."createdAt" DESC, latest."id" DESC
      LIMIT 1
    )
      AND candidate."status" = 'CANCELLED'
      AND candidate."cancellationSource" IN (
        'PRE_PROVIDER_ABORT',
        'PROVIDER_RESPONSE'
      );

    IF safe_latest_cancellation_count <> 1 THEN
      RAISE EXCEPTION
        'Withdrawal reopen requires the latest payout execution to have typed cancellation evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A stale application writer must not release withdrawal liability merely
  -- by setting the aggregate status. The canonical finalizer first completes
  -- exactly one evidence-backed execution in the same locked transaction.
  IF OLD."status" <> 'COMPLETED' AND NEW."status" = 'COMPLETED' THEN
    SELECT COUNT(*)
    INTO completed_execution_count
    FROM "PayoutExecution"
    WHERE "withdrawalId" = NEW."id"
      AND "status" = 'COMPLETED';

    IF completed_execution_count <> 1 THEN
      RAISE EXCEPTION
        'Withdrawal completion requires exactly one completed payout execution'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."requestedBy" IS NOT NULL
    AND NEW."requestedBy" IS DISTINCT FROM OLD."requestedBy" THEN
    RAISE EXCEPTION
      'Withdrawal requester provenance is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD."approvedBy" IS NOT NULL OR OLD."approvedAt" IS NOT NULL
  ) AND (
    NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
    OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
  ) THEN
    RAISE EXCEPTION
      'Withdrawal approval provenance is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD."rejectedBy" IS NOT NULL OR OLD."rejectedAt" IS NOT NULL
  ) AND (
    NEW."rejectedBy" IS DISTINCT FROM OLD."rejectedBy"
    OR NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt"
  ) THEN
    RAISE EXCEPTION
      'Withdrawal rejection provenance is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF (
    OLD."reversedBy" IS NOT NULL OR OLD."reversedAt" IS NOT NULL
  ) AND (
    NEW."reversedBy" IS DISTINCT FROM OLD."reversedBy"
    OR NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt"
  ) THEN
    RAISE EXCEPTION
      'Withdrawal reversal provenance is append-only'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Withdrawal_financial_provenance_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "Withdrawal"
FOR EACH ROW
EXECUTE FUNCTION "guard_withdrawal_financial_provenance"();

CREATE FUNCTION "maintain_payout_method_withdrawal_liability"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_is_nonterminal BOOLEAN;
  new_is_nonterminal BOOLEAN;
  needs_liability_increment BOOLEAN;
  method_type TEXT;
  method_provider_account_id TEXT;
BEGIN
  new_is_nonterminal := NEW."status" IN (
    'PENDING',
    'APPROVED',
    'PROCESSING',
    'FAILED'
  );

  IF TG_OP = 'INSERT' THEN
    old_is_nonterminal := FALSE;
  ELSE
    old_is_nonterminal := OLD."status" IN (
      'PENDING',
      'APPROVED',
      'PROCESSING',
      'FAILED'
    );
  END IF;
  needs_liability_increment :=
    new_is_nonterminal AND (
      TG_OP = 'INSERT'
      OR NOT old_is_nonterminal
    );

  IF needs_liability_increment THEN
    -- Discover the immutable binding without locking Method. Managed routes
    -- then lock/validate ProviderAccount first; the conditional counter update
    -- locks and revalidates Method last.
    SELECT method."type", method."providerAccountId"
    INTO method_type, method_provider_account_id
    FROM "PayoutMethod" AS method
    WHERE method."id" = NEW."payoutMethodId"
      AND method."publisherId" = NEW."publisherId"
      AND method."type" = NEW."method";
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Withdrawal reservation has no matching payout method'
        USING ERRCODE = '23514';
    END IF;

    IF method_type = 'stripe_connect' THEN
      IF method_provider_account_id IS NULL THEN
        RAISE EXCEPTION
          'Stripe withdrawal requires a managed provider account'
          USING ERRCODE = '23514';
      END IF;
      PERFORM 1
      FROM "PublisherProviderAccount" AS account
      WHERE account."id" = method_provider_account_id
        AND account."publisherId" = NEW."publisherId"
        AND account."provider" = 'stripe_connect'
        AND account."isActive" = TRUE
        AND account."status" = 'ENABLED'
        AND account."transfersEnabled" = TRUE
        AND account."payoutsEnabled" = TRUE
        AND account."detailsSubmitted" = TRUE
        AND account."payoutScheduleConfigured" = TRUE
        AND UPPER(account."defaultCurrency") = UPPER(NEW."currency")
      FOR SHARE OF account;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Stripe withdrawal requires a fully ready provider account'
          USING ERRCODE = '23514';
      END IF;
    ELSIF method_provider_account_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Legacy payout methods cannot bind a managed provider account'
        USING ERRCODE = '23514';
    END IF;

    UPDATE "PayoutMethod"
    SET "nonterminalWithdrawalCount" =
      "nonterminalWithdrawalCount" + 1
    WHERE "id" = NEW."payoutMethodId"
      AND "publisherId" = NEW."publisherId"
      AND "type" = NEW."method"
      AND "providerAccountId"
        IS NOT DISTINCT FROM method_provider_account_id
      AND "isActive" = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Withdrawal reservation lost its active payout method race'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  -- Populated legacy rows can have no payoutMethodId. They carry no
  -- method-scoped liability to release, so terminalizing one must not
  -- underflow an unrelated method counter.
  IF old_is_nonterminal
    AND NOT new_is_nonterminal
    AND OLD."payoutMethodId" IS NOT NULL THEN
    UPDATE "PayoutMethod"
    SET "nonterminalWithdrawalCount" =
      "nonterminalWithdrawalCount" - 1
    WHERE "id" = OLD."payoutMethodId"
      AND "nonterminalWithdrawalCount" > 0;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Payout method withdrawal-liability count would underflow'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Run method-counter maintenance only after every allocation/balance write in
-- the transaction is complete. Managed reservations then lock
-- ProviderAccount -> PayoutMethod; legacy reservations lock PayoutMethod only.
-- The conditional method update still serializes commits with deactivation.
CREATE CONSTRAINT TRIGGER "Withdrawal_payout_method_liability_guard"
AFTER INSERT OR UPDATE ON "Withdrawal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "maintain_payout_method_withdrawal_liability"();

-- Withdrawal allocations are the immutable source-level proof that request
-- time reserved exactly the liability later approved/completed. They can be
-- created only while the canonical request is PENDING, and their sole runtime
-- mutation is a one-way release after that locked parent becomes REJECTED.
CREATE FUNCTION "guard_withdrawal_allocation_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Withdrawal allocations are financial evidence and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  SELECT "status"::TEXT
  INTO parent_status
  FROM "Withdrawal"
  WHERE "id" = NEW."withdrawalId"
  FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    IF parent_status IS DISTINCT FROM 'PENDING'
      OR NEW."releasedAt" IS NOT NULL
      OR NEW."amount" <= 0
      OR NEW."amount" * 100 IS DISTINCT FROM TRUNC(NEW."amount" * 100)
      OR NEW."currency" <> 'USD'
      OR NEW."sequence" < 0 THEN
      RAISE EXCEPTION
        'Withdrawal allocations must be inserted as active evidence for a pending request'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."withdrawalId" IS DISTINCT FROM OLD."withdrawalId"
    OR NEW."sourceType" IS DISTINCT FROM OLD."sourceType"
    OR NEW."sourceTransactionId" IS DISTINCT FROM OLD."sourceTransactionId"
    OR NEW."settlementId" IS DISTINCT FROM OLD."settlementId"
    OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW."amount" IS DISTINCT FROM OLD."amount"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."serviceType" IS DISTINCT FROM OLD."serviceType"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'Withdrawal allocation source and amount evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'Withdrawal allocation release evidence is append-only'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."releasedAt" IS NULL
    OR parent_status IS DISTINCT FROM 'REJECTED'
    OR NEW."releasedAt" < NEW."createdAt"
    OR NEW."releasedAt" > CURRENT_TIMESTAMP + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION
      'Withdrawal allocation release requires a rejected parent withdrawal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "WithdrawalAllocation_evidence_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WithdrawalAllocation"
FOR EACH ROW
EXECUTE FUNCTION "guard_withdrawal_allocation_evidence"();

-- Canonical requests are inserted before their source allocations inside one
-- transaction, so exact reservation coverage is a commit-time invariant. Both
-- parent and child mutations schedule the same assertion: no direct writer can
-- approve a malformed reservation, and a concurrent child insert cannot hide
-- behind a previously read approval snapshot.
CREATE FUNCTION "guard_withdrawal_allocation_reservation_commit"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_withdrawal_id TEXT;
  parent_status TEXT;
  parent_requested_by TEXT;
  parent_amount NUMERIC;
  parent_currency TEXT;
  active_allocation_count INTEGER;
  released_allocation_count INTEGER;
  invalid_active_allocation_count INTEGER;
  active_allocation_total NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'Withdrawal' THEN
    target_withdrawal_id := NEW."id";
  ELSE
    target_withdrawal_id := NEW."withdrawalId";
  END IF;

  SELECT
    withdrawal."status"::TEXT,
    withdrawal."requestedBy",
    withdrawal."amount",
    withdrawal."currency"
  INTO
    parent_status,
    parent_requested_by,
    parent_amount,
    parent_currency
  FROM "Withdrawal" AS withdrawal
  WHERE withdrawal."id" = target_withdrawal_id;

  IF NOT FOUND
    OR parent_requested_by IS NULL
    OR parent_status NOT IN (
      'PENDING',
      'APPROVED',
      'PROCESSING',
      'FAILED',
      'COMPLETED'
    ) THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE allocation."releasedAt" IS NULL),
    COUNT(*) FILTER (WHERE allocation."releasedAt" IS NOT NULL),
    COUNT(*) FILTER (
      WHERE allocation."releasedAt" IS NULL
        AND (
          allocation."amount" <= 0
          OR allocation."amount" * 100
            IS DISTINCT FROM TRUNC(allocation."amount" * 100)
          OR allocation."currency" IS DISTINCT FROM parent_currency
        )
    ),
    COALESCE(
      SUM(allocation."amount") FILTER (
        WHERE allocation."releasedAt" IS NULL
      ),
      0
    )
  INTO
    active_allocation_count,
    released_allocation_count,
    invalid_active_allocation_count,
    active_allocation_total
  FROM "WithdrawalAllocation" AS allocation
  WHERE allocation."withdrawalId" = target_withdrawal_id;

  IF active_allocation_count = 0
    OR released_allocation_count <> 0
    OR invalid_active_allocation_count <> 0
    OR active_allocation_total IS DISTINCT FROM parent_amount THEN
    RAISE EXCEPTION
      'Provenance-backed withdrawals require exact active allocation coverage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Withdrawal_allocation_reservation_commit_guard"
AFTER INSERT OR UPDATE ON "Withdrawal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_withdrawal_allocation_reservation_commit"();

CREATE CONSTRAINT TRIGGER "WithdrawalAllocation_reservation_commit_guard"
AFTER INSERT OR UPDATE ON "WithdrawalAllocation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_withdrawal_allocation_reservation_commit"();

-- The rejection flow changes the parent first so per-allocation release
-- triggers can verify intent. This deferred assertion closes the inverse gap:
-- a stale writer cannot commit REJECTED while leaving any reservation active.
CREATE FUNCTION "guard_rejected_withdrawal_allocation_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_count INTEGER;
  active_allocation_count INTEGER;
BEGIN
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE "releasedAt" IS NULL)
  INTO allocation_count, active_allocation_count
  FROM "WithdrawalAllocation"
  WHERE "withdrawalId" = NEW."id";

  IF allocation_count = 0 OR active_allocation_count <> 0 THEN
    RAISE EXCEPTION
      'Rejected withdrawals require every reserved allocation to be released'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "Withdrawal_rejection_allocation_completion_guard"
AFTER INSERT OR UPDATE ON "Withdrawal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW."status" = 'REJECTED')
EXECUTE FUNCTION "guard_rejected_withdrawal_allocation_completion"();

-- Aggregate and execution state are one commit-time invariant. The execution
-- path intentionally moves the parent to PROCESSING before inserting its
-- child in the same transaction; a deferred check permits that ordering while
-- rejecting either half if the transaction attempts to commit it alone.
CREATE FUNCTION "guard_processing_withdrawal_execution"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_withdrawal_id TEXT;
  current_withdrawal_status TEXT;
  processing_execution_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'Withdrawal' THEN
    target_withdrawal_id := NEW."id";
  ELSE
    target_withdrawal_id := NEW."withdrawalId";
  END IF;

  SELECT "status"::TEXT
  INTO current_withdrawal_status
  FROM "Withdrawal"
  WHERE "id" = target_withdrawal_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)
  INTO processing_execution_count
  FROM "PayoutExecution"
  WHERE "withdrawalId" = target_withdrawal_id
    AND "status" = 'PROCESSING';

  IF current_withdrawal_status = 'PROCESSING'
    AND processing_execution_count <> 1 THEN
    RAISE EXCEPTION
      'A processing withdrawal requires exactly one processing payout execution'
      USING ERRCODE = '23514';
  END IF;

  IF current_withdrawal_status <> 'PROCESSING'
    AND processing_execution_count <> 0 THEN
    RAISE EXCEPTION
      'A processing payout execution requires a processing withdrawal'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Withdrawal_processing_execution_guard"
AFTER INSERT OR UPDATE ON "Withdrawal"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_processing_withdrawal_execution"();

CREATE CONSTRAINT TRIGGER "PayoutExecution_processing_withdrawal_guard"
AFTER INSERT OR UPDATE ON "PayoutExecution"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "guard_processing_withdrawal_execution"();

COMMIT;
