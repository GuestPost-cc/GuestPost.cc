-- Reconstruct only legacy withdrawal reservations whose immutable local
-- ledger and audit history prove the request-time debit. A post-cutover
-- rejection is repaired only when its exact compensating reversal is also
-- proven and no payout execution ever existed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- This is a mixed-version-incompatible financial repair. SHARE prevents
-- concurrent INSERT/UPDATE/DELETE writers while preserving read access. Keep
-- the order stable and alphabetical for future migrations.
LOCK TABLE
  "AuditLog",
  "PayoutExecution",
  "PublisherBalance",
  "Transaction",
  "Withdrawal",
  "WithdrawalAllocation"
IN SHARE MODE;

-- Existing runtime reservations must already reconcile their carry-forward
-- usage. The candidates below have no allocations yet and therefore do not
-- contribute to either side of this preflight.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PublisherBalance" balance
    LEFT JOIN "Withdrawal" withdrawal
      ON withdrawal."publisherId" = balance."publisherId"
    LEFT JOIN "WithdrawalAllocation" allocation
      ON allocation."withdrawalId" = withdrawal."id"
    GROUP BY balance."publisherId", balance."allocationCarryForwardUsed"
    HAVING balance."allocationCarryForwardUsed" IS DISTINCT FROM COALESCE(
      SUM(allocation."amount") FILTER (
        WHERE allocation."releasedAt" IS NULL
          AND allocation."sourceType" = 'CARRY_FORWARD'
      ),
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill blocked: carry-forward usage is already inconsistent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Withdrawal" withdrawal
    CROSS JOIN LATERAL (
      SELECT
        COUNT(*) AS allocation_count,
        COUNT(*) FILTER (
          WHERE allocation."releasedAt" IS NULL
        ) AS active_count,
        COUNT(*) FILTER (
          WHERE allocation."releasedAt" IS NOT NULL
        ) AS released_count,
        COUNT(*) FILTER (
          WHERE allocation."amount" <= 0
            OR allocation."amount" * 100
              IS DISTINCT FROM TRUNC(allocation."amount" * 100)
            OR allocation."currency" IS DISTINCT FROM withdrawal."currency"
        ) AS invalid_count,
        COALESCE(SUM(allocation."amount"), 0) AS allocation_total
      FROM "WithdrawalAllocation" allocation
      WHERE allocation."withdrawalId" = withdrawal."id"
    ) allocation_state
    WHERE withdrawal."status" IN ('PENDING', 'REJECTED')
      AND allocation_state.allocation_count > 0
      AND (
        allocation_state.invalid_count <> 0
        OR allocation_state.allocation_total IS DISTINCT FROM withdrawal."amount"
        OR (
          withdrawal."status" = 'PENDING'
          AND (
            allocation_state.active_count <> allocation_state.allocation_count
            OR allocation_state.released_count <> 0
          )
        )
        OR (
          withdrawal."status" = 'REJECTED'
          AND (
            allocation_state.active_count <> 0
            OR allocation_state.released_count <> allocation_state.allocation_count
          )
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill blocked: an existing reservation is partial or contradictory';
  END IF;
END
$$;

CREATE TEMP TABLE legacy_withdrawal_repair_candidates (
  withdrawal_id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  withdrawal_status TEXT NOT NULL,
  debit_transaction_id TEXT NOT NULL,
  reversal_transaction_id TEXT,
  debit_created_at TIMESTAMP(3) NOT NULL,
  released_at TIMESTAMP(3)
) ON COMMIT DROP;

-- PENDING is pre-provider by definition here: exact request actor/audit/debit,
-- no decision evidence, no reversal, no execution, and a request strictly
-- before the carry-forward cutover.
INSERT INTO legacy_withdrawal_repair_candidates (
  withdrawal_id,
  publisher_id,
  amount,
  currency,
  withdrawal_status,
  debit_transaction_id,
  reversal_transaction_id,
  debit_created_at,
  released_at
)
SELECT
  withdrawal."id",
  withdrawal."publisherId",
  withdrawal."amount",
  withdrawal."currency",
  withdrawal."status"::TEXT,
  debit."id",
  NULL,
  debit."createdAt",
  NULL
FROM "Withdrawal" withdrawal
JOIN "PublisherBalance" balance
  ON balance."publisherId" = withdrawal."publisherId"
JOIN "Transaction" debit
  ON debit."reference" = 'withdrawal-' || withdrawal."id"
JOIN "AuditLog" request_audit
  ON request_audit."entityType" = 'Withdrawal'
 AND request_audit."entityId" = withdrawal."id"
 AND request_audit."action" = 'WITHDRAWAL_REQUESTED'
 AND request_audit."userId" = withdrawal."requestedBy"
WHERE withdrawal."status" = 'PENDING'
  AND withdrawal."version" = 0
  AND withdrawal."currency" = 'USD'
  AND withdrawal."amount" > 0
  AND withdrawal."amount" * 100
    IS NOT DISTINCT FROM TRUNC(withdrawal."amount" * 100)
  AND withdrawal."requestedBy" IS NOT NULL
  AND withdrawal."approvedBy" IS NULL
  AND withdrawal."approvedAt" IS NULL
  AND withdrawal."rejectedBy" IS NULL
  AND withdrawal."rejectedAt" IS NULL
  AND withdrawal."reversedBy" IS NULL
  AND withdrawal."reversedAt" IS NULL
  AND balance."currency" = 'USD'
  AND balance."allocationCutoverAt" IS NOT NULL
  AND withdrawal."createdAt" < balance."allocationCutoverAt"
  AND debit."type" = 'WITHDRAWAL'
  AND debit."amount" = -withdrawal."amount"
  AND debit."currency" = withdrawal."currency"
  AND debit."publisherId" = withdrawal."publisherId"
  AND debit."walletId" IS NULL
  AND debit."orderId" IS NULL
  AND debit."settlementId" IS NULL
  AND debit."provider" IS NULL
  AND debit."providerRef" IS NULL
  AND debit."createdAt" >= withdrawal."createdAt"
  AND debit."createdAt" < balance."allocationCutoverAt"
  AND request_audit."createdAt" >= withdrawal."createdAt"
  AND request_audit."createdAt" < balance."allocationCutoverAt"
  AND (
    SELECT COUNT(*)
    FROM "Transaction" candidate_debit
    WHERE candidate_debit."reference" = 'withdrawal-' || withdrawal."id"
  ) = 1
  AND (
    SELECT COUNT(*)
    FROM "AuditLog" candidate_request_audit
    WHERE candidate_request_audit."entityType" = 'Withdrawal'
      AND candidate_request_audit."entityId" = withdrawal."id"
      AND candidate_request_audit."action" = 'WITHDRAWAL_REQUESTED'
  ) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "Transaction" reversal
    WHERE reversal."reference" = 'withdrawal-reject-' || withdrawal."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "AuditLog" decision_audit
    WHERE decision_audit."entityType" = 'Withdrawal'
      AND decision_audit."entityId" = withdrawal."id"
      AND decision_audit."action" IN (
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_REJECTED',
        'WITHDRAWAL_REVERSED'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "PayoutExecution" execution
    WHERE execution."withdrawalId" = withdrawal."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "WithdrawalAllocation" allocation
    WHERE allocation."withdrawalId" = withdrawal."id"
  );

-- A REJECTED reconstruction is narrower: the request predates cutover, the
-- exact compensating reversal and matching staff audit postdate cutover, and
-- no approval, provider execution, or reversal-of-payout history exists.
INSERT INTO legacy_withdrawal_repair_candidates (
  withdrawal_id,
  publisher_id,
  amount,
  currency,
  withdrawal_status,
  debit_transaction_id,
  reversal_transaction_id,
  debit_created_at,
  released_at
)
SELECT
  withdrawal."id",
  withdrawal."publisherId",
  withdrawal."amount",
  withdrawal."currency",
  withdrawal."status"::TEXT,
  debit."id",
  reversal."id",
  debit."createdAt",
  withdrawal."rejectedAt"
FROM "Withdrawal" withdrawal
JOIN "PublisherBalance" balance
  ON balance."publisherId" = withdrawal."publisherId"
JOIN "Transaction" debit
  ON debit."reference" = 'withdrawal-' || withdrawal."id"
JOIN "Transaction" reversal
  ON reversal."reference" = 'withdrawal-reject-' || withdrawal."id"
JOIN "AuditLog" request_audit
  ON request_audit."entityType" = 'Withdrawal'
 AND request_audit."entityId" = withdrawal."id"
 AND request_audit."action" = 'WITHDRAWAL_REQUESTED'
 AND request_audit."userId" = withdrawal."requestedBy"
JOIN "AuditLog" rejection_audit
  ON rejection_audit."entityType" = 'Withdrawal'
 AND rejection_audit."entityId" = withdrawal."id"
 AND rejection_audit."action" = 'WITHDRAWAL_REJECTED'
 AND rejection_audit."userId" = withdrawal."rejectedBy"
WHERE withdrawal."status" = 'REJECTED'
  AND withdrawal."version" = 1
  AND withdrawal."currency" = 'USD'
  AND withdrawal."amount" > 0
  AND withdrawal."amount" * 100
    IS NOT DISTINCT FROM TRUNC(withdrawal."amount" * 100)
  AND withdrawal."requestedBy" IS NOT NULL
  AND withdrawal."approvedBy" IS NULL
  AND withdrawal."approvedAt" IS NULL
  AND withdrawal."rejectedBy" IS NOT NULL
  AND withdrawal."rejectedAt" IS NOT NULL
  AND withdrawal."reversedBy" IS NULL
  AND withdrawal."reversedAt" IS NULL
  AND balance."currency" = 'USD'
  AND balance."allocationCutoverAt" IS NOT NULL
  AND withdrawal."createdAt" < balance."allocationCutoverAt"
  AND withdrawal."rejectedAt" > balance."allocationCutoverAt"
  AND debit."type" = 'WITHDRAWAL'
  AND debit."amount" = -withdrawal."amount"
  AND debit."currency" = withdrawal."currency"
  AND debit."publisherId" = withdrawal."publisherId"
  AND debit."walletId" IS NULL
  AND debit."orderId" IS NULL
  AND debit."settlementId" IS NULL
  AND debit."provider" IS NULL
  AND debit."providerRef" IS NULL
  AND debit."createdAt" >= withdrawal."createdAt"
  AND debit."createdAt" < balance."allocationCutoverAt"
  AND reversal."type" = 'WITHDRAWAL_REVERSAL'
  AND reversal."amount" = withdrawal."amount"
  AND reversal."currency" = withdrawal."currency"
  AND reversal."publisherId" = withdrawal."publisherId"
  AND reversal."walletId" IS NULL
  AND reversal."orderId" IS NULL
  AND reversal."settlementId" IS NULL
  AND reversal."provider" IS NULL
  AND reversal."providerRef" IS NULL
  AND reversal."createdAt" > balance."allocationCutoverAt"
  AND reversal."createdAt" >= debit."createdAt"
  AND reversal."createdAt" <= withdrawal."rejectedAt"
  AND request_audit."createdAt" >= withdrawal."createdAt"
  AND request_audit."createdAt" < balance."allocationCutoverAt"
  AND rejection_audit."createdAt" = withdrawal."rejectedAt"
  AND (
    SELECT COUNT(*)
    FROM "Transaction" candidate_debit
    WHERE candidate_debit."reference" = 'withdrawal-' || withdrawal."id"
  ) = 1
  AND (
    SELECT COUNT(*)
    FROM "Transaction" candidate_reversal
    WHERE candidate_reversal."reference" =
      'withdrawal-reject-' || withdrawal."id"
  ) = 1
  AND (
    SELECT COUNT(*)
    FROM "AuditLog" candidate_request_audit
    WHERE candidate_request_audit."entityType" = 'Withdrawal'
      AND candidate_request_audit."entityId" = withdrawal."id"
      AND candidate_request_audit."action" = 'WITHDRAWAL_REQUESTED'
  ) = 1
  AND (
    SELECT COUNT(*)
    FROM "AuditLog" candidate_rejection_audit
    WHERE candidate_rejection_audit."entityType" = 'Withdrawal'
      AND candidate_rejection_audit."entityId" = withdrawal."id"
      AND candidate_rejection_audit."action" = 'WITHDRAWAL_REJECTED'
  ) = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "AuditLog" other_decision_audit
    WHERE other_decision_audit."entityType" = 'Withdrawal'
      AND other_decision_audit."entityId" = withdrawal."id"
      AND other_decision_audit."action" IN (
        'WITHDRAWAL_APPROVED',
        'WITHDRAWAL_REVERSED'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "PayoutExecution" execution
    WHERE execution."withdrawalId" = withdrawal."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "WithdrawalAllocation" allocation
    WHERE allocation."withdrawalId" = withdrawal."id"
  );

-- Every missing PENDING reservation and every missing allocation whose
-- rejection crossed the cutover must match one of the exact candidates above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Withdrawal" withdrawal
    WHERE withdrawal."status" = 'PENDING'
      AND NOT EXISTS (
        SELECT 1
        FROM "WithdrawalAllocation" allocation
        WHERE allocation."withdrawalId" = withdrawal."id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM legacy_withdrawal_repair_candidates candidate
        WHERE candidate.withdrawal_id = withdrawal."id"
          AND candidate.withdrawal_status = 'PENDING'
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill blocked: a pending reservation cannot be reconstructed exactly';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Withdrawal" withdrawal
    LEFT JOIN "PublisherBalance" balance
      ON balance."publisherId" = withdrawal."publisherId"
    WHERE withdrawal."status" = 'REJECTED'
      AND NOT EXISTS (
        SELECT 1
        FROM "WithdrawalAllocation" allocation
        WHERE allocation."withdrawalId" = withdrawal."id"
      )
      AND (
        balance."id" IS NULL
        OR balance."allocationCutoverAt" IS NULL
        OR withdrawal."createdAt" >= balance."allocationCutoverAt"
        OR withdrawal."rejectedAt" IS NULL
        OR withdrawal."rejectedAt" >= balance."allocationCutoverAt"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM legacy_withdrawal_repair_candidates candidate
        WHERE candidate.withdrawal_id = withdrawal."id"
          AND candidate.withdrawal_status = 'REJECTED'
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill blocked: a rejected reservation cannot be reconstructed exactly';
  END IF;
END
$$;

CREATE TEMP TABLE legacy_withdrawal_balance_before ON COMMIT DROP AS
SELECT
  balance."publisherId" AS publisher_id,
  balance."pendingBalance" AS pending_balance,
  balance."approvedBalance" AS approved_balance,
  balance."withdrawableBalance" AS withdrawable_balance,
  balance."debtBalance" AS debt_balance,
  balance."lifetimeEarnings" AS lifetime_earnings,
  balance."lifetimePaid" AS lifetime_paid,
  balance."allocationCarryForward" AS carry_forward,
  balance."allocationCarryForwardUsed" AS carry_forward_used,
  balance."version" AS balance_version
FROM "PublisherBalance" balance
WHERE balance."publisherId" IN (
  SELECT DISTINCT candidate.publisher_id
  FROM legacy_withdrawal_repair_candidates candidate
);

-- Runtime inserts must remain PENDING-only. The migration temporarily bypasses
-- exactly that one row-level trigger before creating either reconstruction so
-- PostgreSQL has no pending events on the relation at ALTER time. Currency,
-- FK, and deferred reservation guards remain enabled; table locks prevent
-- concurrent writers; transaction rollback restores the trigger if any
-- statement or postflight fails.
ALTER TABLE "WithdrawalAllocation"
  DISABLE TRIGGER "WithdrawalAllocation_evidence_guard";

-- PENDING rows are reconstructed as active evidence. Although the row-level
-- runtime guard is temporarily disabled, the normal deferred exact-coverage
-- guard and the postflight assertions below still validate them.
INSERT INTO "WithdrawalAllocation" (
  "id",
  "withdrawalId",
  "sourceType",
  "sourceTransactionId",
  "settlementId",
  "orderId",
  "amount",
  "currency",
  "sequence",
  "serviceType",
  "releasedAt",
  "createdAt"
)
SELECT
  'wa_legacy_' || md5(candidate.withdrawal_id),
  candidate.withdrawal_id,
  'CARRY_FORWARD',
  NULL,
  NULL,
  NULL,
  candidate.amount,
  candidate.currency,
  0,
  NULL,
  NULL,
  candidate.debit_created_at
FROM legacy_withdrawal_repair_candidates candidate
WHERE candidate.withdrawal_status = 'PENDING';

-- Already-released evidence cannot pass the runtime PENDING-only row guard,
-- but is permitted here only for the exact rejected candidates selected above.
INSERT INTO "WithdrawalAllocation" (
  "id",
  "withdrawalId",
  "sourceType",
  "sourceTransactionId",
  "settlementId",
  "orderId",
  "amount",
  "currency",
  "sequence",
  "serviceType",
  "releasedAt",
  "createdAt"
)
SELECT
  'wa_legacy_' || md5(candidate.withdrawal_id),
  candidate.withdrawal_id,
  'CARRY_FORWARD',
  NULL,
  NULL,
  NULL,
  candidate.amount,
  candidate.currency,
  0,
  NULL,
  candidate.released_at,
  candidate.debit_created_at
FROM legacy_withdrawal_repair_candidates candidate
WHERE candidate.withdrawal_status = 'REJECTED';

-- Flush the enabled deferred allocation guards before changing trigger state.
-- The PENDING reconstruction must have exact active coverage; the REJECTED
-- reconstruction is terminal and already fully released. Restore the runtime
-- guard immediately, then restore the transaction's deferred constraint mode.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "WithdrawalAllocation"
  ENABLE TRIGGER "WithdrawalAllocation_evidence_guard";

SET CONSTRAINTS ALL DEFERRED;

-- Adding the same amount to carry-forward and used for PENDING rows preserves
-- available carry. A proven post-cutover rejection adds only carry-forward,
-- matching the liability that its exact reversal restored. No balance or
-- lifetime-paid amount is changed.
WITH adjustments AS (
  SELECT
    candidate.publisher_id,
    SUM(candidate.amount) AS carry_forward_add,
    COALESCE(
      SUM(candidate.amount) FILTER (
        WHERE candidate.withdrawal_status = 'PENDING'
      ),
      0
    ) AS carry_forward_used_add
  FROM legacy_withdrawal_repair_candidates candidate
  GROUP BY candidate.publisher_id
)
UPDATE "PublisherBalance" balance
SET
  "allocationCarryForward" =
    balance."allocationCarryForward" + adjustments.carry_forward_add,
  "allocationCarryForwardUsed" =
    balance."allocationCarryForwardUsed" +
      adjustments.carry_forward_used_add,
  "version" = balance."version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
FROM adjustments
WHERE balance."publisherId" = adjustments.publisher_id;

-- Record that these rows were reconstructed by a system migration. The
-- original user and staff audits remain immutable and authoritative; no
-- synthetic human actor is introduced.
INSERT INTO "AuditLog" (
  "id",
  "action",
  "entityType",
  "entityId",
  "metadata",
  "userId",
  "organizationId",
  "createdAt"
)
SELECT
  'audit_legacy_wa_' || md5(candidate.withdrawal_id),
  'LEGACY_WITHDRAWAL_RESERVATION_RECONSTRUCTED',
  'Withdrawal',
  candidate.withdrawal_id,
  jsonb_build_object(
    'migration',
      '20260802097000_legacy_withdrawal_reservation_evidence',
    'allocationId', 'wa_legacy_' || md5(candidate.withdrawal_id),
    'publisherId', candidate.publisher_id,
    'withdrawalStatus', candidate.withdrawal_status,
    'debitTransactionId', candidate.debit_transaction_id,
    'reversalTransactionId', candidate.reversal_transaction_id,
    'carryForwardAdded', candidate.amount,
    'carryForwardUsedAdded',
      CASE
        WHEN candidate.withdrawal_status = 'PENDING' THEN candidate.amount
        ELSE 0
      END,
    'evidenceClass',
      CASE
        WHEN candidate.withdrawal_status = 'PENDING'
          THEN 'PRE_CUTOVER_REQUEST_DEBIT'
        ELSE 'PRE_CUTOVER_DEBIT_POST_CUTOVER_EXACT_REVERSAL'
      END
  ),
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM legacy_withdrawal_repair_candidates candidate;

-- Assert both the narrow repair result and every balance field that this
-- migration is forbidden to change.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM legacy_withdrawal_repair_candidates candidate
    LEFT JOIN "WithdrawalAllocation" allocation
      ON allocation."withdrawalId" = candidate.withdrawal_id
    GROUP BY
      candidate.withdrawal_id,
      candidate.amount,
      candidate.currency,
      candidate.withdrawal_status
    HAVING COUNT(allocation."id") <> 1
      OR COALESCE(SUM(allocation."amount"), 0)
        IS DISTINCT FROM candidate.amount
      OR COUNT(*) FILTER (
        WHERE allocation."currency" IS DISTINCT FROM candidate.currency
          OR allocation."sourceType" IS DISTINCT FROM 'CARRY_FORWARD'
          OR allocation."sourceTransactionId" IS NOT NULL
      ) <> 0
      OR (
        candidate.withdrawal_status = 'PENDING'
        AND COUNT(*) FILTER (
          WHERE allocation."releasedAt" IS NULL
        ) <> 1
      )
      OR (
        candidate.withdrawal_status = 'REJECTED'
        AND COUNT(*) FILTER (
          WHERE allocation."releasedAt" IS NOT DISTINCT FROM candidate.released_at
        ) <> 1
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill postflight failed: reconstructed evidence is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM legacy_withdrawal_balance_before before_state
    JOIN "PublisherBalance" balance
      ON balance."publisherId" = before_state.publisher_id
    JOIN LATERAL (
      SELECT
        SUM(candidate.amount) AS carry_forward_add,
        COALESCE(
          SUM(candidate.amount) FILTER (
            WHERE candidate.withdrawal_status = 'PENDING'
          ),
          0
        ) AS carry_forward_used_add
      FROM legacy_withdrawal_repair_candidates candidate
      WHERE candidate.publisher_id = before_state.publisher_id
    ) adjustment ON TRUE
    WHERE balance."pendingBalance" IS DISTINCT FROM before_state.pending_balance
       OR balance."approvedBalance" IS DISTINCT FROM before_state.approved_balance
       OR balance."withdrawableBalance" IS DISTINCT FROM before_state.withdrawable_balance
       OR balance."debtBalance" IS DISTINCT FROM before_state.debt_balance
       OR balance."lifetimeEarnings" IS DISTINCT FROM before_state.lifetime_earnings
       OR balance."lifetimePaid" IS DISTINCT FROM before_state.lifetime_paid
       OR balance."allocationCarryForward" IS DISTINCT FROM
          before_state.carry_forward + adjustment.carry_forward_add
       OR balance."allocationCarryForwardUsed" IS DISTINCT FROM
          before_state.carry_forward_used + adjustment.carry_forward_used_add
       OR balance."version" <> before_state.balance_version + 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill postflight failed: publisher balance mutation escaped its evidence delta';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PublisherBalance" balance
    LEFT JOIN "Withdrawal" withdrawal
      ON withdrawal."publisherId" = balance."publisherId"
    LEFT JOIN "WithdrawalAllocation" allocation
      ON allocation."withdrawalId" = withdrawal."id"
    GROUP BY balance."publisherId", balance."allocationCarryForwardUsed"
    HAVING balance."allocationCarryForwardUsed" IS DISTINCT FROM COALESCE(
      SUM(allocation."amount") FILTER (
        WHERE allocation."releasedAt" IS NULL
          AND allocation."sourceType" = 'CARRY_FORWARD'
      ),
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill postflight failed: carry-forward usage does not equal active evidence';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = '"WithdrawalAllocation"'::regclass
      AND tgname = 'WithdrawalAllocation_evidence_guard'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy withdrawal allocation backfill postflight failed: allocation evidence guard is not enabled';
  END IF;
END
$$;

COMMIT;
