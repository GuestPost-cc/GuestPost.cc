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
  deposit_failure_constraint_validated BOOLEAN;
  legacy_deposit_failure_code TEXT;
  rejection_constraint TEXT;
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
  IF requester_count <> 6 THEN
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

  SELECT convalidated
    INTO deposit_failure_constraint_validated
    FROM pg_constraint
   WHERE conrelid = '"DepositAttempt"'::regclass
     AND conname = 'DepositAttempt_failure_evidence_check';
  IF deposit_failure_constraint_validated IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'DepositAttempt_failure_evidence_check is missing or not validated';
  END IF;

  SELECT "failureCode"::TEXT
    INTO legacy_deposit_failure_code
    FROM "DepositAttempt"
   WHERE id = 'migration-rehearsal-failed-deposit-attempt';
  IF legacy_deposit_failure_code IS DISTINCT FROM 'LEGACY_UNCLASSIFIED' THEN
    RAISE EXCEPTION
      'Historical failed deposit did not retain an honest legacy classification';
  END IF;

  BEGIN
    UPDATE "DepositAttempt"
       SET "failureCode" = NULL
     WHERE id = 'migration-rehearsal-failed-deposit-attempt';
    RAISE EXCEPTION 'FAILED DepositAttempt accepted missing failure evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM
         'DepositAttempt_failure_evidence_check' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "DepositAttempt"
       SET "failureCode" = 'PROVIDER_UNAVAILABLE'
     WHERE id = 'migration-rehearsal-deposit-attempt';
    RAISE EXCEPTION
      'Non-failed DepositAttempt accepted contradictory failure evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM
         'DepositAttempt_failure_evidence_check' THEN
        RAISE;
      END IF;
  END;
END;
$$;

-- Migration 0970 may reconstruct only exact pre-provider reservation and
-- post-cutover rejection evidence. Its balance deltas must preserve every
-- spendable/lifetime amount while closing the carry-forward source gap.
DO $$
DECLARE
  pending_allocation_count INTEGER;
  rejected_allocation_count INTEGER;
  reconstruction_audit_count INTEGER;
  repaired_withdrawable NUMERIC;
  repaired_carry_forward NUMERIC;
  repaired_carry_used NUMERIC;
  active_carry_allocations NUMERIC;
  allocation_guard_enabled "char";
BEGIN
  SELECT COUNT(*)
    INTO pending_allocation_count
    FROM "WithdrawalAllocation"
   WHERE "withdrawalId" =
       'migration-rehearsal-withdrawal-pending-reserved'
     AND "sourceType" = 'CARRY_FORWARD'
     AND "sourceTransactionId" IS NULL
     AND amount = 25
     AND currency = 'USD'
     AND sequence = 0
     AND "releasedAt" IS NULL;
  IF pending_allocation_count <> 1 THEN
    RAISE EXCEPTION
      'Exact legacy pending withdrawal reservation was not reconstructed';
  END IF;

  SELECT COUNT(*)
    INTO rejected_allocation_count
    FROM "WithdrawalAllocation"
   WHERE "withdrawalId" =
       'migration-rehearsal-withdrawal-rejected-reserved'
     AND "sourceType" = 'CARRY_FORWARD'
     AND "sourceTransactionId" IS NULL
     AND amount = 25
     AND currency = 'USD'
     AND sequence = 0
     AND "releasedAt" = (
       SELECT "rejectedAt"
       FROM "Withdrawal"
       WHERE id = 'migration-rehearsal-withdrawal-rejected-reserved'
     );
  IF rejected_allocation_count <> 1 THEN
    RAISE EXCEPTION
      'Exact legacy rejected withdrawal reservation was not reconstructed';
  END IF;

  SELECT
    "withdrawableBalance",
    "allocationCarryForward",
    "allocationCarryForwardUsed"
  INTO
    repaired_withdrawable,
    repaired_carry_forward,
    repaired_carry_used
  FROM "PublisherBalance"
  WHERE "publisherId" = 'migration-rehearsal-publisher';
  IF repaired_withdrawable IS DISTINCT FROM 65
    OR repaired_carry_forward IS DISTINCT FROM 90
    OR repaired_carry_used IS DISTINCT FROM 25
    OR repaired_carry_forward - repaired_carry_used
      IS DISTINCT FROM repaired_withdrawable THEN
    RAISE EXCEPTION
      'Legacy withdrawal repair changed money or left carry-forward drift';
  END IF;

  SELECT COALESCE(SUM(allocation.amount), 0)
    INTO active_carry_allocations
    FROM "WithdrawalAllocation" allocation
    JOIN "Withdrawal" withdrawal
      ON withdrawal.id = allocation."withdrawalId"
   WHERE withdrawal."publisherId" = 'migration-rehearsal-publisher'
     AND allocation."sourceType" = 'CARRY_FORWARD'
     AND allocation."releasedAt" IS NULL;
  IF active_carry_allocations IS DISTINCT FROM repaired_carry_used THEN
    RAISE EXCEPTION
      'Active carry-forward evidence does not match aggregate usage';
  END IF;

  SELECT COUNT(*)
    INTO reconstruction_audit_count
    FROM "AuditLog"
   WHERE action = 'LEGACY_WITHDRAWAL_RESERVATION_RECONSTRUCTED'
     AND "entityType" = 'Withdrawal'
     AND "entityId" IN (
       'migration-rehearsal-withdrawal-pending-reserved',
       'migration-rehearsal-withdrawal-rejected-reserved'
     )
     AND "userId" IS NULL
     AND metadata->>'migration' =
       '20260802097000_legacy_withdrawal_reservation_evidence';
  IF reconstruction_audit_count <> 2 THEN
    RAISE EXCEPTION
      'Legacy withdrawal reconstruction system audits are missing';
  END IF;

  SELECT tgenabled
    INTO allocation_guard_enabled
    FROM pg_trigger
   WHERE tgrelid = '"WithdrawalAllocation"'::regclass
     AND tgname = 'WithdrawalAllocation_evidence_guard'
     AND NOT tgisinternal;
  IF allocation_guard_enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION
      'WithdrawalAllocation evidence guard was not restored';
  END IF;
END;
$$;

-- Platform-owned revenue recognition carries the same eligibility gate and
-- exact financial evidence as publisher settlement, but creates no publisher
-- liability. Exercise the direct-SQL path under the initial v1 / 20% policy;
-- the later policy-change control also proves this snapshot does not rewrite.
DO $$
DECLARE
  rejection_message TEXT;
  recognized_at TIMESTAMP;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'PlatformRevenue_evidence_guard'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"PlatformRevenue"'::regclass
      AND conname = 'PlatformRevenue_amount_split_check'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"PlatformRevenue"'::regclass
      AND conname = 'PlatformRevenue_fee_policy_snapshot_check'
      AND convalidated
  ) THEN
    RAISE EXCEPTION
      'PlatformRevenue financial evidence trigger/constraints are missing';
  END IF;

  -- A post-hardening PLATFORM order must originate from its own approved,
  -- verified catalog chain. Reusing the publisher-owned metrics listing would
  -- make the fixture itself violate the immutable fulfillment snapshot.
  INSERT INTO "Website" (
    "id", "url", "domain", "name", "metrics", "isActive",
    "ownershipType", "verificationStatus", "canonicalDomain", "createdAt",
    "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-website',
    'https://platform-revenue-rehearsal.invalid',
    'platform-revenue-rehearsal.invalid',
    'Platform Revenue Rehearsal',
    '{}'::jsonb,
    TRUE,
    'PLATFORM',
    'VERIFIED',
    'platform-revenue-rehearsal.invalid',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "MarketplaceListing" (
    "id", "title", "slug", "description", "status", "fulfillmentType",
    "ownerType", "currency", "websiteUrl", "websiteId", "organizationId",
    "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-listing',
    'Platform revenue rehearsal listing',
    'migration-rehearsal-platform-revenue-listing',
    'Approved platform-owned catalog evidence for revenue rehearsal',
    'APPROVED',
    'INTERNAL',
    'PLATFORM',
    'USD',
    'https://platform-revenue-rehearsal.invalid',
    'migration-rehearsal-platform-revenue-website',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "ListingService" (
    "id", "listingId", "serviceType", "price", "currency",
    "turnaroundDays", "revisionRounds", "availability", "createdAt",
    "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-service',
    'migration-rehearsal-platform-revenue-listing',
    'GUEST_POST',
    120,
    'USD',
    3,
    2,
    'AVAILABLE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "Order" (
    "id", "type", "status", "amount", "currency", "paymentStatus", "title",
    "customerId", "websiteId", "organizationId", "version", "listingId",
    "listingServiceId", "revisionRoundsSnapshot", "turnaroundDays",
    "fulfillmentChannel", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-order',
    'GUEST_POST',
    'DRAFT',
    120,
    'USD',
    'PENDING',
    'Migration rehearsal platform revenue order',
    'migration-rehearsal-publisher-owner',
    'migration-rehearsal-platform-revenue-website',
    'migration-rehearsal-org',
    0,
    'migration-rehearsal-platform-revenue-listing',
    'migration-rehearsal-platform-revenue-service',
    2,
    3,
    'PLATFORM',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "OrderItem" (
    "id", "orderId", "websiteId", "price", "status", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-item',
    'migration-rehearsal-platform-revenue-order',
    'migration-rehearsal-platform-revenue-website',
    120,
    'PENDING_PAYMENT',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "OrderDeliveryVersion" (
    "id", "orderId", "version", "publishedUrl", "normalizedUrl",
    "submittedByUserId", "submittedAt", "verificationStatus",
    "interventionStatus", "verificationVersion", "createdAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-delivery',
    'migration-rehearsal-platform-revenue-order',
    1,
    'https://metrics-rehearsal.invalid/platform-revenue-article',
    'https://metrics-rehearsal.invalid/platform-revenue-article',
    'migration-rehearsal-publisher-owner',
    CURRENT_TIMESTAMP,
    'VERIFIED',
    'NONE',
    1,
    CURRENT_TIMESTAMP
  );

  UPDATE "Order"
     SET "status" = 'DELIVERED',
         "paymentStatus" = 'PAID',
         "activeDeliveryVersionId" =
           'migration-rehearsal-platform-revenue-delivery',
         "version" = 1,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-platform-revenue-order';

  BEGIN
    INSERT INTO "PlatformRevenue" (
      "id", "orderId", "amount", "currency", "platformFee", "netRevenue",
      "platformFeeBps", "feePolicyVersion", "fulfillmentChannel",
      "recordedAt", "createdAt"
    ) VALUES (
      'migration-rehearsal-platform-revenue-missing-purchase',
      'migration-rehearsal-platform-revenue-order',
      120,
      'USD',
      24,
      96,
      2000,
      'platform-settings:platform-settings-default:v1',
      'PLATFORM',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PlatformRevenue accepted missing PURCHASE evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue requires exact canonical purchase evidence' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "Transaction" (
    "id", "amount", "currency", "type", "reference", "walletId",
    "orderId", "createdAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-purchase',
    -120,
    'USD',
    'PURCHASE',
    'order:migration-rehearsal-platform-revenue-order',
    'migration-rehearsal-organization-wallet',
    'migration-rehearsal-platform-revenue-order',
    CURRENT_TIMESTAMP
  );

  INSERT INTO "Revision" (
    "id", "notes", "status", "orderId", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue-revision',
    'Direct-SQL blocker parity check',
    'REQUESTED',
    'migration-rehearsal-platform-revenue-order',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );
  BEGIN
    INSERT INTO "PlatformRevenue" (
      "id", "orderId", "amount", "currency", "platformFee", "netRevenue",
      "platformFeeBps", "feePolicyVersion", "fulfillmentChannel",
      "recordedAt", "createdAt"
    ) VALUES (
      'migration-rehearsal-platform-revenue-active-revision',
      'migration-rehearsal-platform-revenue-order',
      120,
      'USD',
      24,
      96,
      2000,
      'platform-settings:platform-settings-default:v1',
      'PLATFORM',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PlatformRevenue bypassed an active revision';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue eligibility blocked: active revision' THEN
        RAISE;
      END IF;
  END;
  UPDATE "Revision"
     SET "status" = 'REJECTED', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-platform-revenue-revision';

  BEGIN
    INSERT INTO "PlatformRevenue" (
      "id", "orderId", "amount", "currency", "platformFee", "netRevenue",
      "fulfillmentChannel", "recordedAt", "createdAt"
    ) VALUES (
      'migration-rehearsal-platform-revenue-missing-policy',
      'migration-rehearsal-platform-revenue-order',
      120,
      'USD',
      24,
      96,
      'PLATFORM',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PlatformRevenue accepted missing fee-policy evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue fee split lacks the active versioned policy' THEN
        RAISE;
      END IF;
  END;

  recognized_at := CURRENT_TIMESTAMP;
  INSERT INTO "PlatformRevenue" (
    "id", "orderId", "amount", "currency", "platformFee", "netRevenue",
    "platformFeeBps", "feePolicyVersion", "fulfillmentChannel",
    "recordedAt", "createdAt"
  ) VALUES (
    'migration-rehearsal-platform-revenue',
    'migration-rehearsal-platform-revenue-order',
    120,
    'USD',
    24,
    96,
    2000,
    'platform-settings:platform-settings-default:v1',
    'PLATFORM',
    recognized_at,
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "PlatformRevenue"
       SET "platformFee" = 24.20,
           "netRevenue" = 95.80
     WHERE "id" = 'migration-rehearsal-platform-revenue';
    RAISE EXCEPTION 'PlatformRevenue accepted financial identity mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue financial identity and policy evidence are immutable' THEN
        RAISE;
      END IF;
  END;

  UPDATE "PlatformRevenue"
     SET "reversedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-platform-revenue';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PlatformRevenue reversal positive control found no row';
  END IF;

  BEGIN
    UPDATE "PlatformRevenue"
       SET "reversedAt" = "reversedAt" + INTERVAL '1 second'
     WHERE "id" = 'migration-rehearsal-platform-revenue';
    RAISE EXCEPTION 'PlatformRevenue reversal evidence changed twice';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue reversal evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "PlatformRevenue"
     WHERE "id" = 'migration-rehearsal-platform-revenue';
    RAISE EXCEPTION 'PlatformRevenue evidence was deleted';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform revenue evidence is append-only; reverse it instead of deleting it' THEN
        RAISE;
      END IF;
  END;
END;
$$;

-- Catalog and cart money stays positive, exact to USD minor units, and cart
-- identity becomes immutable at the payment boundary.
DO $$
DECLARE
  constraint_count INTEGER;
  trigger_count INTEGER;
  rejection_message TEXT;
BEGIN
  SELECT COUNT(*)
    INTO constraint_count
    FROM pg_constraint
   WHERE conname IN (
     'ListingService_price_usd_minor_unit_check',
     'Order_amount_usd_minor_unit_check',
     'OrderItem_price_usd_minor_unit_check'
   )
     AND convalidated;
  IF constraint_count <> 3 THEN
    RAISE EXCEPTION
      'USD catalog/order minor-unit constraints are missing or unvalidated';
  END IF;

  SELECT COUNT(*)
    INTO trigger_count
    FROM pg_trigger
   WHERE tgname IN (
     'Order_capture_items_guard',
     'OrderItem_financial_identity_guard',
     'Order_purchase_evidence_commit_guard',
     'Transaction_purchase_order_state_commit_guard'
   )
     AND NOT tgisinternal;
  IF trigger_count <> 4 THEN
    RAISE EXCEPTION
      'Order capture/item/purchase financial triggers are not installed';
  END IF;

  BEGIN
    INSERT INTO "ListingService" (
      "id", "listingId", "serviceType", "price", "currency",
      "turnaroundDays", "updatedAt"
    ) VALUES (
      'migration-rehearsal-zero-price-service',
      'migration-rehearsal-metrics-listing',
      'LOCAL_CITATION',
      0,
      'USD',
      1,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ListingService accepted a zero price';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO "ListingService" (
    "id", "listingId", "serviceType", "price", "currency",
    "turnaroundDays", "revisionRounds", "availability", "updatedAt"
  ) VALUES (
    'migration-rehearsal-cart-guard-service',
    'migration-rehearsal-metrics-listing',
    'LOCAL_CITATION',
    10,
    'USD',
    1,
    2,
    'AVAILABLE',
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "ListingService" (
      "id", "listingId", "serviceType", "price", "currency",
      "turnaroundDays", "updatedAt"
    ) VALUES (
      'migration-rehearsal-subcent-price-service',
      'migration-rehearsal-metrics-listing',
      'FOUNDATION_LINK',
      1.001,
      'USD',
      1,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ListingService accepted a sub-cent price';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO "Order" (
      "id", "type", "amount", "currency", "customerId",
      "organizationId", "updatedAt"
    ) VALUES (
      'migration-rehearsal-zero-amount-order',
      'GUEST_POST',
      0,
      'USD',
      'migration-rehearsal-publisher-owner',
      'migration-rehearsal-org',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted a zero amount';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO "Order" (
      "id", "type", "amount", "currency", "customerId",
      "organizationId", "updatedAt"
    ) VALUES (
      'migration-rehearsal-subcent-amount-order',
      'GUEST_POST',
      1.001,
      'USD',
      'migration-rehearsal-publisher-owner',
      'migration-rehearsal-org',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted a sub-cent amount';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO "Order" (
    "id", "type", "status", "amount", "currency", "paymentStatus",
    "customerId", "organizationId", "updatedAt"
  ) VALUES (
    'migration-rehearsal-unattributed-cart-order',
    'GUEST_POST',
    'DRAFT',
    10,
    'USD',
    'PENDING',
    'migration-rehearsal-publisher-owner',
    'migration-rehearsal-org',
    CURRENT_TIMESTAMP
  );
  INSERT INTO "OrderItem" (
    "id", "orderId", "websiteId", "price", "status", "updatedAt"
  ) VALUES (
    'migration-rehearsal-unattributed-cart-item',
    'migration-rehearsal-unattributed-cart-order',
    NULL,
    10,
    'PENDING_PAYMENT',
    CURRENT_TIMESTAMP
  );
  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-unattributed-cart-order';
    RAISE EXCEPTION 'Order capture accepted null parent and item websites';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order capture requires exact pending item total and website identity' THEN
        RAISE;
      END IF;
  END;
  DELETE FROM "OrderItem"
   WHERE "id" = 'migration-rehearsal-unattributed-cart-item';
  DELETE FROM "Order"
   WHERE "id" = 'migration-rehearsal-unattributed-cart-order';

  INSERT INTO "Order" (
    "id", "type", "status", "amount", "currency", "paymentStatus",
    "customerId", "websiteId", "organizationId", "listingId",
    "listingServiceId", "fulfillmentChannel", "turnaroundDays",
    "revisionRoundsSnapshot", "updatedAt"
  ) VALUES (
    'migration-rehearsal-cart-guard-order',
    'LOCAL_CITATION',
    'DRAFT',
    10,
    'USD',
    'PENDING',
    'migration-rehearsal-publisher-owner',
    'migration-rehearsal-metrics-website',
    'migration-rehearsal-org',
    'migration-rehearsal-metrics-listing',
    'migration-rehearsal-cart-guard-service',
    'PUBLISHER',
    1,
    2,
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "orderId", "websiteId", "price", "status", "updatedAt"
    ) VALUES (
      'migration-rehearsal-zero-price-item',
      'migration-rehearsal-cart-guard-order',
      'migration-rehearsal-metrics-website',
      0,
      'PENDING_PAYMENT',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'OrderItem accepted a zero price';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "orderId", "websiteId", "price", "status", "updatedAt"
    ) VALUES (
      'migration-rehearsal-subcent-price-item',
      'migration-rehearsal-cart-guard-order',
      'migration-rehearsal-metrics-website',
      1.001,
      'PENDING_PAYMENT',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'OrderItem accepted a sub-cent price';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO "OrderItem" (
    "id", "orderId", "websiteId", "price", "status", "updatedAt"
  ) VALUES (
    'migration-rehearsal-cart-guard-item',
    'migration-rehearsal-cart-guard-order',
    'migration-rehearsal-metrics-website',
    9,
    'PENDING_PAYMENT',
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-cart-guard-order';
    RAISE EXCEPTION 'Order capture accepted a mismatched item total';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order capture requires exact pending item total and website identity' THEN
        RAISE;
      END IF;
  END;

  UPDATE "OrderItem"
     SET "price" = 10,
         "status" = 'DRAFT',
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-cart-guard-item';
  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-cart-guard-order';
    RAISE EXCEPTION 'Order capture accepted a non-pending item';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order capture requires exact pending item total and website identity' THEN
        RAISE;
      END IF;
  END;

  UPDATE "OrderItem"
     SET "status" = 'PENDING_PAYMENT',
         "websiteId" = NULL,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-cart-guard-item';
  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-cart-guard-order';
    RAISE EXCEPTION 'Order capture accepted a mismatched item website';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order capture requires exact pending item total and website identity' THEN
        RAISE;
      END IF;
  END;

  UPDATE "OrderItem"
     SET "websiteId" = 'migration-rehearsal-metrics-website',
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-cart-guard-item';

  UPDATE "MarketplaceListing"
     SET "status" = 'PAUSED', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-metrics-listing';
  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-cart-guard-order';
    RAISE EXCEPTION 'Order capture accepted a paused marketplace listing';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order capture requires an approved verified catalog contract' THEN
        RAISE;
      END IF;
  END;
  UPDATE "MarketplaceListing"
     SET "status" = 'APPROVED', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-metrics-listing';

  -- Item and catalog facts are exact now, but capture still cannot commit
  -- without the matching organization-wallet PURCHASE in the same tx.
  BEGIN
    UPDATE "Order"
       SET "paymentStatus" = 'PAID', "status" = 'PAID'
     WHERE "id" = 'migration-rehearsal-cart-guard-order';
    SET CONSTRAINTS "Order_purchase_evidence_commit_guard" IMMEDIATE;
    RAISE EXCEPTION 'Order capture committed without PURCHASE evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'captured order requires exactly one matching purchase ledger row' THEN
        RAISE;
      END IF;
  END;
  SET CONSTRAINTS "Order_purchase_evidence_commit_guard" DEFERRED;

  BEGIN
    UPDATE "OrderItem"
       SET "price" = 11, "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'migration-rehearsal-settlement-item';
    RAISE EXCEPTION 'Paid OrderItem accepted price mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order item identity is immutable after payment capture' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "OrderItem"
     WHERE "id" = 'migration-rehearsal-settlement-item';
    RAISE EXCEPTION 'Paid OrderItem accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order item identity is immutable after payment capture' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "OrderItem" (
      "id", "orderId", "websiteId", "price", "status", "updatedAt"
    ) VALUES (
      'migration-rehearsal-late-cart-item',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-metrics-website',
      100,
      'PENDING_PAYMENT',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Paid Order accepted a late item';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order item identity is immutable after payment capture' THEN
        RAISE;
      END IF;
  END;

  -- The cart stayed unpaid because the no-PURCHASE transition rolled back.
  DELETE FROM "OrderItem"
   WHERE "id" = 'migration-rehearsal-cart-guard-item';
  DELETE FROM "Order"
   WHERE "id" = 'migration-rehearsal-cart-guard-order';
  DELETE FROM "ListingService"
   WHERE "id" = 'migration-rehearsal-cart-guard-service';
END;
$$;

-- Every Google write surface stays closed after the migration. The matched
-- BING operations below are positive controls: the quarantine is provider-
-- scoped, not an accidental global integration outage.
DO $$
DECLARE
  identity_rejection_message TEXT;
BEGIN
  BEGIN
    UPDATE "IntegrationSchedule"
       SET "enabled" = TRUE
     WHERE "id" = 'migration-rehearsal-google-schedule';
    RAISE EXCEPTION 'Google schedule quarantine accepted an enabled schedule';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    UPDATE "WebsiteIntegration"
       SET "status" = 'CONNECTED'
     WHERE "id" = 'migration-rehearsal-google-link';
    RAISE EXCEPTION 'Google link quarantine accepted a connected link';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "IntegrationSync" (
      "id", "integrationId", "websiteIntegrationId", "jobType", "status",
      "trigger", "startedAt"
    ) VALUES (
      'migration-rehearsal-rejected-google-sync',
      'migration-rehearsal-google-integration',
      'migration-rehearsal-google-link',
      'SYNC',
      'PENDING',
      'MANUAL',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Google sync quarantine accepted a new sync';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "IntegrationDiscovery" (
      "id", "integrationId", "status", "startedAt"
    ) VALUES (
      'migration-rehearsal-rejected-google-discovery',
      'migration-rehearsal-google-integration',
      'PENDING',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Google discovery quarantine accepted a new discovery';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "WebsiteSearchDaily" (
      "id", "websiteId", "sourceIntegrationId", "date", "clicks",
      "impressions", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-google-search-daily',
      'migration-rehearsal-metrics-website',
      'migration-rehearsal-google-link',
      CURRENT_DATE - 2,
      1,
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Google daily metric quarantine accepted a new row';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    UPDATE "WebsitePageSearchDaily"
       SET "clicks" = "clicks" + 1
     WHERE "id" = 'migration-rehearsal-google-page-daily';
    RAISE EXCEPTION 'Google page metric quarantine accepted an update';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    UPDATE "WebsiteAnalyticsDaily"
       SET "sessions" = "sessions" + 1
     WHERE "id" = 'migration-rehearsal-google-analytics-daily';
    RAISE EXCEPTION 'Google analytics metric quarantine accepted an update';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  UPDATE "IntegrationSchedule"
     SET "intervalMinutes" = 1439,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-bing-schedule';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BING schedule positive control did not find its row';
  END IF;

  UPDATE "WebsiteIntegration"
     SET "syncedAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-bing-link';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BING link positive control did not find its row';
  END IF;

  INSERT INTO "IntegrationSync" (
    "id", "integrationId", "websiteIntegrationId", "jobType", "status",
    "trigger", "startedAt"
  ) VALUES (
    'migration-rehearsal-allowed-bing-sync',
    'migration-rehearsal-bing-integration',
    'migration-rehearsal-bing-link',
    'SYNC',
    'PENDING',
    'MANUAL',
    CURRENT_TIMESTAMP
  );

  INSERT INTO "IntegrationDiscovery" (
    "id", "integrationId", "status", "startedAt"
  ) VALUES (
    'migration-rehearsal-allowed-bing-discovery',
    'migration-rehearsal-bing-integration',
    'PENDING',
    CURRENT_TIMESTAMP
  );

  INSERT INTO "WebsiteSearchDaily" (
    "id", "websiteId", "sourceIntegrationId", "date", "clicks",
    "impressions", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-allowed-bing-search-daily',
    'migration-rehearsal-metrics-website',
    'migration-rehearsal-bing-link',
    CURRENT_DATE - 2,
    1,
    2,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "WebsiteIntegration"
       SET "integrationId" = 'migration-rehearsal-google-integration'
     WHERE "id" = 'migration-rehearsal-bing-link';
    RAISE EXCEPTION 'Website integration accepted provider retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'website integration provider-property identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsiteIntegration"
       SET "websiteId" = 'migration-rehearsal-retargeted-website'
     WHERE "id" = 'migration-rehearsal-bing-link';
    RAISE EXCEPTION 'Website integration accepted Website retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'website integration provider-property identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsiteIntegration"
       SET "externalResourceId" = 'https://retargeted.invalid'
     WHERE "id" = 'migration-rehearsal-bing-link';
    RAISE EXCEPTION 'Website integration accepted provider-property retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'website integration provider-property identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "IntegrationSchedule"
       SET "integrationId" = 'migration-rehearsal-google-integration'
     WHERE "id" = 'migration-rehearsal-bing-schedule';
    RAISE EXCEPTION 'Integration schedule accepted identity retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration schedule identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "IntegrationSync"
       SET "integrationId" = 'migration-rehearsal-google-integration'
     WHERE "id" = 'migration-rehearsal-allowed-bing-sync';
    RAISE EXCEPTION 'Integration sync accepted parent retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration sync identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "IntegrationSync"
       SET "websiteIntegrationId" = 'migration-rehearsal-google-link'
     WHERE "id" = 'migration-rehearsal-allowed-bing-sync';
    RAISE EXCEPTION 'Integration sync accepted Website-link retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration sync identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "IntegrationDiscovery"
       SET "integrationId" = 'migration-rehearsal-google-integration'
     WHERE "id" = 'migration-rehearsal-allowed-bing-discovery';
    RAISE EXCEPTION 'Integration discovery accepted identity retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration discovery identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsiteSearchDaily"
       SET "websiteId" = 'migration-rehearsal-retargeted-website'
     WHERE "id" = 'migration-rehearsal-allowed-bing-search-daily';
    RAISE EXCEPTION 'Daily metric accepted Website retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'daily metric website, source, and date identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsiteSearchDaily"
       SET "sourceIntegrationId" = 'migration-rehearsal-google-link'
     WHERE "id" = 'migration-rehearsal-allowed-bing-search-daily';
    RAISE EXCEPTION 'Daily metric accepted source retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'daily metric website, source, and date identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsiteSearchDaily"
       SET "date" = "date" - 1
     WHERE "id" = 'migration-rehearsal-allowed-bing-search-daily';
    RAISE EXCEPTION 'Daily metric accepted date retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'daily metric website, source, and date identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "WebsitePageSearchDaily"
       SET "pageUrl" = 'https://retargeted.invalid/page'
     WHERE "id" = 'migration-rehearsal-google-page-daily';
    RAISE EXCEPTION 'Daily page metric accepted URL retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'daily page metric URL identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PublisherIntegration"
       SET "provider" = 'GOOGLE_SEARCH_CONSOLE'
     WHERE "id" = 'migration-rehearsal-bing-integration';
    RAISE EXCEPTION 'Integration provider identity guard accepted relabeling';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration provider, credential, and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PublisherIntegration"
       SET "connectionId" = 'migration-rehearsal-google-account'
     WHERE "id" = 'migration-rehearsal-bing-integration';
    RAISE EXCEPTION 'Integration credential identity guard accepted retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration provider, credential, and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PublisherIntegration"
       SET "ownerType" = 'PLATFORM'
     WHERE "id" = 'migration-rehearsal-bing-integration';
    RAISE EXCEPTION 'Integration owner type guard accepted retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration provider, credential, and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PublisherIntegration"
       SET "ownerId" = 'migration-rehearsal-empty-publisher'
     WHERE "id" = 'migration-rehearsal-bing-integration';
    RAISE EXCEPTION 'Integration owner identity guard accepted retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration provider, credential, and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "PublisherIntegration" (
      "id", "ownerType", "ownerId", "provider", "connectionId", "status",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-owner-mismatch',
      'PLATFORM',
      'migration-rehearsal-metrics-website',
      'GOOGLE_ANALYTICS',
      'migration-rehearsal-google-account',
      'ERROR',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Integration accepted a credential-owner mismatch';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'integration owner must match its credential owner' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "PublisherIntegration" (
    "id", "ownerType", "ownerId", "provider", "connectionId", "status",
    "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-owned-analytics-integration',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'GOOGLE_ANALYTICS',
    'migration-rehearsal-google-account',
    'ERROR',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  UPDATE "PublisherIntegration"
     SET "status" = 'DISCONNECTED',
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-owned-analytics-integration';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Matched integration-owner positive control found no row';
  END IF;

  BEGIN
    DELETE FROM "WebsiteIntegration"
     WHERE "id" = 'migration-rehearsal-google-link';
    RAISE EXCEPTION 'Referenced WebsiteIntegration source was hard-deleted';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "WebsiteIntegration"
       SET "id" = 'migration-rehearsal-retargeted-source-id'
     WHERE "id" = 'migration-rehearsal-google-link';
    RAISE EXCEPTION 'Referenced WebsiteIntegration source id was retargeted';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'website integration provider-property identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "WebsiteIntegration" (
      "id", "integrationId", "websiteId", "externalResourceId",
      "externalResourceName", "metadata", "status", "syncedAt",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-google-link',
      'migration-rehearsal-owned-analytics-integration',
      'migration-rehearsal-metrics-website',
      'properties/reused-source-id',
      'Reused source id',
      '{}'::jsonb,
      'DISABLED',
      NULL,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'WebsiteIntegration source id was reused';
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = CONSTRAINT_NAME;
      IF identity_rejection_message IS DISTINCT FROM 'WebsiteIntegration_pkey' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Website"
       SET "canonicalDomain" = 'retargeted.invalid'
     WHERE "id" = 'migration-rehearsal-metrics-website';
    RAISE EXCEPTION 'Website canonical-domain identity guard accepted retargeting';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "MarketplaceListing"
       SET "metricsData" = '{"source":"GSC"}'::jsonb
     WHERE "id" = 'migration-rehearsal-metrics-listing';
    RAISE EXCEPTION 'Listing summary quarantine accepted Google metrics';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    UPDATE "Website"
       SET "metrics" = COALESCE("metrics", '{}'::jsonb)
         || '{"ga4Sessions30d":1}'::jsonb
     WHERE "id" = 'migration-rehearsal-metrics-website';
    RAISE EXCEPTION 'Website summary quarantine accepted Google metrics';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN
      NULL;
  END;

  BEGIN
    UPDATE "Website"
       SET "metrics" = '[]'::jsonb
     WHERE "id" = 'migration-rehearsal-metrics-website';
    RAISE EXCEPTION 'Website metrics object constraint accepted an array';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END;
$$;

DO $$
DECLARE
  release_rejection_message TEXT;
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
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "walletId",
      "orderId", "publisherId", "settlementId", "createdAt"
    ) VALUES (
      'migration-rehearsal-release-with-wallet',
      1,
      'USD',
      'SETTLEMENT_RELEASE',
      'migration-rehearsal-release-with-wallet',
      'migration-rehearsal-wallet',
      'migration-rehearsal-invalid-order',
      'migration-rehearsal-publisher',
      'migration-rehearsal-invalid-settlement',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION
      'Settlement release ledger accepted a customer wallet identity';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS release_rejection_message = MESSAGE_TEXT;
      IF release_rejection_message IS DISTINCT FROM
         'settlement release ledger cannot carry wallet or provider identity' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "provider",
      "orderId", "publisherId", "settlementId", "createdAt"
    ) VALUES (
      'migration-rehearsal-release-with-provider',
      1,
      'USD',
      'SETTLEMENT_RELEASE',
      'migration-rehearsal-release-with-provider',
      'stripe',
      'migration-rehearsal-invalid-order',
      'migration-rehearsal-publisher',
      'migration-rehearsal-invalid-settlement',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION
      'Settlement release ledger accepted an external provider identity';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS release_rejection_message = MESSAGE_TEXT;
      IF release_rejection_message IS DISTINCT FROM
         'settlement release ledger cannot carry wallet or provider identity' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "providerRef",
      "orderId", "publisherId", "settlementId", "createdAt"
    ) VALUES (
      'migration-rehearsal-release-with-provider-ref',
      1,
      'USD',
      'SETTLEMENT_RELEASE',
      'migration-rehearsal-release-with-provider-ref',
      'pi_migration_rehearsal_release',
      'migration-rehearsal-invalid-order',
      'migration-rehearsal-publisher',
      'migration-rehearsal-invalid-settlement',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION
      'Settlement release ledger accepted an external provider reference';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS release_rejection_message = MESSAGE_TEXT;
      IF release_rejection_message IS DISTINCT FROM
         'settlement release ledger cannot carry wallet or provider identity' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "createdAt"
    ) VALUES (
      'migration-rehearsal-release-mutation-source',
      1,
      'USD',
      'REFUND',
      'migration-rehearsal-release-mutation-source',
      CURRENT_TIMESTAMP
    );

    UPDATE "Transaction"
    SET
      "type" = 'SETTLEMENT_RELEASE',
      "amount" = 1,
      "walletId" = NULL,
      "orderId" = 'migration-rehearsal-invalid-order',
      "publisherId" = 'migration-rehearsal-publisher',
      "settlementId" = 'migration-rehearsal-invalid-settlement'
    WHERE "id" = 'migration-rehearsal-release-mutation-source';
    RAISE EXCEPTION
      'Settlement release ledger accepted mutation of existing evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS release_rejection_message = MESSAGE_TEXT;
      IF release_rejection_message IS DISTINCT FROM
         'settlement release ledger evidence is insert-only and append-only' THEN
        RAISE;
      END IF;
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

-- Google metrics are quarantined fail-closed, while non-Google integrations
-- and source-aware Ahrefs summaries remain usable. Historical raw metric rows
-- are retained as untrusted forensic evidence rather than rewritten/deleted.
DO $$
DECLARE
  google_schedule_enabled BOOLEAN;
  google_schedule_version INTEGER;
  bing_schedule_enabled BOOLEAN;
  bing_schedule_version INTEGER;
  google_link_status TEXT;
  google_link_synced_at TIMESTAMP;
  bing_link_status TEXT;
  bing_link_synced_at TIMESTAMP;
  google_sync_status TEXT;
  google_sync_error TEXT;
  google_sync_completed_at TIMESTAMP;
  bing_sync_status TEXT;
  bing_sync_error TEXT;
  google_discovery_status TEXT;
  google_discovery_error TEXT;
  google_discovery_completed_at TIMESTAMP;
  bing_discovery_status TEXT;
  bing_resources_found INTEGER;
  bing_resources_created INTEGER;
  listing_traffic INTEGER;
  listing_metrics JSONB;
  listing_traffic_data JSONB;
  website_metrics JSONB;
  raw_search_count INTEGER;
  raw_page_count INTEGER;
  raw_analytics_count INTEGER;
  quarantine_trigger_count INTEGER;
  validated_constraint_count INTEGER;
  source_provenance_fk_count INTEGER;
BEGIN
  SELECT "enabled", "version"
    INTO google_schedule_enabled, google_schedule_version
    FROM "IntegrationSchedule"
   WHERE "id" = 'migration-rehearsal-google-schedule';
  IF google_schedule_enabled IS DISTINCT FROM FALSE
     OR google_schedule_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION
      'Google schedule was not disabled with an optimistic-lock version bump';
  END IF;

  SELECT "enabled", "version"
    INTO bing_schedule_enabled, bing_schedule_version
    FROM "IntegrationSchedule"
   WHERE "id" = 'migration-rehearsal-bing-schedule';
  IF bing_schedule_enabled IS DISTINCT FROM TRUE
     OR bing_schedule_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'BING schedule was changed by the Google metrics quarantine';
  END IF;

  SELECT "status"::TEXT, "syncedAt"
    INTO google_link_status, google_link_synced_at
    FROM "WebsiteIntegration"
   WHERE "id" = 'migration-rehearsal-google-link';
  IF google_link_status IS DISTINCT FROM 'DISABLED'
     OR google_link_synced_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Google website link was not disabled and marked unsynced';
  END IF;

  SELECT "status"::TEXT, "syncedAt"
    INTO bing_link_status, bing_link_synced_at
    FROM "WebsiteIntegration"
   WHERE "id" = 'migration-rehearsal-bing-link';
  IF bing_link_status IS DISTINCT FROM 'CONNECTED'
     OR bing_link_synced_at IS NULL THEN
    RAISE EXCEPTION
      'BING website link was changed by the Google metrics quarantine';
  END IF;

  SELECT "status"::TEXT, "errorMessage", "completedAt"
    INTO google_sync_status, google_sync_error, google_sync_completed_at
    FROM "IntegrationSync"
   WHERE "id" = 'migration-rehearsal-google-sync';
  IF google_sync_status IS DISTINCT FROM 'FAILED'
     OR google_sync_error IS DISTINCT FROM 'GOOGLE_METRICS_DISABLED'
     OR google_sync_completed_at IS NULL THEN
    RAISE EXCEPTION
      'Pending Google sync was not failed with explicit quarantine evidence';
  END IF;

  SELECT "status"::TEXT, "errorMessage"
    INTO bing_sync_status, bing_sync_error
    FROM "IntegrationSync"
   WHERE "id" = 'migration-rehearsal-bing-sync';
  IF bing_sync_status IS DISTINCT FROM 'COMPLETED'
     OR bing_sync_error IS NOT NULL THEN
    RAISE EXCEPTION
      'Completed BING sync was changed by the Google metrics quarantine';
  END IF;

  SELECT "status"::TEXT, "errorMessage", "completedAt"
    INTO google_discovery_status, google_discovery_error,
         google_discovery_completed_at
    FROM "IntegrationDiscovery"
   WHERE "id" = 'migration-rehearsal-google-discovery';
  IF google_discovery_status IS DISTINCT FROM 'FAILED'
     OR google_discovery_error IS DISTINCT FROM 'GOOGLE_METRICS_DISABLED'
     OR google_discovery_completed_at IS NULL THEN
    RAISE EXCEPTION
      'Pending Google discovery was not failed with explicit quarantine evidence';
  END IF;

  SELECT "status"::TEXT, "resourcesFound", "resourcesCreated"
    INTO bing_discovery_status, bing_resources_found, bing_resources_created
    FROM "IntegrationDiscovery"
   WHERE "id" = 'migration-rehearsal-bing-discovery';
  IF bing_discovery_status IS DISTINCT FROM 'COMPLETED'
     OR bing_resources_found IS DISTINCT FROM 2
     OR bing_resources_created IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'Completed BING discovery was changed by the Google metrics quarantine';
  END IF;

  SELECT "traffic", "metricsData", "trafficData"
    INTO listing_traffic, listing_metrics, listing_traffic_data
    FROM "MarketplaceListing"
   WHERE "id" = 'migration-rehearsal-metrics-listing';
  IF listing_traffic IS DISTINCT FROM 321
     OR listing_metrics IS NOT NULL
     OR listing_traffic_data IS NOT NULL THEN
    RAISE EXCEPTION
      'Listing summaries were not quarantined and restored from current Ahrefs evidence';
  END IF;

  SELECT "metrics"
    INTO website_metrics
    FROM "Website"
   WHERE "id" = 'migration-rehearsal-metrics-website';
  IF website_metrics ->> 'safeControl' IS DISTINCT FROM 'preserve-me'
     OR website_metrics ->> 'traffic' IS DISTINCT FROM '321'
     OR website_metrics ?| ARRAY[
       'ga4Sessions30d',
       'ga4Users30d',
       'ga4Pageviews30d',
       'ga4SyncedAt'
     ] THEN
    RAISE EXCEPTION
      'Website summary sanitization lost safe data or retained Google-derived data';
  END IF;

  SELECT COUNT(*) INTO raw_search_count
    FROM "WebsiteSearchDaily"
   WHERE "id" IN (
     'migration-rehearsal-google-search-daily',
     'migration-rehearsal-bing-search-daily'
   );
  SELECT COUNT(*) INTO raw_page_count
    FROM "WebsitePageSearchDaily"
   WHERE "id" = 'migration-rehearsal-google-page-daily';
  SELECT COUNT(*) INTO raw_analytics_count
    FROM "WebsiteAnalyticsDaily"
   WHERE "id" = 'migration-rehearsal-google-analytics-daily';
  IF raw_search_count <> 2 OR raw_page_count <> 1 OR raw_analytics_count <> 1 THEN
    RAISE EXCEPTION
      'Historical raw integration metrics were deleted during quarantine';
  END IF;

  SELECT COUNT(*)
    INTO quarantine_trigger_count
    FROM pg_trigger
   WHERE tgname IN (
     'WebsiteSearchDaily_google_quarantine',
     'WebsitePageSearchDaily_google_quarantine',
     'WebsiteAnalyticsDaily_google_quarantine',
     'WebsiteIntegration_google_quarantine',
     'IntegrationSchedule_google_quarantine',
     'IntegrationSync_google_quarantine',
     'IntegrationDiscovery_google_quarantine',
     'PublisherIntegration_provider_identity_guard',
     'PublisherIntegration_z_connection_owner_guard',
     'Website_canonical_domain_identity_guard',
     'MarketplaceListing_google_summary_quarantine',
     'Website_google_summary_quarantine'
   )
     AND NOT tgisinternal;
  IF quarantine_trigger_count <> 12 THEN
    RAISE EXCEPTION
      'Required Google metrics quarantine triggers are not installed';
  END IF;

  SELECT COUNT(*)
    INTO validated_constraint_count
    FROM pg_constraint
   WHERE conname = 'Website_metrics_object_check'
     AND convalidated;
  IF validated_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'Website_metrics_object_check is missing or not validated';
  END IF;

  SELECT COUNT(*)
    INTO source_provenance_fk_count
    FROM pg_constraint
   WHERE conname IN (
     'WebsiteSearchDaily_sourceIntegrationId_fkey',
     'WebsitePageSearchDaily_sourceIntegrationId_fkey',
     'WebsiteAnalyticsDaily_sourceIntegrationId_fkey'
   )
     AND contype = 'f'
     AND convalidated;
  IF source_provenance_fk_count <> 3 THEN
    RAISE EXCEPTION
      'Daily metric source-provenance foreign keys are missing or unvalidated';
  END IF;
END;
$$;

-- Encryption metadata is explicit and future writers cannot silently inherit
-- v1, persist malformed envelopes, or split a token pair across key versions.
DO $$
DECLARE
  version_column_default TEXT;
  version_column_nullable TEXT;
  fixture_version_count INTEGER;
  sentinel_status TEXT;
  sentinel_access TEXT;
  sentinel_refresh TEXT;
  sentinel_version INTEGER;
  identity_rejection_message TEXT;
  encryption_constraint_count INTEGER;
  rotation_trigger_count INTEGER;
  owner_identity_trigger_count INTEGER;
  rotated_version INTEGER;
BEGIN
  SELECT "column_default", "is_nullable"
    INTO version_column_default, version_column_nullable
    FROM information_schema.columns
   WHERE "table_schema" = current_schema()
     AND "table_name" = 'ExternalAccount'
     AND "column_name" = 'encryptionKeyVersion';
  IF NOT FOUND
     OR version_column_default IS NOT NULL
     OR version_column_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION
      'ExternalAccount encryption key version is missing, nullable, or defaulted';
  END IF;

  SELECT COUNT(*)
    INTO fixture_version_count
    FROM "ExternalAccount"
   WHERE "id" IN (
     'migration-rehearsal-google-account',
     'migration-rehearsal-bing-account',
     'migration-rehearsal-empty-error-account'
   )
     AND "encryptionKeyVersion" = 1;
  IF fixture_version_count <> 3 THEN
    RAISE EXCEPTION
      'Historical ExternalAccount key versions were not backfilled exactly';
  END IF;

  SELECT "status"::TEXT, "encryptedAccessToken", "encryptedRefreshToken",
         "encryptionKeyVersion"
    INTO sentinel_status, sentinel_access, sentinel_refresh, sentinel_version
    FROM "ExternalAccount"
   WHERE "id" = 'migration-rehearsal-empty-error-account';
  IF sentinel_status IS DISTINCT FROM 'ERROR'
     OR sentinel_access IS DISTINCT FROM ''
     OR sentinel_refresh IS DISTINCT FROM ''
     OR sentinel_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'Exact legacy missing-credential sentinel was not preserved';
  END IF;

  IF NOT "is_valid_integration_ciphertext"(
    'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
    1
  )
     OR NOT "is_valid_integration_ciphertext"(
       'v2:AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
       2
     )
     OR "is_valid_integration_ciphertext"('not-base64', 1)
     OR "is_valid_integration_ciphertext"(
       'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf=',
       1
     )
     OR "is_valid_integration_ciphertext"(
       'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
       2
     ) THEN
    RAISE EXCEPTION
      'Integration ciphertext validator does not enforce canonical envelopes';
  END IF;

  SELECT COUNT(*)
    INTO encryption_constraint_count
    FROM pg_constraint
   WHERE conrelid = '"ExternalAccount"'::regclass
     AND conname IN (
       'ExternalAccount_encryption_key_version_check',
       'ExternalAccount_token_envelope_check'
     )
     AND convalidated;
  IF encryption_constraint_count <> 2 THEN
    RAISE EXCEPTION
      'ExternalAccount encryption constraints are missing or not validated';
  END IF;

  SELECT COUNT(*)
    INTO rotation_trigger_count
    FROM pg_trigger
   WHERE tgrelid = '"ExternalAccount"'::regclass
     AND tgname = 'ExternalAccount_token_rotation_guard'
     AND NOT tgisinternal;
  IF rotation_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'ExternalAccount atomic rotation trigger is not installed';
  END IF;

  SELECT COUNT(*)
    INTO owner_identity_trigger_count
    FROM pg_trigger
   WHERE tgrelid = '"ExternalAccount"'::regclass
     AND tgname = 'ExternalAccount_owner_identity_guard'
     AND NOT tgisinternal;
  IF owner_identity_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'ExternalAccount provider/owner identity trigger is not installed';
  END IF;

  BEGIN
    UPDATE "ExternalAccount"
       SET "provider" = 'MICROSOFT'
     WHERE "id" = 'migration-rehearsal-google-account';
    RAISE EXCEPTION 'ExternalAccount accepted provider retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'external account provider and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "externalUserId" = 'retargeted-external-user'
     WHERE "id" = 'migration-rehearsal-google-account';
    RAISE EXCEPTION 'ExternalAccount accepted external-user retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'external account provider and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "ownerType" = 'PLATFORM'
     WHERE "id" = 'migration-rehearsal-google-account';
    RAISE EXCEPTION 'ExternalAccount accepted owner-type retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'external account provider and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "ownerId" = 'migration-rehearsal-empty-publisher'
     WHERE "id" = 'migration-rehearsal-google-account';
    RAISE EXCEPTION 'ExternalAccount accepted owner retargeting';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS identity_rejection_message = MESSAGE_TEXT;
      IF identity_rejection_message IS DISTINCT FROM
         'external account provider and owner identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "ExternalAccount" (
      "id", "provider", "externalUserId", "ownerType", "ownerId",
      "encryptedAccessToken", "encryptedRefreshToken", "tokenExpiresAt",
      "grantedScopes", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-default-version',
      'GOOGLE',
      'rejected-default-version',
      'PUBLISHER',
      'migration-rehearsal-publisher',
      'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
      'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
      CURRENT_TIMESTAMP + INTERVAL '1 hour',
      ARRAY[]::TEXT[],
      'ACTIVE',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ExternalAccount accepted an implicit encryption key version';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "ExternalAccount" (
      "id", "provider", "externalUserId", "ownerType", "ownerId",
      "encryptedAccessToken", "encryptedRefreshToken",
      "encryptionKeyVersion", "tokenExpiresAt", "grantedScopes", "status",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-malformed-envelope',
      'GOOGLE',
      'rejected-malformed-envelope',
      'PUBLISHER',
      'migration-rehearsal-publisher',
      'not-base64',
      'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
      1,
      CURRENT_TIMESTAMP + INTERVAL '1 hour',
      ARRAY[]::TEXT[],
      'ACTIVE',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ExternalAccount accepted a malformed ciphertext envelope';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "ExternalAccount" (
      "id", "provider", "externalUserId", "ownerType", "ownerId",
      "encryptedAccessToken", "encryptedRefreshToken",
      "encryptionKeyVersion", "tokenExpiresAt", "grantedScopes", "status",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-partial-sentinel',
      'GOOGLE',
      'rejected-partial-sentinel',
      'PUBLISHER',
      'migration-rehearsal-publisher',
      '',
      'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
      1,
      CURRENT_TIMESTAMP + INTERVAL '1 hour',
      ARRAY[]::TEXT[],
      'ERROR',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ExternalAccount accepted a partial missing-token sentinel';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "ExternalAccount" (
      "id", "provider", "externalUserId", "ownerType", "ownerId",
      "encryptedAccessToken", "encryptedRefreshToken",
      "encryptionKeyVersion", "tokenExpiresAt", "grantedScopes", "status",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-zero-version',
      'GOOGLE',
      'rejected-zero-version',
      'PUBLISHER',
      'migration-rehearsal-publisher',
      'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
      'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
      0,
      CURRENT_TIMESTAMP + INTERVAL '1 hour',
      ARRAY[]::TEXT[],
      'ACTIVE',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'ExternalAccount accepted encryption key version zero';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  INSERT INTO "ExternalAccount" (
    "id", "provider", "externalUserId", "ownerType", "ownerId",
    "encryptedAccessToken", "encryptedRefreshToken", "encryptionKeyVersion",
    "tokenExpiresAt", "grantedScopes", "status", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-rotation-account',
    'GOOGLE',
    'rotation-account',
    'PUBLISHER',
    'migration-rehearsal-publisher',
    'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
    'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
    1,
    CURRENT_TIMESTAMP + INTERVAL '1 hour',
    ARRAY[]::TEXT[],
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "ExternalAccount"
       SET "encryptedAccessToken" = "encryptedRefreshToken"
     WHERE "id" = 'migration-rehearsal-rotation-account';
    RAISE EXCEPTION 'ExternalAccount accepted a one-sided token rotation';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "encryptionKeyVersion" = 2
     WHERE "id" = 'migration-rehearsal-rotation-account';
    RAISE EXCEPTION 'ExternalAccount accepted key-version relabeling';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "encryptedAccessToken" = 'not-base64',
           "encryptedRefreshToken" = 'also-not-base64'
     WHERE "id" = 'migration-rehearsal-rotation-account';
    RAISE EXCEPTION 'ExternalAccount accepted paired malformed ciphertexts';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  UPDATE "ExternalAccount"
     SET "encryptedAccessToken" =
           'v2:AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
         "encryptedRefreshToken" =
           'v2:AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
         "encryptionKeyVersion" = 2,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-rotation-account';

  SELECT "encryptionKeyVersion"
    INTO rotated_version
    FROM "ExternalAccount"
   WHERE "id" = 'migration-rehearsal-rotation-account';
  IF rotated_version IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Atomic ExternalAccount rotation positive control failed';
  END IF;

  BEGIN
    UPDATE "ExternalAccount"
       SET "encryptedAccessToken" =
             'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
           "encryptedRefreshToken" =
             'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw=='
     WHERE "id" = 'migration-rehearsal-rotation-account';
    RAISE EXCEPTION 'ExternalAccount accepted a stale v1 writer on a v2 row';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "ExternalAccount"
       SET "encryptedAccessToken" =
             'AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf',
           "encryptedRefreshToken" =
             'AgICAgICAgICAgICyQYivwznI7hBEGKkMspZKsPiFwBTCLwyuia17athAR7bEP0KIUySpMbruw==',
           "encryptionKeyVersion" = 1
     WHERE "id" = 'migration-rehearsal-rotation-account';
    RAISE EXCEPTION 'ExternalAccount accepted encryption key downgrade';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;
END;
$$;

-- Settlement accounting identity and release evidence are relational facts.
-- Exercise the complete valid path and the high-risk direct-SQL bypasses that
-- the database backstop must reject independently of application code.
DO $$
DECLARE
  rejection_message TEXT;
  rejection_constraint TEXT;
  released_at TIMESTAMP;
  cancelled_settled_at TIMESTAMP;
  settlement_guard_count INTEGER;
  fraud_resolution_guard_count INTEGER;
  fraud_resolution_constraint_count INTEGER;
  order_contract_guard_count INTEGER;
  platform_settings_id TEXT;
  platform_fee_pct NUMERIC;
  platform_settings_version INTEGER;
  backfilled_fee_bps INTEGER;
  backfilled_fee_policy TEXT;
  purchase_evidence_count INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO settlement_guard_count
    FROM pg_trigger
   WHERE tgname IN (
     'Settlement_eligibility_guard',
     'Settlement_delete_guard',
     'Order_settlement_identity_guard',
     'Transaction_settlement_release_evidence_guard',
     'Settlement_release_evidence_required',
     'Transaction_released_settlement_required',
     'Transaction_purchase_evidence_guard',
     'Website_ordered_publisher_identity_guard',
     'Order_website_identity_lock',
     'PlatformSettings_fee_policy_guard'
   )
     AND NOT tgisinternal;
  IF settlement_guard_count <> 10 THEN
    RAISE EXCEPTION 'Required settlement identity/evidence triggers are missing';
  END IF;

  SELECT COUNT(*)
    INTO fraud_resolution_guard_count
    FROM pg_trigger
   WHERE tgname IN (
     'DeliveryFraudFlag_current_hold_projection',
     'DeliveryFraudFlagResolution_guard',
     'DeliveryFraudFlagResolution_classification_guard',
     'DeliveryFraudHold_write_guard',
     'DeliveryFraudHold_delete_requires_resolution',
     'DeliveryVerificationEvidence_append_only_guard',
     'DeliverySnapshot_append_only_guard'
   )
     AND NOT tgisinternal;
  IF fraud_resolution_guard_count <> 7 THEN
    RAISE EXCEPTION 'Delivery fraud resolution/hold/evidence guards are missing';
  END IF;

  -- This constraint is intentionally NOT VALID: immutable historical rows
  -- predate classified dispositions, while PostgreSQL still enforces the
  -- check for every new insert. Do not require convalidated here unless a
  -- separate evidence-preserving historical backfill is introduced first.
  SELECT COUNT(*)
    INTO fraud_resolution_constraint_count
    FROM pg_constraint
   WHERE conrelid = '"DeliveryFraudFlagResolution"'::regclass
     AND conname = 'DeliveryFraudFlagResolution_staff_disposition_check'
     AND contype = 'c';
  IF fraud_resolution_constraint_count <> 1 THEN
    RAISE EXCEPTION 'Delivery fraud disposition constraint is missing';
  END IF;

  SELECT COUNT(*)
    INTO order_contract_guard_count
    FROM pg_trigger
   WHERE tgrelid = '"Order"'::regclass
     AND tgname = 'Order_contract_metadata_guard'
     AND NOT tgisinternal;
  IF order_contract_guard_count <> 1 THEN
    RAISE EXCEPTION 'Order idempotency/contract metadata guard is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'Revision'
      AND indexname = 'Revision_orderId_active_key'
  ) THEN
    RAISE EXCEPTION 'One-active-revision structural guard is missing';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM "Revision"
    WHERE "id" IN (
      'migration-rehearsal-evidenced-revision-one',
      'migration-rehearsal-evidenced-revision-two'
    )
      AND "status" = 'APPROVED'
  ) <> 2 THEN
    RAISE EXCEPTION
      'Evidence-backed historical revision fulfillment was not repaired';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Revision"
    WHERE "orderId" = 'migration-rehearsal-settlement-order'
      AND "status" NOT IN ('APPROVED', 'REJECTED')
  ) THEN
    RAISE EXCEPTION
      'Evidence-backed historical revisions remained active after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag" flag
    JOIN "DeliveryFraudHold" hold
      ON hold."fraudFlagId" = flag."id"
     AND hold."orderId" = flag."orderId"
     AND hold."deliveryVersionId" = flag."deliveryVersionId"
     AND hold."type" = flag."type"
     AND hold."createdAt" = flag."createdAt"
    WHERE flag."id" = 'migration-rehearsal-pre0940-fraud'
  ) OR NOT "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Historical pre-0940 fraud hold was not backfilled exactly';
  END IF;

  INSERT INTO "DeliveryFraudFlagResolution" (
    "id", "fraudFlagId", "orderId", "deliveryVersionId", "kind",
    "reason", "resolvedByUserId", "resolvedByRole", "evidence", "createdAt"
  ) VALUES (
    'migration-rehearsal-pre0940-resolution',
    'migration-rehearsal-pre0940-fraud',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-settlement-delivery',
    'STAFF_CLEARED',
    'Finance reconciled and cleared the historical pre-migration signal.',
    'migration-rehearsal-finance',
    'FINANCE',
    '{"source":"historical-migration-review","disposition":"AUTHORIZED_REUSE","evidenceReference":"migration-rehearsal-case-url-reuse-001"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "DeliverySnapshot" (
    "id", "deliveryVersionId", "htmlObjectKey", "responseHeaders", "createdAt"
  ) VALUES (
    'migration-rehearsal-delivery-snapshot',
    'migration-rehearsal-settlement-delivery',
    'deliveries/migration-rehearsal-settlement-delivery/verification-1-evidence.html',
    '{"content-type":"text/html"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  IF EXISTS (
    SELECT 1 FROM "DeliveryFraudHold"
    WHERE "fraudFlagId" = 'migration-rehearsal-pre0940-fraud'
  ) OR "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Historical fraud hold was not closed by immutable resolution';
  END IF;

  IF (
    SELECT "revisionRoundsSnapshot"
    FROM "Order"
    WHERE "id" = 'migration-rehearsal-settlement-order'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Historical revision entitlement was synthesized from mutable catalog terms';
  END IF;

  SELECT "id", "platformFeePct", "version"
    INTO platform_settings_id, platform_fee_pct, platform_settings_version
    FROM "PlatformSettings";
  IF NOT FOUND
     OR platform_settings_id IS DISTINCT FROM 'platform-settings-default'
     OR platform_fee_pct IS DISTINCT FROM 20
     OR platform_settings_version IS DISTINCT FROM 1
     OR (SELECT COUNT(*) FROM "PlatformSettings") <> 1 THEN
    RAISE EXCEPTION
      'PlatformSettings singleton/default fee policy was not provisioned exactly';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"PlatformSettings"'::regclass
      AND conname = 'PlatformSettings_fee_policy_check'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"Settlement"'::regclass
      AND conname = 'Settlement_fee_policy_snapshot_check'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'Versioned fee-policy constraints are missing or unvalidated';
  END IF;

  SELECT "platformFeeBps", "feePolicyVersion"
    INTO backfilled_fee_bps, backfilled_fee_policy
    FROM "Settlement"
   WHERE "id" = 'migration-rehearsal-settlement-backfill'
     AND "status" = 'PENDING';
  IF backfilled_fee_bps IS DISTINCT FROM 2000
     OR backfilled_fee_policy IS DISTINCT FROM
       'platform-settings:platform-settings-default:v1' THEN
    RAISE EXCEPTION
      'Active historical settlement fee policy was not backfilled exactly';
  END IF;

  SELECT COUNT(*)
    INTO purchase_evidence_count
    FROM "Transaction" purchase
    JOIN "Order" order_row ON order_row."id" = purchase."orderId"
    JOIN "Wallet" wallet ON wallet."id" = purchase."walletId"
   WHERE purchase."id" = 'migration-rehearsal-order-purchase'
     AND purchase."type" = 'PURCHASE'
     AND purchase."amount" = -100
     AND purchase."currency" = 'USD'
     AND purchase."publisherId" IS NULL
     AND purchase."settlementId" IS NULL
     AND purchase."provider" IS NULL
     AND purchase."providerRef" IS NULL
     AND order_row."id" = 'migration-rehearsal-settlement-order'
     AND order_row."amount" = 100
     AND order_row."paymentStatus" = 'PAID'
     AND wallet."id" = 'migration-rehearsal-organization-wallet'
     AND wallet."organizationId" = order_row."organizationId";
  IF purchase_evidence_count <> 1 THEN
    RAISE EXCEPTION 'Paid order canonical PURCHASE evidence is not exact';
  END IF;

  IF to_regclass('"Transaction_purchase_order_unique"') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conrelid = '"Transaction"'::regclass
         AND conname = 'Transaction_purchase_identity_check'
         AND convalidated
     ) THEN
    RAISE EXCEPTION 'PURCHASE identity or uniqueness backstop is missing';
  END IF;

  -- Retain the backfilled row as cancelled evidence while freeing the partial
  -- active-settlement key for new-policy write tests below.
  UPDATE "Settlement"
     SET "status" = 'CANCELLED',
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-settlement-backfill';

  BEGIN
    INSERT INTO "PlatformSettings" (
      "id", "platformFeePct", "version", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-second-platform-settings',
      20,
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PlatformSettings singleton accepted a second row';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE "PlatformSettings"
       SET "platformFeePct" = 21
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee changed without a version increment';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform fee policy change must increment version exactly once' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PlatformSettings"
       SET "version" = 2
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee version changed without a fee change';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform fee policy version cannot change without a fee change' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PlatformSettings"
       SET "platformFeePct" = 21,
           "version" = 3
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee policy accepted a skipped version';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform fee policy change must increment version exactly once' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PlatformSettings"
       SET "id" = 'retargeted-platform-settings'
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee policy identity changed';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform fee policy identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "PlatformSettings"
       SET "platformFeePct" = 101,
           "version" = 2
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee policy accepted an out-of-range fee';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM 'PlatformSettings_fee_policy_check' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "PlatformSettings"
     WHERE "id" = 'platform-settings-default';
    RAISE EXCEPTION 'Platform fee policy evidence was deleted';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'platform fee policy evidence cannot be deleted' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "walletId",
      "orderId", "createdAt"
    ) VALUES (
      'migration-rehearsal-duplicate-order-purchase',
      -100,
      'USD',
      'PURCHASE',
      'order:migration-rehearsal-settlement-order:duplicate',
      'migration-rehearsal-organization-wallet',
      'migration-rehearsal-settlement-order',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Paid order accepted duplicate PURCHASE evidence';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "walletId",
      "orderId", "createdAt"
    ) VALUES (
      'migration-rehearsal-wrong-amount-purchase',
      -99,
      'USD',
      'PURCHASE',
      'order:migration-rehearsal-settlement-order:wrong-amount',
      'migration-rehearsal-organization-wallet',
      'migration-rehearsal-settlement-order',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PURCHASE evidence accepted a wrong order amount';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'purchase ledger identity does not match its paid order and organization wallet' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "walletId",
      "orderId", "createdAt"
    ) VALUES (
      'migration-rehearsal-wrong-wallet-purchase',
      -100,
      'USD',
      'PURCHASE',
      'order:migration-rehearsal-settlement-order:wrong-wallet',
      'migration-rehearsal-wallet',
      'migration-rehearsal-settlement-order',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PURCHASE evidence accepted a personal wallet';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'purchase ledger identity does not match its paid order and organization wallet' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "provider",
      "providerRef", "walletId", "orderId", "createdAt"
    ) VALUES (
      'migration-rehearsal-provider-purchase',
      -100,
      'USD',
      'PURCHASE',
      'order:migration-rehearsal-settlement-order:provider',
      'stripe',
      'pi_purchase_must_not_carry_provider',
      'migration-rehearsal-organization-wallet',
      'migration-rehearsal-settlement-order',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'PURCHASE evidence accepted provider identity';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM 'Transaction_purchase_identity_check' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Transaction"
       SET "reference" = 'retargeted-purchase-reference'
     WHERE "id" = 'migration-rehearsal-order-purchase';
    RAISE EXCEPTION 'PURCHASE evidence accepted mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'purchase ledger evidence is insert-only and append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "Transaction"
     WHERE "id" = 'migration-rehearsal-order-purchase';
    RAISE EXCEPTION 'PURCHASE evidence accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'purchase ledger evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "createdAt"
    ) VALUES (
      'migration-rehearsal-purchase-mutation-source',
      1,
      'USD',
      'REFUND',
      'migration-rehearsal-purchase-mutation-source',
      CURRENT_TIMESTAMP
    );
    UPDATE "Transaction"
       SET "type" = 'PURCHASE',
           "amount" = -100,
           "walletId" = 'migration-rehearsal-organization-wallet',
           "orderId" = 'migration-rehearsal-settlement-order'
     WHERE "id" = 'migration-rehearsal-purchase-mutation-source';
    RAISE EXCEPTION 'Existing ledger row was repurposed into PURCHASE evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'purchase ledger evidence is insert-only and append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Website"
       SET "publisherId" = 'migration-rehearsal-empty-publisher'
     WHERE "id" = 'migration-rehearsal-metrics-website';
    RAISE EXCEPTION 'Ordered Website accepted publisher reassignment';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'website publisher and ownership identity is immutable after order creation' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Website"
       SET "ownershipType" = 'PLATFORM'
     WHERE "id" = 'migration-rehearsal-metrics-website';
    RAISE EXCEPTION 'Ordered Website accepted ownership reassignment';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'website publisher and ownership identity is immutable after order creation' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "platformFeeBps",
      "feePolicyVersion", "status", "settledAt", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-cancelled-origin',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      100,
      'USD',
      20,
      80,
      2000,
      'platform-settings:platform-settings-default:v1',
      'CANCELLED',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION
      'CANCELLED settlement originated fabricated release evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement release timestamp can only originate on a RELEASED transition' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-missing-fee-policy',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      100,
      'USD',
      20,
      80,
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted a missing fee-policy snapshot';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement identity blocked: fee split lacks the active versioned policy' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "platformFeeBps",
      "feePolicyVersion", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-wrong-fee-policy',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      100,
      'USD',
      20,
      80,
      2000,
      'platform-settings:platform-settings-default:v999',
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted a stale/unknown fee-policy snapshot';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement identity blocked: fee split lacks the active versioned policy' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "platformFeeBps",
      "feePolicyVersion", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-split',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      100,
      'USD',
      20,
      70,
      2000,
      'platform-settings:platform-settings-default:v1',
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted an unbalanced amount split';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM 'Settlement_amount_split_check' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "platformFeeBps",
      "feePolicyVersion", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-order-amount',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      99,
      'USD',
      19.8,
      79.2,
      2000,
      'platform-settings:platform-settings-default:v1',
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted a gross amount unlike its order';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement identity blocked: gross amount does not match order' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Settlement" (
      "id", "orderId", "publisherId", "grossAmount", "currency",
      "platformFee", "publisherAmount", "platformFeeBps",
      "feePolicyVersion", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-publisher',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-empty-publisher',
      100,
      'USD',
      20,
      80,
      2000,
      'platform-settings:platform-settings-default:v1',
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted a publisher unlike its order website';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement identity blocked: publisher does not match order website' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "Settlement" (
    "id", "orderId", "publisherId", "grossAmount", "currency",
    "platformFee", "publisherAmount", "platformFeeBps",
    "feePolicyVersion", "status", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-settlement',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-publisher',
    100,
    'USD',
    20,
    80,
    2000,
    'platform-settings:platform-settings-default:v1',
    'PENDING',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  INSERT INTO "SettlementApproval" (
    "id", "settlementId", "type", "approvedBy", "roleAtTime", "approvedAt"
  ) VALUES (
    'migration-rehearsal-auto-release-approval',
    'migration-rehearsal-settlement',
    'ADMIN',
    'SYSTEM_AUTO_RELEASE',
    'SYSTEM',
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "Settlement"
       SET "status" = 'RELEASED',
           "settledAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'migration-rehearsal-settlement';
    RAISE EXCEPTION
      'Automated settlement released without fresh successful link evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'automated settlement release blocked: fresh successful link-recheck evidence is missing' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "DeliveryVerificationEvidence" (
    "id", "deliveryVersionId", "resolvedUrl", "httpStatus",
    "anchorFound", "linkFound", "targetUrlMatched", "htmlHash",
    "checkedAt", "createdAt"
  ) VALUES (
    'migration-rehearsal-stale-auto-release-recheck',
    'migration-rehearsal-settlement-delivery',
    'https://metrics-rehearsal.invalid/rehearsal-article',
    200,
    TRUE,
    TRUE,
    TRUE,
    repeat('b', 64),
    CURRENT_TIMESTAMP - INTERVAL '12 hours 1 second',
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "Settlement"
       SET "status" = 'RELEASED',
           "settledAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'migration-rehearsal-settlement';
    RAISE EXCEPTION
      'Automated settlement released against stale link evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'automated settlement release blocked: fresh successful link-recheck evidence is missing' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "DeliveryVerificationEvidence" (
    "id", "deliveryVersionId", "resolvedUrl", "httpStatus",
    "anchorFound", "linkFound", "targetUrlMatched", "htmlHash",
    "checkedAt", "createdAt"
  ) VALUES (
    'migration-rehearsal-auto-release-recheck',
    'migration-rehearsal-settlement-delivery',
    'https://metrics-rehearsal.invalid/rehearsal-article',
    200,
    TRUE,
    TRUE,
    TRUE,
    repeat('a', 64),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "Order"
       SET "amount" = 101,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'migration-rehearsal-settlement-order';
    RAISE EXCEPTION 'Paid Order contract changed after payment capture';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order financial and publisher-attribution snapshot is immutable after payment capture' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Settlement"
       SET "status" = 'RELEASED',
           "settledAt" = CURRENT_TIMESTAMP,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'migration-rehearsal-settlement';
    SET CONSTRAINTS "Settlement_release_evidence_required" IMMEDIATE;
    RAISE EXCEPTION 'Settlement released without matching ledger evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'released settlement requires matching release ledger evidence' THEN
        RAISE;
      END IF;
  END;

  released_at := CURRENT_TIMESTAMP;
  UPDATE "Settlement"
     SET "status" = 'RELEASED',
         "settledAt" = released_at,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-settlement';

  INSERT INTO "Transaction" (
    "id", "amount", "currency", "type", "reference", "orderId",
    "publisherId", "settlementId", "createdAt"
  ) VALUES (
    'migration-rehearsal-settlement-release',
    80,
    'USD',
    'SETTLEMENT_RELEASE',
    'settlement:migration-rehearsal-settlement',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-publisher',
    'migration-rehearsal-settlement',
    CURRENT_TIMESTAMP
  );

  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  -- PostgreSQL stores Prisma timestamps at millisecond precision. Compare the
  -- persisted release evidence, not the session's higher-precision value.
  SELECT "settledAt"
    INTO released_at
    FROM "Settlement"
   WHERE "id" = 'migration-rehearsal-settlement';

  BEGIN
    INSERT INTO "Transaction" (
      "id", "amount", "currency", "type", "reference", "orderId",
      "publisherId", "settlementId", "createdAt"
    ) VALUES (
      'migration-rehearsal-duplicate-settlement-release',
      80,
      'USD',
      'SETTLEMENT_RELEASE',
      'settlement:migration-rehearsal-settlement:duplicate',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-publisher',
      'migration-rehearsal-settlement',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Settlement accepted duplicate release ledger evidence';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  UPDATE "Settlement"
     SET "status" = 'CANCELLED',
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-settlement';
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;

  SELECT "settledAt"
    INTO cancelled_settled_at
    FROM "Settlement"
   WHERE "id" = 'migration-rehearsal-settlement'
     AND "status" = 'CANCELLED';
  IF cancelled_settled_at IS DISTINCT FROM released_at THEN
    RAISE EXCEPTION
      'RELEASED to CANCELLED transition did not retain prior release evidence';
  END IF;

  BEGIN
    UPDATE "Settlement"
       SET "settledAt" = "settledAt" + INTERVAL '1 second'
     WHERE "id" = 'migration-rehearsal-settlement';
    RAISE EXCEPTION 'Post-release cancellation changed its settledAt evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement release timestamp is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Settlement"
       SET "status" = 'PENDING'
     WHERE "id" = 'migration-rehearsal-settlement';
    RAISE EXCEPTION 'Cancelled settlement left its terminal state';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'cancelled settlement is terminal; create a new reviewed settlement instead' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "Settlement"
     WHERE "id" = 'migration-rehearsal-settlement';
    RAISE EXCEPTION 'Settlement append-only guard accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'settlement evidence is append-only; cancel it instead of deleting it' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Order" (
      "id", "type", "customerId", "organizationId", "idempotencyKey",
      "requestFingerprint", "amount", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-padded-idempotency',
      'GUEST_POST',
      'migration-rehearsal-publisher-owner',
      'migration-rehearsal-org',
      ' padded-idempotency ',
      repeat('d', 64),
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted a padded idempotency key';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_constraint = CONSTRAINT_NAME;
      IF rejection_constraint IS DISTINCT FROM
         'Order_idempotencyKey_format_check' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Order" (
      "id", "type", "customerId", "organizationId", "idempotencyKey",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-unbound-idempotency',
      'GUEST_POST',
      'migration-rehearsal-publisher-owner',
      'migration-rehearsal-org',
      'missing-fingerprint',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted an idempotency key without payload binding';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'new idempotent order requires a canonical request fingerprint' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO "Order" (
      "id", "type", "customerId", "organizationId", "requestFingerprint",
      "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-rejected-orphan-fingerprint',
      'GUEST_POST',
      'migration-rehearsal-publisher-owner',
      'migration-rehearsal-org',
      repeat('a', 64),
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted a request fingerprint without an idempotency key';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order request fingerprint requires an idempotency key' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "Order" (
    "id", "type", "customerId", "organizationId", "idempotencyKey",
    "requestFingerprint", "amount", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-bound-idempotency',
    'GUEST_POST',
    'migration-rehearsal-publisher-owner',
    'migration-rehearsal-org',
    'bound-idempotency',
    repeat('b', 64),
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    UPDATE "Order"
       SET "requestFingerprint" = repeat('c', 64)
     WHERE "id" = 'migration-rehearsal-bound-idempotency';
    RAISE EXCEPTION 'Order accepted idempotency payload rebinding';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order tenant, customer, and idempotency identity is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Order"
       SET "revisionRoundsSnapshot" = 3
     WHERE "id" = 'migration-rehearsal-settlement-order';
    RAISE EXCEPTION 'Order accepted revision entitlement mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order listing-service contract snapshot is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "Order"
       SET "listingServiceId" = NULL
     WHERE "id" = 'migration-rehearsal-settlement-order';
    RAISE EXCEPTION 'Order accepted listing-service contract rebinding';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'order listing-service contract snapshot is immutable' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "Revision" (
    "id", "orderId", "notes", "status", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-active-revision-one',
    'migration-rehearsal-bound-idempotency',
    'First active revision rehearsal',
    'REQUESTED',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "Revision" (
      "id", "orderId", "notes", "status", "createdAt", "updatedAt"
    ) VALUES (
      'migration-rehearsal-active-revision-duplicate',
      'migration-rehearsal-bound-idempotency',
      'Duplicate active revision must be rejected',
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Order accepted two simultaneously active revisions';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  UPDATE "Revision"
     SET "status" = 'APPROVED', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-active-revision-one';

  INSERT INTO "Revision" (
    "id", "orderId", "notes", "status", "createdAt", "updatedAt"
  ) VALUES (
    'migration-rehearsal-active-revision-two',
    'migration-rehearsal-bound-idempotency',
    'Second round is valid after the first became terminal',
    'REQUESTED',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  UPDATE "Revision"
     SET "status" = 'REJECTED', "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'migration-rehearsal-active-revision-two';

  BEGIN
    INSERT INTO "DeliveryFraudFlag" (
      "id", "orderId", "deliveryVersionId", "type", "details", "createdAt"
    ) VALUES (
      'migration-rehearsal-rejected-mismatched-fraud',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-nonexistent-delivery',
      'LINK_REMOVED',
      '{"source":"migration-rehearsal"}'::jsonb,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Fraud evidence accepted a delivery/order mismatch';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud evidence does not match its order' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "DeliveryFraudFlag" (
    "id", "orderId", "deliveryVersionId", "type", "details", "createdAt"
  ) VALUES (
    'migration-rehearsal-fraud-evidence',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-settlement-delivery',
    'LINK_REMOVED',
    '{"source":"migration-rehearsal"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "DeliveryFraudFlag" (
      "id", "orderId", "deliveryVersionId", "type", "details", "createdAt"
    ) VALUES (
      'migration-rehearsal-duplicate-fraud-evidence',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-settlement-delivery',
      'LINK_REMOVED',
      '{"source":"duplicate"}'::jsonb,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Duplicate delivery fraud evidence was accepted';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  IF NOT "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Unresolved delivery fraud was not visible to the canonical gate';
  END IF;

  INSERT INTO "DeliveryVerificationEvidence" (
    "id", "deliveryVersionId", "resolvedUrl", "httpStatus",
    "anchorFound", "linkFound", "targetUrlMatched", "htmlHash",
    "checkedAt", "createdAt"
  ) VALUES (
    'migration-rehearsal-link-restored-evidence',
    'migration-rehearsal-settlement-delivery',
    'https://metrics-rehearsal.invalid/rehearsal-article',
    200,
    TRUE,
    TRUE,
    TRUE,
    repeat('e', 64),
    CURRENT_TIMESTAMP + INTERVAL '1 second',
    CURRENT_TIMESTAMP
  );

  INSERT INTO "DeliveryFraudFlagResolution" (
    "id", "fraudFlagId", "orderId", "deliveryVersionId", "kind",
    "reason", "resolvedByUserId", "resolvedByRole", "evidenceId",
    "evidence", "createdAt"
  ) VALUES (
    'migration-rehearsal-link-restored-resolution',
    'migration-rehearsal-fraud-evidence',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-settlement-delivery',
    'LINK_RESTORED',
    'Automated rehearsal confirmed that the required live link was restored.',
    NULL,
    NULL,
    'migration-rehearsal-link-restored-evidence',
    '{"source":"migration-rehearsal"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  IF "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Resolved delivery fraud still blocks the canonical gate';
  END IF;

  -- A later recurrence is new evidence, not a rewrite of the first flag.
  INSERT INTO "DeliveryFraudFlag" (
    "id", "orderId", "deliveryVersionId", "type", "details", "createdAt"
  ) VALUES (
    'migration-rehearsal-recurrent-fraud-evidence',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-settlement-delivery',
    'LINK_REMOVED',
    '{"source":"recurrent"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  IF NOT "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Recurrent delivery fraud did not reopen the canonical hold';
  END IF;

  BEGIN
    INSERT INTO "DeliveryFraudHold" (
      "fraudFlagId", "orderId", "deliveryVersionId", "type", "createdAt"
    ) VALUES (
      'migration-rehearsal-nonexistent-fraud-flag',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-settlement-delivery',
      'LINK_REMOVED',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Delivery fraud hold accepted a fabricated projection';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud hold must exactly project an unresolved immutable flag' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "DeliveryFraudHold"
       SET "type" = "type"
     WHERE "fraudFlagId" = 'migration-rehearsal-recurrent-fraud-evidence';
    RAISE EXCEPTION 'Delivery fraud hold accepted direct mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud holds cannot be updated' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "DeliveryFraudHold"
     WHERE "fraudFlagId" = 'migration-rehearsal-recurrent-fraud-evidence';
    SET CONSTRAINTS "DeliveryFraudHold_delete_requires_resolution" IMMEDIATE;
    RAISE EXCEPTION 'Delivery fraud hold accepted deletion without resolution';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud hold deletion requires matching immutable resolution evidence' THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM "DeliveryFraudHold"
    WHERE "fraudFlagId" = 'migration-rehearsal-recurrent-fraud-evidence'
  ) THEN
    RAISE EXCEPTION 'Rejected direct hold deletion was not rolled back';
  END IF;

  BEGIN
    INSERT INTO "DeliveryFraudFlagResolution" (
      "id", "fraudFlagId", "orderId", "deliveryVersionId", "kind",
      "reason", "resolvedByUserId", "resolvedByRole", "evidence", "createdAt"
    ) VALUES (
      'migration-rehearsal-rejected-nonstaff-resolution',
      'migration-rehearsal-recurrent-fraud-evidence',
      'migration-rehearsal-settlement-order',
      'migration-rehearsal-settlement-delivery',
      'STAFF_CLEARED',
      'A non-staff identity must never clear a settlement fraud hold.',
      'migration-rehearsal-publisher-owner',
      'FINANCE',
      '{"source":"unauthorized","disposition":"FALSE_POSITIVE"}'::jsonb,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'Non-staff identity cleared delivery fraud evidence';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'staff-cleared fraud resolution requires an active allowed staff role' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO "DeliveryFraudFlagResolution" (
    "id", "fraudFlagId", "orderId", "deliveryVersionId", "kind",
    "reason", "resolvedByUserId", "resolvedByRole", "evidence", "createdAt"
  ) VALUES (
    'migration-rehearsal-staff-fraud-resolution',
    'migration-rehearsal-recurrent-fraud-evidence',
    'migration-rehearsal-settlement-order',
    'migration-rehearsal-settlement-delivery',
    'STAFF_CLEARED',
    'Finance reviewed the recurrent signal and cleared it with documented evidence.',
    'migration-rehearsal-finance',
    'FINANCE',
    '{"source":"staff-review","disposition":"RISK_ACCEPTED","evidenceReference":"migration-rehearsal-case-link-review-002"}'::jsonb,
    CURRENT_TIMESTAMP
  );

  IF "has_unresolved_delivery_fraud"(
    'migration-rehearsal-settlement-order'
  ) THEN
    RAISE EXCEPTION 'Staff-cleared delivery fraud still blocks the canonical gate';
  END IF;

  BEGIN
    UPDATE "DeliveryFraudFlagResolution"
       SET "reason" = 'Rewritten resolution evidence is forbidden by policy.'
     WHERE "id" = 'migration-rehearsal-staff-fraud-resolution';
    RAISE EXCEPTION 'Delivery fraud resolution evidence accepted mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud resolution evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "DeliveryFraudFlagResolution"
     WHERE "id" = 'migration-rehearsal-staff-fraud-resolution';
    RAISE EXCEPTION 'Delivery fraud resolution evidence accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud resolution evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "DeliveryFraudFlag"
       SET "details" = '{"source":"rewritten"}'::jsonb
     WHERE "id" = 'migration-rehearsal-fraud-evidence';
    RAISE EXCEPTION 'Delivery fraud evidence accepted mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud evidence is insert-only and append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "DeliveryFraudFlag"
     WHERE "id" = 'migration-rehearsal-fraud-evidence';
    RAISE EXCEPTION 'Delivery fraud evidence accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery fraud evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "DeliveryVerificationEvidence"
       SET "httpStatus" = 204
     WHERE "id" = 'migration-rehearsal-link-restored-evidence';
    RAISE EXCEPTION 'Delivery verification evidence accepted mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery verification evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "DeliveryVerificationEvidence"
     WHERE "id" = 'migration-rehearsal-link-restored-evidence';
    RAISE EXCEPTION 'Delivery verification evidence accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery verification evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    UPDATE "DeliverySnapshot"
       SET "htmlObjectKey" = 'deliveries/rewritten.html'
     WHERE "id" = 'migration-rehearsal-delivery-snapshot';
    RAISE EXCEPTION 'Delivery snapshot evidence accepted mutation';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery snapshot evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM "DeliverySnapshot"
     WHERE "id" = 'migration-rehearsal-delivery-snapshot';
    RAISE EXCEPTION 'Delivery snapshot evidence accepted deletion';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS rejection_message = MESSAGE_TEXT;
      IF rejection_message IS DISTINCT FROM
         'delivery snapshot evidence is append-only' THEN
        RAISE;
      END IF;
  END;

  IF EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlag" flag
    LEFT JOIN "DeliveryFraudFlagResolution" resolution
      ON resolution."fraudFlagId" = flag."id"
    LEFT JOIN "DeliveryFraudHold" hold
      ON hold."fraudFlagId" = flag."id"
    WHERE (resolution."id" IS NULL) IS DISTINCT FROM (hold."fraudFlagId" IS NOT NULL)
       OR (
         hold."fraudFlagId" IS NOT NULL
         AND (
           hold."orderId" IS DISTINCT FROM flag."orderId"
           OR hold."deliveryVersionId" IS DISTINCT FROM flag."deliveryVersionId"
           OR hold."type" IS DISTINCT FROM flag."type"
           OR hold."createdAt" IS DISTINCT FROM flag."createdAt"
         )
       )
  ) OR EXISTS (
    SELECT 1
    FROM "DeliveryFraudHold" hold
    LEFT JOIN "DeliveryFraudFlag" flag ON flag."id" = hold."fraudFlagId"
    WHERE flag."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Fraud flag/resolution/current-hold projection is inconsistent';
  END IF;

  -- Positive policy-change control: fee changes are allowed only with the
  -- exact next version, and historical settlement snapshots remain v1.
  UPDATE "PlatformSettings"
     SET "platformFeePct" = 21,
         "version" = 2,
         "updatedAt" = CURRENT_TIMESTAMP
   WHERE "id" = 'platform-settings-default';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Platform fee policy positive control found no singleton';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "PlatformSettings"
    WHERE "id" = 'platform-settings-default'
      AND "platformFeePct" = 21
      AND "version" = 2
  ) OR NOT EXISTS (
    SELECT 1 FROM "Settlement"
    WHERE "id" = 'migration-rehearsal-settlement'
      AND "platformFeeBps" = 2000
      AND "feePolicyVersion" =
        'platform-settings:platform-settings-default:v1'
  ) OR NOT EXISTS (
    SELECT 1 FROM "PlatformRevenue"
    WHERE "id" = 'migration-rehearsal-platform-revenue'
      AND "platformFeeBps" = 2000
      AND "feePolicyVersion" =
        'platform-settings:platform-settings-default:v1'
  ) THEN
    RAISE EXCEPTION
      'Versioned fee-policy transition rewrote historical settlement evidence';
  END IF;
END;
$$;
