-- Assertions for the populated finance migration rehearsal.

\set ON_ERROR_STOP on

DO $$
DECLARE
  dispute_constraint_validated BOOLEAN;
  dispute_event_status TEXT;
  dispute_event_error TEXT;
  completed_source TEXT;
  cancelled_source TEXT;
  failed_stage TEXT;
  ambiguous_stage TEXT;
  requester_count INTEGER;
  claim_guard_count INTEGER;
  wallet_withdrawal_count INTEGER;
  backfilled_balance_count INTEGER;
  backfilled_wallet_count INTEGER;
BEGIN
  SELECT convalidated
    INTO dispute_constraint_validated
    FROM pg_constraint
   WHERE conname = 'PaymentProviderEvent_dispute_facts_check';
  IF dispute_constraint_validated IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'PaymentProviderEvent_dispute_facts_check is not validated';
  END IF;

  SELECT status::TEXT, "lastError"
    INTO dispute_event_status, dispute_event_error
    FROM "PaymentProviderEvent"
   WHERE id = 'migration-rehearsal-dispute-event';
  IF dispute_event_status IS DISTINCT FROM 'QUARANTINED'
     OR dispute_event_error IS DISTINCT FROM 'LEGACY_DISPUTE_FACTS_UNVERIFIED'
  THEN
    RAISE EXCEPTION
      'Legacy dispute evidence was not honestly quarantined';
  END IF;

  SELECT "completionSource"::TEXT
    INTO completed_source
    FROM "PayoutExecution"
   WHERE id = 'migration-rehearsal-execution-completed';
  IF completed_source IS DISTINCT FROM 'LEGACY_UNVERIFIED' THEN
    RAISE EXCEPTION
      'Historical completed payout did not retain legacy-unverified provenance';
  END IF;

  SELECT "cancellationSource"::TEXT
    INTO cancelled_source
    FROM "PayoutExecution"
   WHERE id = 'migration-rehearsal-execution-cancelled';
  IF cancelled_source IS DISTINCT FROM 'LEGACY_UNVERIFIED' THEN
    RAISE EXCEPTION
      'Historical cancelled payout did not retain legacy-unverified provenance';
  END IF;

  SELECT stage
    INTO failed_stage
    FROM "PayoutExecution"
   WHERE id = 'migration-rehearsal-execution-failed';
  IF failed_stage IS DISTINCT FROM 'LEGACY_PROVIDER_OUTCOME_UNKNOWN' THEN
    RAISE EXCEPTION
      'Historical failed payout with an ambiguous provider outcome was not quarantined';
  END IF;

  SELECT stage
    INTO ambiguous_stage
    FROM "PayoutExecution"
   WHERE id = 'migration-rehearsal-execution-ambiguous';
  IF ambiguous_stage IS DISTINCT FROM 'LEGACY_PROVIDER_OUTCOME_UNKNOWN' THEN
    RAISE EXCEPTION
      'Historical pending payout with an ambiguous provider outcome was not quarantined';
  END IF;

  SELECT COUNT(*)
    INTO requester_count
    FROM "Withdrawal"
   WHERE id LIKE 'migration-rehearsal-withdrawal-%'
     AND "requestedBy" = 'migration-rehearsal-publisher-owner';
  IF requester_count <> 4 THEN
    RAISE EXCEPTION
      'Historical withdrawal requester provenance did not backfill exactly';
  END IF;

  SELECT COUNT(*)
    INTO claim_guard_count
    FROM pg_trigger
   WHERE tgname IN (
     'PayoutExecutionClaim_authority_guard',
     'PayoutExecutionClaim_stage_commit_guard',
     'PayoutExecution_identity_guard',
     'Withdrawal_financial_provenance_guard'
   )
     AND NOT tgisinternal;
  IF claim_guard_count <> 4 THEN
    RAISE EXCEPTION
      'Required payout/withdrawal authority triggers are not installed';
  END IF;

  SELECT COUNT(*)
    INTO wallet_withdrawal_count
    FROM "Transaction"
   WHERE id = 'migration-rehearsal-wallet-withdrawal'
     AND type = 'WITHDRAWAL'
     AND "walletId" = 'migration-rehearsal-wallet';
  IF wallet_withdrawal_count <> 1 THEN
    RAISE EXCEPTION
      'Historical customer wallet cash-out evidence was not preserved';
  END IF;

  SELECT COUNT(*)
    INTO backfilled_balance_count
    FROM "PublisherBalance"
   WHERE "publisherId" = 'migration-rehearsal-empty-publisher'
     AND "pendingBalance" = 0
     AND "approvedBalance" = 0
     AND "withdrawableBalance" = 0
     AND "debtBalance" = 0
     AND "lifetimeEarnings" = 0
     AND "lifetimePaid" = 0;
  IF backfilled_balance_count <> 1 THEN
    RAISE EXCEPTION
      'History-free publisher balance aggregate was not backfilled exactly';
  END IF;

  SELECT COUNT(*)
    INTO backfilled_wallet_count
    FROM "Wallet"
   WHERE "organizationId" = 'migration-rehearsal-empty-org'
     AND "availableBalance" = 0
     AND "reservedBalance" = 0
     AND currency = 'USD';
  IF backfilled_wallet_count <> 1 THEN
    RAISE EXCEPTION
      'History-free organization wallet aggregate was not backfilled exactly';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "description",
      "walletId", "createdAt"
    ) VALUES (
      'migration-rehearsal-new-wallet-withdrawal',
      -1,
      'USD',
      'WITHDRAWAL',
      'migration-rehearsal-new-wallet-withdrawal',
      'This write must be rejected',
      'migration-rehearsal-wallet',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION
      'Customer wallet cash-out retirement trigger accepted a new write';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    DELETE FROM "PayoutExecutionClaim"
     WHERE id = 'nonexistent-claim';
    -- A statement-level no-op cannot exercise a row trigger. Trigger presence
    -- is asserted above; real-row deletion is covered by the PostgreSQL suite.
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END;
$$;
