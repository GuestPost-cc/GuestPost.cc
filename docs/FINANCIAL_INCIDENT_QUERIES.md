# Financial integrity incident queries

These PostgreSQL queries are read-only evidence tools for Finance/Security
incidents and release verification. Run them against a snapshot or with a
read-only role. Store the release SHA, database branch, query time, row count,
and provider environment with the incident.

Do not turn a query result directly into a balance update. This release ships
no generic financial-repair or balance-adjustment command. A nonzero finding
blocks reopening the affected money path until provider truth is established
and an incident-specific, typed, idempotent compensation command is designed,
reviewed, implemented, and tested.

## Deployment identity

Before interpreting data, record:

```sql
SELECT current_database(), current_user, now();
SELECT migration_name, finished_at
FROM "_prisma_migrations"
WHERE rolled_back_at IS NULL
ORDER BY finished_at DESC NULLS LAST
LIMIT 10;
```

Record the API and worker image/Git SHA from the deployment platform
separately. Database migration state does not prove which application version
is running.

### Runtime database-role authority

Run this through the same `DATABASE_URL` used by the API and worker, never
through the migration job's owner connection. It must return zero rows:

```sql
WITH runtime_role AS (
  SELECT
    roles.oid,
    roles.rolname,
    roles.rolsuper,
    roles.rolcreaterole,
    roles.rolcreatedb,
    roles.rolreplication,
    roles.rolbypassrls
  FROM pg_roles roles
  WHERE roles.rolname = current_user
),
financial_relations AS (
  SELECT
    relation.oid,
    relation.relname,
    relation.relowner
  FROM pg_class relation
  JOIN pg_namespace namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = current_schema()
    AND relation.relkind IN ('r', 'p')
    AND relation.relname IN (
      'Wallet',
      'Transaction',
      'DepositAttempt',
      'PaymentProviderEvent',
      'PaymentDispute',
      'PublisherBalance',
      'Withdrawal',
      'WithdrawalAllocation',
      'PayoutMethod',
      'PublisherProviderAccount',
      'PayoutProvider',
      'PayoutExecution',
      'PayoutExecutionClaim',
      'PayoutWebhookEvent',
      'MarketplaceListing',
      'ListingService',
      'Order',
      'OrderItem',
      'Website',
      'Settlement',
      'PlatformSettings',
      'PlatformRevenue',
      'OrderDeliveryVersion',
      'DeliveryVerificationEvidence',
      'DeliverySnapshot',
      'DeliveryFraudFlag',
      'DeliveryFraudHold',
      'DeliveryFraudFlagResolution',
      'Revision',
      'OrderDispute',
      'OrderCancellationRequest'
    )
)
SELECT
  runtime_role.rolname AS runtime_role,
  runtime_role.rolsuper,
  runtime_role.rolcreaterole,
  runtime_role.rolcreatedb,
  runtime_role.rolreplication,
  runtime_role.rolbypassrls,
  has_schema_privilege(
    runtime_role.rolname,
    current_schema(),
    'CREATE'
  ) AS can_create_in_application_schema,
  financial_relations.relname AS owned_or_trigger_capable_relation,
  pg_get_userbyid(financial_relations.relowner) AS relation_owner,
  has_table_privilege(
    runtime_role.rolname,
    financial_relations.oid,
    'TRIGGER'
  ) AS has_trigger_privilege
FROM runtime_role
LEFT JOIN financial_relations
  ON pg_has_role(
    runtime_role.rolname,
    pg_get_userbyid(financial_relations.relowner),
    'MEMBER'
  )
  OR has_table_privilege(
    runtime_role.rolname,
    financial_relations.oid,
    'TRIGGER'
  )
WHERE runtime_role.rolsuper
   OR runtime_role.rolcreaterole
   OR runtime_role.rolcreatedb
   OR runtime_role.rolreplication
   OR runtime_role.rolbypassrls
   OR has_schema_privilege(
     runtime_role.rolname,
     current_schema(),
     'CREATE'
   )
   OR financial_relations.oid IS NOT NULL;
```

The API/worker role needs only the reviewed runtime DML and sequence
privileges. It must not be a superuser, database/schema creator, member of the
schema-owner role, relation owner, `BYPASSRLS`, or able to create/replace
triggers. `DIRECT_DATABASE_URL` belongs only to the isolated deploy migration
job. A runtime role with owner/DDL authority can disable the database
financial guards and is a release blocker.

### Unvalidated financial constraints

This query must return zero rows after both the populated-clone rehearsal and
the production migration:

```sql
SELECT
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  constraint_row.conname AS constraint_name,
  constraint_row.contype AS constraint_type,
  constraint_row.convalidated
FROM pg_constraint AS constraint_row
JOIN pg_class AS relation
  ON relation.oid = constraint_row.conrelid
JOIN pg_namespace AS namespace
  ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = current_schema()
  AND relation.relname IN (
    'Wallet',
    'Transaction',
    'DepositAttempt',
    'PaymentProviderEvent',
    'PaymentDispute',
    'PublisherBalance',
    'Withdrawal',
    'WithdrawalAllocation',
    'PayoutMethod',
    'PublisherProviderAccount',
    'PayoutProvider',
    'PayoutExecution',
    'PayoutExecutionClaim',
    'PayoutWebhookEvent',
    'MarketplaceListing',
    'ListingService',
    'Order',
    'OrderItem',
    'Website',
    'Settlement',
    'PlatformSettings',
    'PlatformRevenue',
    'OrderDeliveryVersion',
    'DeliveryVerificationEvidence',
    'DeliverySnapshot',
    'DeliveryFraudFlag',
    'DeliveryFraudHold',
    'DeliveryFraudFlagResolution',
    'Revision',
    'OrderDispute',
    'OrderCancellationRequest'
  )
  AND constraint_row.convalidated = FALSE
ORDER BY relation.relname, constraint_row.conname;
```

Do not treat a present `NOT VALID` financial constraint as installed
protection. Preserve the failed rows, determine why validation did not
complete, and keep finance gates closed.

## Paid-order and settlement accounting identity

Each statement below must return zero rows. First, prove every paid Order has
one exact wallet capture rather than only a status flag:

```sql
SELECT
  o.id AS order_id,
  o."organizationId",
  o.amount AS order_amount,
  o.currency AS order_currency,
  evidence.purchase_count,
  evidence.identity_matches
FROM "Order" o
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS purchase_count,
    COALESCE(BOOL_AND(
      p.amount = -o.amount
      AND p.currency = o.currency
      AND p.currency = 'USD'
      AND p."publisherId" IS NULL
      AND p."settlementId" IS NULL
      AND p.provider IS NULL
      AND p."providerRef" IS NULL
      AND w.id IS NOT NULL
      AND w.currency = o.currency
      AND w."organizationId" = o."organizationId"
    ), FALSE) AS identity_matches
  FROM "Transaction" p
  LEFT JOIN "Wallet" w ON w.id = p."walletId"
  WHERE p."orderId" = o.id AND p.type = 'PURCHASE'
) evidence ON TRUE
WHERE (
    o."paymentStatus" IN ('PAID', 'REFUNDED')
    AND (
      o.currency <> 'USD'
      OR o.amount IS NULL
      OR o.amount <= 0
      OR o.amount * 100 <> trunc(o.amount * 100)
      OR evidence.purchase_count <> 1
      OR NOT evidence.identity_matches
    )
  )
  OR (
    o."paymentStatus" NOT IN ('PAID', 'REFUNDED')
    AND evidence.purchase_count <> 0
  )
ORDER BY o."createdAt";

-- Catalog/cart facts must be positive and exactly representable in USD cents.
-- Any result blocks the USD-boundary migration; never round these rows in
-- place because their original commercial intent must be reconciled.
SELECT 'MarketplaceListing' AS relation_name, id, NULL::NUMERIC AS amount
FROM "MarketplaceListing"
WHERE currency <> 'USD'
UNION ALL
SELECT 'ListingService', id, price
FROM "ListingService"
WHERE currency <> 'USD'
   OR price <= 0
   OR price * 100 <> trunc(price * 100)
UNION ALL
SELECT 'Order', id, amount
FROM "Order"
WHERE currency <> 'USD'
   OR amount IS NULL
   OR amount <= 0
   OR amount * 100 <> trunc(amount * 100)
UNION ALL
SELECT 'OrderItem', id, price
FROM "OrderItem"
WHERE price IS NULL
   OR price <= 0
   OR price * 100 <> trunc(price * 100);

-- A captured/purchased/settled Order contract has at least one line, one
-- website identity, and an exact header-to-line total. Item status remains the
-- immutable checkout status; fulfillment evidence lives on its own models.
SELECT
  o.id AS order_id,
  o."paymentStatus",
  o.amount AS order_amount,
  item_facts.item_count,
  item_facts.item_total,
  item_facts.invalid_item_count
FROM "Order" o
CROSS JOIN LATERAL (
  SELECT
    COUNT(*) AS item_count,
    SUM(i.price) AS item_total,
    COUNT(*) FILTER (
      WHERE i.status <> 'PENDING_PAYMENT'
         OR i."websiteId" IS DISTINCT FROM o."websiteId"
    ) AS invalid_item_count
  FROM "OrderItem" i
  WHERE i."orderId" = o.id
) item_facts
WHERE (
    o."paymentStatus" = 'PAID'
    OR EXISTS (
      SELECT 1 FROM "Transaction" p
      WHERE p."orderId" = o.id AND p.type = 'PURCHASE'
    )
    OR EXISTS (
      SELECT 1 FROM "Settlement" s
      WHERE s."orderId" = o.id
    )
  )
  AND (
    o."websiteId" IS NULL
    OR item_facts.item_count = 0
    OR item_facts.item_total IS DISTINCT FROM o.amount
    OR item_facts.invalid_item_count > 0
  )
ORDER BY o."createdAt";

-- Captured liability attribution must resolve through one exact relational
-- catalog chain. Do not compare historical Order terms with today's mutable
-- service type, pricing, turnaround, warranty, revision, currency, or owner
-- terms; those are not evidence of the contract at capture time.
SELECT
  o.id AS order_id,
  o."listingId" AS order_listing_id,
  o."listingServiceId" AS order_service_id,
  o."websiteId" AS order_website_id,
  ls."listingId" AS service_listing_id,
  ml."websiteId" AS listing_website_id,
  w.id AS resolved_website_id
FROM "Order" o
LEFT JOIN "ListingService" ls ON ls.id = o."listingServiceId"
LEFT JOIN "MarketplaceListing" ml ON ml.id = ls."listingId"
LEFT JOIN "Website" w ON w.id = ml."websiteId"
WHERE (
    o."paymentStatus" IN ('PAID', 'REFUNDED')
    OR EXISTS (
      SELECT 1 FROM "Transaction" p
      WHERE p."orderId" = o.id AND p.type = 'PURCHASE'
    )
    OR EXISTS (
      SELECT 1 FROM "Settlement" s WHERE s."orderId" = o.id
    )
  )
  AND (
    ls.id IS NULL
    OR ml.id IS NULL
    OR w.id IS NULL
    OR o."listingId" IS DISTINCT FROM ls."listingId"
    OR o."listingId" IS DISTINCT FROM ml.id
    OR o."websiteId" IS DISTINCT FROM ml."websiteId"
    OR o."websiteId" IS DISTINCT FROM w.id
  )
ORDER BY o."createdAt";

SELECT COUNT(*) AS platform_settings_rows
FROM "PlatformSettings"
HAVING COUNT(*) <> 1;

SELECT
  s.id AS settlement_id,
  s.status,
  s."orderId",
  s."publisherId",
  s."grossAmount",
  s.currency,
  s."platformFee",
  s."publisherAmount",
  s."platformFeeBps",
  s."feePolicyVersion"
FROM "Settlement" s
LEFT JOIN "Order" o ON o.id = s."orderId"
LEFT JOIN "Website" w ON w.id = o."websiteId"
CROSS JOIN "PlatformSettings" p
WHERE s.currency <> 'USD'
   OR o.currency IS DISTINCT FROM s.currency
   OR o.amount IS DISTINCT FROM s."grossAmount"
   OR w."publisherId" IS DISTINCT FROM s."publisherId"
   OR s."grossAmount" <> s."platformFee" + s."publisherAmount"
   OR (
     s.status NOT IN ('RELEASED', 'CANCELLED')
     AND (
       s."platformFeeBps" IS DISTINCT FROM (p."platformFeePct" * 100)::INTEGER
       OR s."feePolicyVersion" IS DISTINCT FROM
          format('platform-settings:%s:v%s', p.id, p.version)
       OR s."platformFee" IS DISTINCT FROM
          round(s."grossAmount" * p."platformFeePct" / 100, 2)
     )
   )
   OR (
     s.status = 'RELEASED'
     AND 1 IS DISTINCT FROM (
       SELECT COUNT(*)
       FROM "Transaction" r
       WHERE r."settlementId" = s.id
         AND r.type = 'SETTLEMENT_RELEASE'
         AND r.amount = s."publisherAmount"
         AND r.currency = s.currency
         AND r."orderId" = s."orderId"
         AND r."publisherId" = s."publisherId"
         AND r."walletId" IS NULL
         AND r.provider IS NULL
         AND r."providerRef" IS NULL
     )
   )
ORDER BY s."createdAt";

SELECT
  revenue.id AS platform_revenue_id,
  revenue."orderId",
  revenue.amount,
  revenue.currency,
  revenue."platformFee",
  revenue."netRevenue",
  revenue."platformFeeBps",
  revenue."feePolicyVersion",
  revenue."fulfillmentChannel",
  revenue."reversedAt",
  order_row.status AS order_status,
  order_row."paymentStatus" AS order_payment_status,
  purchase.purchase_count,
  purchase.identity_matches
FROM "PlatformRevenue" revenue
LEFT JOIN "Order" order_row ON order_row.id = revenue."orderId"
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS purchase_count,
    COALESCE(bool_and(
      ledger.amount = -revenue.amount
      AND ledger.currency = 'USD'
      AND ledger."publisherId" IS NULL
      AND ledger."settlementId" IS NULL
      AND ledger.provider IS NULL
      AND ledger."providerRef" IS NULL
      AND wallet.currency = 'USD'
      AND wallet."organizationId" = order_row."organizationId"
    ), FALSE) AS identity_matches
  FROM "Transaction" ledger
  LEFT JOIN "Wallet" wallet ON wallet.id = ledger."walletId"
  WHERE ledger."orderId" = revenue."orderId"
    AND ledger.type = 'PURCHASE'
) purchase ON TRUE
WHERE order_row.id IS NULL
   OR revenue.currency <> 'USD'
   OR order_row.currency <> 'USD'
   OR order_row.amount IS DISTINCT FROM revenue.amount
   OR order_row."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM'
   OR revenue."fulfillmentChannel" IS DISTINCT FROM 'PLATFORM'
   OR revenue.amount <= 0
   OR revenue."platformFee" < 0
   OR revenue."netRevenue" < 0
   OR revenue.amount * 100 <> trunc(revenue.amount * 100)
   OR revenue."platformFee" * 100 <> trunc(revenue."platformFee" * 100)
   OR revenue."netRevenue" * 100 <> trunc(revenue."netRevenue" * 100)
   OR revenue.amount <> revenue."platformFee" + revenue."netRevenue"
   OR purchase.purchase_count <> 1
   OR NOT purchase.identity_matches
   OR (
     revenue."reversedAt" IS NULL
     AND (
       order_row."paymentStatus" <> 'PAID'
       OR revenue."platformFeeBps" IS NULL
       OR revenue."feePolicyVersion" IS NULL
     )
   )
   OR (
     revenue."platformFeeBps" IS NOT NULL
     AND (
       revenue."platformFeeBps" NOT BETWEEN 0 AND 10000
       OR revenue."feePolicyVersion" IS NULL
       OR revenue."platformFee" IS DISTINCT FROM round(
         revenue.amount * revenue."platformFeeBps"::numeric / 10000,
         2
       )
     )
   )
   OR (
     revenue."platformFeeBps" IS NULL
     AND revenue."feePolicyVersion" IS NOT NULL
   )
   OR (
     revenue."reversedAt" IS NOT NULL
     AND revenue."reversedAt" < revenue."recordedAt"
   )
ORDER BY revenue."recordedAt";

SELECT
  CASE
    WHEN delivery.id IS NULL
      OR flag."orderId" IS DISTINCT FROM delivery."orderId"
      THEN 'FLAG_DELIVERY_IDENTITY_MISMATCH'
    WHEN resolution.id IS NULL AND hold."fraudFlagId" IS NULL
      THEN 'UNRESOLVED_FLAG_MISSING_HOLD'
    WHEN resolution.id IS NULL AND (
      hold."orderId" IS DISTINCT FROM flag."orderId"
      OR hold."deliveryVersionId" IS DISTINCT FROM flag."deliveryVersionId"
      OR hold.type IS DISTINCT FROM flag.type
      OR hold."createdAt" IS DISTINCT FROM flag."createdAt"
    ) THEN 'HOLD_FLAG_IDENTITY_MISMATCH'
    WHEN resolution.id IS NOT NULL AND hold."fraudFlagId" IS NOT NULL
      THEN 'RESOLVED_FLAG_STILL_HELD'
    WHEN resolution.id IS NOT NULL AND (
      resolution."orderId" IS DISTINCT FROM flag."orderId"
      OR resolution."deliveryVersionId" IS DISTINCT FROM flag."deliveryVersionId"
    ) THEN 'RESOLUTION_FLAG_IDENTITY_MISMATCH'
  END AS anomaly,
  flag.id AS fraud_flag_id,
  flag."orderId" AS flag_order_id,
  delivery."orderId" AS delivery_order_id,
  flag."deliveryVersionId",
  flag.type,
  hold."fraudFlagId" AS current_hold_flag_id,
  resolution.id AS resolution_id,
  resolution.kind AS resolution_kind,
  resolution."resolvedByUserId",
  resolution."resolvedByRole",
  resolution."evidenceId",
  resolution."createdAt" AS resolved_at
FROM "DeliveryFraudFlag" flag
LEFT JOIN "OrderDeliveryVersion" delivery
  ON delivery.id = flag."deliveryVersionId"
LEFT JOIN "DeliveryFraudHold" hold
  ON hold."fraudFlagId" = flag.id
LEFT JOIN "DeliveryFraudFlagResolution" resolution
  ON resolution."fraudFlagId" = flag.id
WHERE delivery.id IS NULL
   OR flag."orderId" IS DISTINCT FROM delivery."orderId"
   OR (
     resolution.id IS NULL
     AND (
       hold."fraudFlagId" IS NULL
       OR hold."orderId" IS DISTINCT FROM flag."orderId"
       OR hold."deliveryVersionId" IS DISTINCT FROM flag."deliveryVersionId"
       OR hold.type IS DISTINCT FROM flag.type
       OR hold."createdAt" IS DISTINCT FROM flag."createdAt"
     )
   )
   OR (resolution.id IS NOT NULL AND hold."fraudFlagId" IS NOT NULL)
   OR (
     resolution.id IS NOT NULL
     AND (
       resolution."orderId" IS DISTINCT FROM flag."orderId"
       OR resolution."deliveryVersionId" IS DISTINCT FROM flag."deliveryVersionId"
     )
   )
ORDER BY flag."createdAt", flag.id;
```

An unresolved immutable flag must have one exact current `DeliveryFraudHold`;
a resolved flag must have its immutable adjudication and no hold. Historical
resolved flags are expected and are not corruption. Any query result blocks
settlement creation/release and payout sends. Preserve the rows and compare
the Order, Website, policy version, delivery evidence, ledger, and
provider/bank evidence before designing a typed compensation.

### Automated-release freshness holds

This query is an operational hold inventory, not authority to repair or release
money. Every returned settlement must remain unreleased until the normal link
monitor appends a newer successful observation for the currently active
delivery. Alert when `freshnessBlocked` remains nonzero across two six-hour
sweeps; do not suppress the database gate or insert synthetic evidence.

```sql
SELECT
  s.id AS settlement_id,
  s."orderId" AS order_id,
  o."activeDeliveryVersionId" AS active_delivery_version_id,
  latest.id AS newest_evidence_id,
  latest."checkedAt",
  latest."createdAt",
  latest."httpStatus",
  latest."linkFound",
  latest."targetUrlMatched",
  latest."anchorFound",
  CASE
    WHEN latest.id IS NULL THEN 'MISSING'
    WHEN latest."checkedAt" > now() OR latest."createdAt" > now()
      THEN 'FUTURE_DATED'
    WHEN latest."checkedAt" < now() - interval '12 hours' THEN 'STALE'
    WHEN latest."httpStatus" NOT IN (200, 301, 302)
      OR NOT latest."linkFound"
      OR NOT latest."targetUrlMatched"
      OR NOT latest."anchorFound" THEN 'FAILED'
    ELSE 'FRESH_SUCCESS'
  END AS freshness_state
FROM "Settlement" s
JOIN "Order" o ON o.id = s."orderId"
LEFT JOIN LATERAL (
  SELECT evidence.*
  FROM "DeliveryVerificationEvidence" evidence
  WHERE evidence."deliveryVersionId" = o."activeDeliveryVersionId"
  ORDER BY evidence."checkedAt" DESC,
           evidence."createdAt" DESC,
           evidence.id DESC
  LIMIT 1
) latest ON TRUE
WHERE s.status = 'CUSTOMER_APPROVED'
  AND s."releasePolicy" = 'AUTO'
  AND (
    latest.id IS NULL
    OR latest."checkedAt" > now()
    OR latest."createdAt" > now()
    OR latest."checkedAt" < now() - interval '12 hours'
    OR latest."httpStatus" NOT IN (200, 301, 302)
    OR NOT latest."linkFound"
    OR NOT latest."targetUrlMatched"
    OR NOT latest."anchorFound"
  )
ORDER BY s."updatedAt";
```

## Processed dispute events without a case

Before the `PaymentDispute` migration is deployed, use the legacy evidence
scan:

```sql
SELECT
  e.id AS event_id,
  e."providerEventId",
  e."objectId" AS provider_dispute_id,
  e."processedAt"
FROM "PaymentProviderEvent" e
LEFT JOIN "Transaction" h
  ON h.reference = 'chargeback-hold-' || e."objectId"
 AND h.type = 'RESERVATION'
WHERE e.provider = 'stripe'
  AND e."eventType" = 'charge.dispute.created'
  AND e.status = 'PROCESSED'
  AND h.id IS NULL
ORDER BY e."processedAt";
```

This legacy query detects the provider-reference collision symptom. The
absence of a hold row is not repair evidence by itself; retrieve the current
Stripe dispute before booking the new case.

After the migration, use the durable case scan:

```sql
SELECT
  e.id AS event_id,
  e."providerEventId",
  e."objectId" AS provider_dispute_id,
  e."processedAt",
  e.attempts
FROM "PaymentProviderEvent" e
LEFT JOIN "PaymentDispute" d
  ON d.id = e."paymentDisputeId"
WHERE e.provider = 'stripe'
  AND e."eventType" IN ('charge.dispute.created', 'charge.dispute.closed')
  AND e.status = 'PROCESSED'
  AND (
    d.id IS NULL
    OR d.provider IS DISTINCT FROM e.provider
    OR d."providerDisputeId" IS DISTINCT FROM e."objectId"
    OR d."providerPaymentId" IS DISTINCT FROM e."providerPaymentId"
    OR d."providerChargeId" IS DISTINCT FROM e."providerChargeId"
    OR d.currency IS DISTINCT FROM e."disputeCurrency"
    OR (
      e."disputeCurrency" = 'USD'
      AND e."disputeAmountMinor" IS DISTINCT FROM (d.amount * 100)::BIGINT
    )
    OR (
      e."eventType" = 'charge.dispute.created'
      AND d."openedByEventId" IS DISTINCT FROM e.id
    )
    OR (
      e."eventType" = 'charge.dispute.closed'
      AND d."resolvedByEventId" IS DISTINCT FROM e.id
    )
  )
ORDER BY e."processedAt";
```

Any row is critical. Retrieve the Stripe dispute and linked payment before
repair.

Signed identity collisions against canonical dispute-role evidence are
preserved as incidents instead of rewriting that evidence:

```sql
SELECT
  audit.id AS incident_id,
  audit."createdAt" AS detected_at,
  audit."entityId" AS event_id,
  event."providerEventId",
  event.status AS event_status,
  event."paymentDisputeId",
  dispute."openedByEventId",
  dispute."resolvedByEventId",
  audit.metadata
FROM "AuditLog" audit
JOIN "PaymentProviderEvent" event
  ON event.id = audit."entityId"
LEFT JOIN "PaymentDispute" dispute
  ON dispute.id = event."paymentDisputeId"
WHERE audit.action =
  'PAYMENT_PROVIDER_EVENT_IDENTITY_CONFLICT_DETECTED'
ORDER BY audit."createdAt" DESC;
```

For every row, the event must still be `PROCESSED` and its ID must equal
`openedByEventId` or `resolvedByEventId`. Preserve it as canonical evidence;
retrieve the provider event and dispute independently, investigate the
colliding delivery, and never quarantine or overwrite the designated row.
There is one incident per canonical event and alerts use deterministic
per-user keys, so repeated signed delivery must not multiply either record.

## Deposit and dispute inbox rows requiring action

```sql
SELECT
  e.id,
  e.provider,
  e."providerEventId",
  e."eventType",
  e."objectId",
  e.status,
  e.attempts,
  e."availableAt",
  e."lockedAt",
  e."receivedAt",
  e."processedAt",
  e."lastError",
  e."depositAttemptId",
  e."paymentDisputeId"
FROM "PaymentProviderEvent" e
WHERE e."eventType" IN (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'charge.dispute.created',
    'charge.dispute.closed'
  )
  AND (
    e.status IN ('FAILED', 'QUARANTINED')
    OR (
      e.status = 'PENDING'
      AND e."receivedAt" < now() - interval '15 minutes'
    )
    OR (
      e.status = 'PROCESSING'
      AND (
        e."lockedAt" IS NULL
        OR e."lockedAt" < now() - interval '15 minutes'
      )
    )
  )
ORDER BY e."receivedAt";
```

Every row requires action. Dispute rows may be recovered by the five-minute
durable worker from immutable normalized facts. Checkout-success rows require
a fresh signature-verified Stripe redelivery; the current system has no
independent authenticated Checkout/PaymentIntent catch-up processor. Local
inbox state alone cannot authorize a wallet credit. Do not manually change
status to `PROCESSED` or synthesize a credit from a success redirect.
`attempts` and `lockedAt` together are the current fencing token: after
recovery, evidence from an older pair cannot authorize failure, quarantine, or
completion. Preserve both values in incident notes and compare them again
after every recovery attempt.

Processed deposit-success evidence must also match exactly:

```sql
SELECT
  e.id AS event_id,
  e."providerEventId",
  e."objectId" AS checkout_session_id,
  e."depositAttemptId",
  e.livemode,
  a.status AS attempt_status,
  a."providerSessionId",
  a."providerPaymentId",
  a."ledgerTransactionId",
  deposit.id AS deposit_transaction_id
FROM "PaymentProviderEvent" e
LEFT JOIN "DepositAttempt" a
  ON a.id = e."depositAttemptId"
LEFT JOIN "Transaction" deposit
  ON deposit.id = a."ledgerTransactionId"
WHERE e."eventType" IN (
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded'
  )
  AND e.status = 'PROCESSED'
  AND (
    a.id IS NULL
    OR a.provider IS DISTINCT FROM e.provider
    OR a."providerSessionId" IS DISTINCT FROM e."objectId"
    OR a.status NOT IN (
      'SUCCEEDED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'DISPUTED',
      'CHARGEBACK'
    )
    OR (e.provider = 'stripe' AND e.livemode IS NULL)
    OR deposit.id IS NULL
    OR deposit.type <> 'DEPOSIT'
    OR deposit."walletId" IS DISTINCT FROM a."walletId"
    OR deposit.amount IS DISTINCT FROM a."walletCredit"
    OR deposit.currency IS DISTINCT FROM a.currency
    OR deposit.provider IS DISTINCT FROM a.provider
    OR deposit."providerRef" IS DISTINCT FROM a."providerPaymentId"
  )
ORDER BY e."processedAt";
```

Any row is a critical local-evidence contradiction. Retrieve the Stripe
Checkout Session and PaymentIntent before deciding whether a compensating
wallet action is required. Refund and dispute states are derivative states of
the credited deposit; they must not be treated as proof that the original
credit is missing.

Review Stripe mode evidence separately and compare it with the recorded
deployment/key mode:

```sql
SELECT
  e.livemode,
  e."eventType",
  e.status,
  COUNT(*) AS event_count,
  MIN(e."receivedAt") AS first_received_at,
  MAX(e."receivedAt") AS last_received_at
FROM "PaymentProviderEvent" e
WHERE e.provider = 'stripe'
GROUP BY e.livemode, e."eventType", e.status
ORDER BY e.livemode NULLS FIRST, e."eventType", e.status;
```

Any `livemode IS NULL` Stripe row created after the evidence migration is a
constraint/mixed-writer incident. A test/live value that contradicts the
recorded release environment is a credential or endpoint-boundary incident;
do not infer the intended mode from the event ID.

## Dispute hold and resolution integrity

```sql
SELECT
  d.id,
  d.provider,
  d."providerDisputeId",
  d.status,
  d.amount,
  d.currency,
  d."heldAmount",
  d."shortfallAmount",
  d."currentExposureAmount",
  d."holdTransactionId",
  d."resolutionTransactionId",
  d."openedByEventId",
  d."resolvedByEventId",
  attempt.status AS "depositAttemptStatus",
  d."updatedAt"
FROM "PaymentDispute" d
LEFT JOIN "DepositAttempt" attempt
  ON attempt.id = d."depositAttemptId"
LEFT JOIN "Transaction" deposit
  ON deposit.id = d."depositTransactionId"
LEFT JOIN "Transaction" hold
  ON hold.id = d."holdTransactionId"
LEFT JOIN "Transaction" resolution
  ON resolution.id = d."resolutionTransactionId"
LEFT JOIN "PaymentProviderEvent" opened
  ON opened.id = d."openedByEventId"
LEFT JOIN "PaymentProviderEvent" resolved
  ON resolved.id = d."resolvedByEventId"
WHERE d.amount <= 0
   OR d.currency <> 'USD'
   OR d.amount * 100 <> trunc(d.amount * 100)
   OR d."heldAmount" * 100 <> trunc(d."heldAmount" * 100)
   OR d."shortfallAmount" * 100 <> trunc(d."shortfallAmount" * 100)
   OR d."currentExposureAmount" * 100 <>
      trunc(d."currentExposureAmount" * 100)
   OR d."heldAmount" < 0
   OR d."shortfallAmount" < 0
   OR d."currentExposureAmount" < 0
   OR d."heldAmount" + d."shortfallAmount" <> d.amount
   OR d."currentExposureAmount" <>
      CASE WHEN d.status = 'WON' THEN 0 ELSE d."shortfallAmount" END
   OR deposit.id IS NULL
   OR deposit.type <> 'DEPOSIT'
   OR deposit."walletId" IS DISTINCT FROM d."walletId"
   OR deposit.currency IS DISTINCT FROM d.currency
   OR deposit.provider IS DISTINCT FROM d.provider
   OR deposit."providerRef" IS DISTINCT FROM d."providerPaymentId"
   OR attempt.id IS NULL
   OR attempt."ledgerTransactionId" IS DISTINCT FROM d."depositTransactionId"
   OR attempt."walletId" IS DISTINCT FROM d."walletId"
   OR attempt.currency IS DISTINCT FROM d.currency
   OR attempt.provider IS DISTINCT FROM d.provider
   OR attempt."providerPaymentId" IS DISTINCT FROM d."providerPaymentId"
   OR (
     attempt.status NOT IN ('PARTIALLY_REFUNDED', 'REFUNDED')
     AND attempt.status IS DISTINCT FROM (
       CASE
         WHEN EXISTS (
           SELECT 1
             FROM "PaymentDispute" lost
            WHERE lost."depositAttemptId" = attempt.id
              AND lost.status = 'LOST'
         ) THEN 'CHARGEBACK'::"DepositAttemptStatus"
         WHEN EXISTS (
           SELECT 1
             FROM "PaymentDispute" opened_case
            WHERE opened_case."depositAttemptId" = attempt.id
              AND opened_case.status = 'OPEN'
         ) THEN 'DISPUTED'::"DepositAttemptStatus"
         ELSE 'SUCCEEDED'::"DepositAttemptStatus"
       END
     )
   )
   OR (
     d."openedByEventId" IS NOT NULL
     AND (
       opened.id IS NULL
       OR opened."eventType" <> 'charge.dispute.created'
       OR opened.provider IS DISTINCT FROM d.provider
       OR opened."objectId" IS DISTINCT FROM d."providerDisputeId"
       OR opened."providerPaymentId" IS DISTINCT FROM d."providerPaymentId"
       OR opened."providerChargeId" IS DISTINCT FROM d."providerChargeId"
       OR opened."depositAttemptId" IS DISTINCT FROM d."depositAttemptId"
       OR opened."paymentDisputeId" IS DISTINCT FROM d.id
       OR opened."disputeCurrency" IS DISTINCT FROM d.currency
       OR opened."disputeAmountMinor" IS DISTINCT FROM
          (d.amount * 100)::BIGINT
       OR (
         d.status = 'OPEN'
         AND opened."providerStatus" IS DISTINCT FROM d."providerStatus"
       )
       OR opened.status <> 'PROCESSED'
     )
   )
   OR (
     d."resolvedByEventId" IS NOT NULL
     AND (
       resolved.id IS NULL
       OR resolved."eventType" <> 'charge.dispute.closed'
       OR resolved.provider IS DISTINCT FROM d.provider
       OR resolved."objectId" IS DISTINCT FROM d."providerDisputeId"
       OR resolved."providerPaymentId" IS DISTINCT FROM d."providerPaymentId"
       OR resolved."providerChargeId" IS DISTINCT FROM d."providerChargeId"
       OR resolved."depositAttemptId" IS DISTINCT FROM d."depositAttemptId"
       OR resolved."paymentDisputeId" IS DISTINCT FROM d.id
       OR resolved."disputeCurrency" IS DISTINCT FROM d.currency
       OR resolved."disputeAmountMinor" IS DISTINCT FROM
          (d.amount * 100)::BIGINT
       OR resolved."providerStatus" IS DISTINCT FROM d."providerStatus"
       OR resolved.status <> 'PROCESSED'
     )
   )
   OR (
     d."holdTransactionId" IS NOT NULL
     AND (
       hold.id IS NULL
       OR hold.type <> 'RESERVATION'
       OR hold."walletId" IS DISTINCT FROM d."walletId"
       OR hold.currency IS DISTINCT FROM d.currency
       OR hold.amount <> -d."heldAmount"
       OR hold.provider IS NOT NULL
       OR hold."providerRef" IS NOT NULL
     )
   )
   OR (
     d."resolutionTransactionId" IS NOT NULL
     AND (
       resolution.id IS NULL
       OR resolution."walletId" IS DISTINCT FROM d."walletId"
       OR resolution.currency IS DISTINCT FROM d.currency
       OR resolution.provider IS NOT NULL
       OR resolution."providerRef" IS NOT NULL
       OR (
         d.status = 'WON'
         AND (
           resolution.type <> 'RESERVATION'
           OR resolution.amount <> d."heldAmount"
         )
       )
       OR (
         d.status = 'LOST'
         AND (
           resolution.type <> 'CHARGEBACK'
           OR resolution.amount <> -d."heldAmount"
         )
       )
     )
   )
   OR (
     d.status = 'OPEN'
     AND (
       d."openedByEventId" IS NULL
       OR d."openedAt" IS NULL
       OR d."resolvedByEventId" IS NOT NULL
       OR d."resolvedAt" IS NOT NULL
       OR d."resolutionTransactionId" IS NOT NULL
       OR (d."heldAmount" > 0 AND d."holdTransactionId" IS NULL)
       OR (d."heldAmount" = 0 AND d."holdTransactionId" IS NOT NULL)
     )
   )
   OR (
     d.status = 'WON'
     AND (
       d."resolvedByEventId" IS NULL
       OR d."resolvedAt" IS NULL
       OR (d."heldAmount" > 0 AND d."holdTransactionId" IS NULL)
       OR (d."heldAmount" > 0 AND d."resolutionTransactionId" IS NULL)
       OR (d."heldAmount" = 0 AND d."holdTransactionId" IS NOT NULL)
       OR (d."heldAmount" = 0 AND d."resolutionTransactionId" IS NOT NULL)
     )
   )
   OR (
     d.status = 'LOST'
     AND (
       d."resolvedByEventId" IS NULL
       OR d."resolvedAt" IS NULL
       OR (d."heldAmount" > 0 AND d."resolutionTransactionId" IS NULL)
       OR (d."heldAmount" = 0 AND d."holdTransactionId" IS NOT NULL)
       OR (d."heldAmount" = 0 AND d."resolutionTransactionId" IS NOT NULL)
     )
   )
ORDER BY d."updatedAt";
```

The query distinguishes an immutable booking shortfall from current exposure.
A close-before-open `LOST` case may have a direct `CHARGEBACK` resolution and
no historical hold row; its resolution must still exactly match the amount
recovered from the wallet. A later opening event may attach missing opening
evidence once but cannot change the terminal outcome or amounts.

## Wallet credits blocked by uncovered dispute exposure

```sql
SELECT
  w.id AS "walletId",
  w."organizationId",
  w."userId",
  w.currency,
  w."availableBalance",
  SUM(d."currentExposureAmount") AS "uncoveredExposure",
  COUNT(*) AS "exposedCaseCount",
  MIN(d."createdAt") AS "oldestExposedCaseAt"
FROM "Wallet" w
JOIN "PaymentDispute" d
  ON d."walletId" = w.id
WHERE d.status IN ('OPEN', 'LOST')
  AND d."currentExposureAmount" > 0
GROUP BY
  w.id,
  w."organizationId",
  w."userId",
  w.currency,
  w."availableBalance"
ORDER BY
  SUM(d."currentExposureAmount") DESC,
  MIN(d."createdAt");
```

These rows are actionable exposure, not automatically accounting drift.
`BillingService.reserve` must return
`409 WALLET_SPEND_BLOCKED_BY_DISPUTE` for every listed wallet even when a later
deposit or refund made `availableBalance` positive. A `WON` or zero-exposure
case is intentionally absent. For `LOST` rows, keep spending fail-closed until
a reviewed recovery/netting workflow exists; do not directly edit
`currentExposureAmount`, a wallet balance, or ledger history.

## Orphan or legacy dispute ledger rows

```sql
SELECT
  t.id,
  t."walletId",
  t.type,
  t.amount,
  t.currency,
  t.reference,
  t."createdAt"
FROM "Transaction" t
LEFT JOIN "PaymentDispute" hold_case
  ON hold_case."holdTransactionId" = t.id
LEFT JOIN "PaymentDispute" resolution_case
  ON resolution_case."resolutionTransactionId" = t.id
WHERE (
    t.reference LIKE 'payment-dispute:%'
    AND hold_case.id IS NULL
    AND resolution_case.id IS NULL
  )
  OR t.reference LIKE 'chargeback-hold-%'
  OR t.reference LIKE 'chargeback-release-%'
  OR t.reference LIKE 'chargeback-lost-%'
ORDER BY t."createdAt";
```

New orphan rows cannot commit because linkage is checked by a deferred
constraint, and new legacy-prefix rows are rejected. Existing legacy rows are
preserved for investigation. There is no generic repair command for them:
establish Stripe truth, keep the affected path closed, and implement a reviewed
incident-specific typed compensation before any mutation. Never delete or
rewrite these rows.

## Customer wallet debits that claimed withdrawal

```sql
SELECT
  t.id,
  t."walletId",
  t.amount,
  t.currency,
  t.reference,
  t.description,
  t."createdAt"
FROM "Transaction" t
WHERE t.type = 'WITHDRAWAL'
  AND t."walletId" IS NOT NULL
ORDER BY t."createdAt";
```

The current product has no valid customer cash-out aggregate, so every row
requires investigation. Confirm customer communications and provider/support
records before any compensation.

## Active withdrawal reservation mismatch

```sql
SELECT
  w.id,
  w."publicReference",
  w."publisherId",
  w.status,
  w.amount,
  w.currency,
  COALESCE(SUM(a.amount) FILTER (WHERE a."releasedAt" IS NULL), 0)
    AS active_allocation
FROM "Withdrawal" w
LEFT JOIN "WithdrawalAllocation" a
  ON a."withdrawalId" = w.id
WHERE w.status IN ('PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED')
GROUP BY
  w.id,
  w."publicReference",
  w."publisherId",
  w.status,
  w.amount,
  w.currency
HAVING COALESCE(SUM(a.amount) FILTER (WHERE a."releasedAt" IS NULL), 0)
       <> w.amount
ORDER BY w."createdAt";
```

Approval must never compensate for a mismatch by looking for the amount in
withdrawable balance.

Migration `20260802097000_legacy_withdrawal_reservation_evidence` repairs only
a missing legacy `PENDING` reservation proven by one exact pre-cutover debit,
one matching requester audit, and the absence of decision, reversal,
execution, and allocation evidence. It also reconstructs an already-released
legacy `REJECTED` reservation only when that exact pre-cutover request evidence
is paired with one exact post-cutover rejection reversal and matching
request/rejection actor audits, with no approval or payout execution. A
pending repair increases carry-forward and carry-forward-used equally; a
rejected repair increases only carry-forward because the exact reversal
already restored the liability. Neither path changes withdrawable balance or
lifetime paid.

Any row outside that exact evidence class is unexplained and blocks the
release. Preserve its ledger and audits, establish provider and bank truth when
applicable, and use a separately reviewed typed repair. Never improvise an
allocation, relabel a transaction, or update a balance directly to clear this
query.

## Payout send-claim authority and maker-checker integrity

`PayoutExecutionClaim` is the only database send authority. This query must
return zero unexplained rows for post-migration executions:

```sql
WITH claim_counts AS (
  SELECT
    claim."executionId",
    COUNT(*) FILTER (WHERE claim.kind = 'PROVIDER_SEND')
      AS provider_claim_count,
    COUNT(*) FILTER (WHERE claim.kind = 'BANK_PAYOUT_SEND')
      AS bank_claim_count
  FROM "PayoutExecutionClaim" claim
  GROUP BY claim."executionId"
)
SELECT
  execution.id AS execution_id,
  execution."withdrawalId",
  execution.status,
  execution.stage,
  execution."completionSource",
  execution."idempotencyKey" AS execution_key,
  withdrawal."approvedBy",
  execution."initiatedByUserId",
  provider_claim.id AS provider_claim_id,
  provider_claim."idempotencyKey" AS provider_claim_key,
  provider_claim."claimedByUserId" AS provider_claim_actor,
  bank_claim.id AS bank_claim_id,
  bank_claim."idempotencyKey" AS bank_claim_key,
  COALESCE(claim_counts.provider_claim_count, 0) AS provider_claim_count,
  COALESCE(claim_counts.bank_claim_count, 0) AS bank_claim_count,
  execution."providerMetadata" ? 'externalClaims'
    AS has_json_external_claims
FROM "PayoutExecution" execution
JOIN "Withdrawal" withdrawal
  ON withdrawal.id = execution."withdrawalId"
LEFT JOIN claim_counts
  ON claim_counts."executionId" = execution.id
LEFT JOIN "PayoutExecutionClaim" provider_claim
  ON provider_claim."executionId" = execution.id
 AND provider_claim.kind = 'PROVIDER_SEND'
LEFT JOIN "PayoutExecutionClaim" bank_claim
  ON bank_claim."executionId" = execution.id
 AND bank_claim.kind = 'BANK_PAYOUT_SEND'
WHERE
  (
    jsonb_typeof(execution."providerMetadata") = 'object'
    AND execution."providerMetadata" ? 'externalClaims'
  )
  OR execution."initiatedByUserId" IS NOT NULL
     AND execution."initiatedByUserId" = withdrawal."approvedBy"
  OR provider_claim."claimedByUserId" IS NOT NULL
     AND provider_claim."claimedByUserId" = withdrawal."approvedBy"
  OR (
    provider_claim.id IS NOT NULL
    AND (
      provider_claim."idempotencyKey"
        IS DISTINCT FROM execution."idempotencyKey"
      OR provider_claim."idempotencyKeyFingerprint"
        !~ '^[0-9a-f]{64}$'
      OR provider_claim."claimedAt" > provider_claim."lastClaimedAt"
    )
  )
  OR (
    bank_claim.id IS NOT NULL
    AND (
      bank_claim."idempotencyKey" IS DISTINCT FROM (
        'payout-bank-' || execution."withdrawalId" || '-v' ||
        substring(execution."idempotencyKey" FROM '-v([0-9]+)$')
      )
      OR bank_claim."idempotencyKeyFingerprint"
        !~ '^[0-9a-f]{64}$'
      OR bank_claim."claimedAt" > bank_claim."lastClaimedAt"
    )
  )
  OR (
    execution.stage = 'PROVIDER_SEND_CLAIMED'
    AND COALESCE(claim_counts.provider_claim_count, 0) <> 1
  )
  OR (
    execution.stage IN (
      'BANK_PAYOUT_SEND_CLAIMED',
      'BANK_PAYOUT_RESUME_CLAIMED'
    )
    AND COALESCE(claim_counts.bank_claim_count, 0) <> 1
  )
  OR (
    execution.stage = 'PRE_PROVIDER_ABORTED'
    AND (
      COALESCE(claim_counts.provider_claim_count, 0) <> 0
      OR COALESCE(claim_counts.bank_claim_count, 0) <> 0
    )
  )
ORDER BY execution."createdAt";
```

The database prevents duplicate claim families and identity mutation, but this
scan also detects disabled guards, mixed writers, and restored data that does
not match the current contract. SQL cannot recompute the SHA-256 fingerprints
without an approved hashing extension; the service must additionally compare
each stored fingerprint with the SHA-256 of its exact stored key before any
recovery. Never repair a claim row or create one retroactively to authorize a
send.

## Untrusted payout responses that were not attached

Every row returned here is an active Finance/Security incident. The audit
metadata deliberately contains no values copied from the rejected provider
response:

```sql
SELECT
  audit.id AS audit_id,
  audit."createdAt" AS quarantined_at,
  audit."userId" AS actor_user_id,
  audit."organizationId",
  audit."entityId" AS execution_id,
  audit.metadata ->> 'withdrawalId' AS withdrawal_id,
  audit.metadata ->> 'providerName' AS provider_name,
  audit.metadata ->> 'responseKind' AS response_kind,
  audit.metadata ->> 'disposition' AS disposition,
  audit.metadata -> 'expectedStages' AS expected_stages,
  audit.metadata ->> 'expectedVersion' AS expected_version,
  audit.metadata ->> 'observedStatus' AS observed_status,
  audit.metadata ->> 'observedStage' AS observed_stage,
  audit.metadata ->> 'observedVersion' AS observed_version,
  audit.metadata ->> 'stateMutationApplied' AS state_mutation_applied,
  execution.status AS current_execution_status,
  execution.stage AS current_execution_stage,
  execution."providerExecutionId",
  execution."providerTransferId",
  execution."providerPayoutId",
  execution."errorMessage"
FROM "AuditLog" audit
LEFT JOIN "PayoutExecution" execution
  ON execution.id = audit."entityId"
WHERE audit.action = 'PAYOUT_PROVIDER_RESPONSE_QUARANTINED'
ORDER BY audit."createdAt" DESC;
```

`disposition` must be `UNTRUSTED_NOT_ATTACHED`. Keep the withdrawal
reservation intact and do not copy any ID, reference, fee, status, or metadata
from logs or the rejected response into canonical rows. Retrieve Stripe truth
using the immutable connected-account scope and original idempotency identity,
compare it with the withdrawal command, and record Finance/Security
adjudication. A claimed stage may be replayed only through the exact-key,
leased recovery command; after its bounded replay window it becomes
review-only. No finding authorizes completion, cancellation, balance
restoration, `lifetimePaid` mutation, or a replacement payout by itself.

## Completed withdrawals requiring evidence review

```sql
SELECT
  w.id,
  w."publicReference",
  w."publisherId",
  w.method,
  w.amount,
  w.status,
  w."requestedBy",
  w."approvedBy",
  e.id AS execution_id,
  p.name AS execution_provider,
  e.stage,
  e."providerExecutionId",
  e."providerTransferId",
  e."providerPayoutId",
  e."destinationAmount",
  e."destinationCurrency",
  e."bankTraceReference",
  e."completionSource",
  e."completionEvidenceRef",
  e."completionEvidenceAt",
  e."completedAt",
  e."initiatedByUserId",
  e."completionActorUserId",
  e."completionWebhookEventId",
  completion_event."providerExecutionId" AS webhook_provider_payout_id,
  completion_event."providerAccountExternalId" AS webhook_provider_account,
  completion_event."payoutAmountMinor" AS webhook_amount_minor,
  completion_event."payoutCurrency" AS webhook_currency,
  completion_event."providerStatus" AS webhook_provider_status
FROM "Withdrawal" w
LEFT JOIN "PayoutExecution" e
  ON e."withdrawalId" = w.id
 AND e.status = 'COMPLETED'
LEFT JOIN "PayoutProvider" p
  ON p.id = e."providerId"
LEFT JOIN "PayoutWebhookEvent" completion_event
  ON completion_event.id = e."completionWebhookEventId"
WHERE w.status = 'COMPLETED'
  AND (
    e.id IS NULL
    OR e."completionSource" IS NULL
    OR e."completedAt" IS NULL
    OR e."completionSource" = 'LEGACY_UNVERIFIED'
    OR (
      e."completionSource" <> 'LEGACY_UNVERIFIED'
      AND (
        e."completionEvidenceRef" IS NULL
        OR e."completionEvidenceAt" IS NULL
        OR e."completionEvidenceAt" > e."completedAt"
      )
    )
    OR (
      w.method IN ('wise', 'stripe_connect')
      AND (
        p.name = 'manual'
        OR e."completionSource" = 'MANUAL_BANK_CONFIRMATION'
      )
    )
    OR (
      p.name = 'stripe_connect'
      AND (
        e."providerPayoutId" IS NULL
        OR e."completionEvidenceRef" IS DISTINCT FROM e."providerPayoutId"
        OR e.stage <> 'BANK_PAID'
        OR (
          e."completionSource" = 'PROVIDER_WEBHOOK'
          AND (
            completion_event.id IS NULL
            OR completion_event."eventType" <> 'payout.paid'
            OR completion_event."providerStatus" <> 'COMPLETED'
            OR completion_event."providerExecutionId"
                 IS DISTINCT FROM e."providerPayoutId"
            OR completion_event."providerAccountExternalId"
                 IS DISTINCT FROM
                   e."providerMetadata"
                     #>> '{destinationSnapshot,providerAccountExternalId}'
          )
        )
      )
    )
    OR (
      p.name = 'wise'
      AND (
        e."providerExecutionId" IS NULL
        OR e."completionEvidenceRef" IS DISTINCT FROM e."providerExecutionId"
      )
    )
    OR (
      e."completionSource" = 'MANUAL_BANK_CONFIRMATION'
      AND (
        p.name <> 'manual'
        OR w.method <> 'bank_transfer'
        OR w."requestedBy" IS NULL
        OR w."approvedBy" IS NULL
        OR e."initiatedByUserId" IS NULL
        OR e."completionActorUserId" IS NULL
        OR e."initiatedByUserId" = w."approvedBy"
        OR e."completionActorUserId" = w."requestedBy"
        OR e."completionActorUserId" = w."approvedBy"
        OR e."completionActorUserId" = e."initiatedByUserId"
        OR e."bankTraceReference" IS DISTINCT FROM e."completionEvidenceRef"
      )
    )
    OR (
      e."completionSource" IN (
        'PROVIDER_RESPONSE',
        'PROVIDER_STATUS_POLL',
        'PROVIDER_WEBHOOK'
      )
      AND (
        COALESCE(
          completion_event."payoutCurrency",
          e."providerMetadata" #>> '{completion,providerCurrency}'
        ) IS DISTINCT FROM e."destinationCurrency"
        OR
        COALESCE(
          completion_event."payoutAmountMinor"::NUMERIC,
          CASE
            WHEN (
              e."providerMetadata"
                #>> '{completion,providerAmountMinor}'
            ) ~ '^[1-9][0-9]*$'
            THEN (
              e."providerMetadata"
                #>> '{completion,providerAmountMinor}'
            )::NUMERIC
            ELSE NULL
          END
        ) IS DISTINCT FROM
          (COALESCE(e."destinationAmount", e.amount) * 100)::NUMERIC
      )
    )
  )
ORDER BY e."completedAt" NULLS FIRST, w."updatedAt";
```

Compare every result with the provider using the persisted original
idempotency/reference. `LEGACY_UNVERIFIED` is an honest migration
classification, not proof of loss or fraud; it requires provider/bank evidence
before any compensation. The `* 100` comparison is intentionally USD-only;
run a reviewed currency-exponent query before certifying another currency.
For Stripe, the provider object must be the persisted bank Payout, its amount
and currency must exactly equal the immutable execution destination, and a
webhook must also match the destination's connected account. Do not resend.

## Competing money-moving payout executions

```sql
SELECT
  "withdrawalId",
  COUNT(*) AS active_or_completed_executions,
  ARRAY_AGG(id ORDER BY "createdAt") AS execution_ids,
  ARRAY_AGG(status ORDER BY "createdAt") AS execution_statuses
FROM "PayoutExecution"
WHERE status IN ('PENDING', 'PROCESSING', 'COMPLETED')
GROUP BY "withdrawalId"
HAVING COUNT(*) > 1;
```

The payout migration refuses to install while this query returns rows, and its
partial unique index prevents new rows across the combined state set. Resolve
historical rows from external evidence; never select a winner by timestamp
alone.

## Missing requester provenance and quarantined payout evidence

```sql
SELECT
  w.id,
  w."publicReference",
  w."publisherId",
  w.status,
  w."requestedBy",
  w."createdAt"
FROM "Withdrawal" w
WHERE w."requestedBy" IS NULL
  AND w.status IN ('PENDING', 'APPROVED', 'PROCESSING')
ORDER BY w."createdAt";

SELECT
  e.id,
  e.provider,
  e."eventType",
  e."providerExecutionId",
  e."providerAccountExternalId",
  e."payoutAmountMinor",
  e."payoutCurrency",
  e."providerStatus",
  e."lastError",
  e.attempts,
  e."receivedAt",
  e."processedAt"
FROM "PayoutWebhookEvent" e
WHERE e.status = 'QUARANTINED'
ORDER BY e."receivedAt";
```

Missing requester provenance blocks approval/execution; recover it only from
immutable request evidence. Every quarantined terminal event is a critical
provider/local-state contradiction—including a late failure after local
completion or an amount/currency/account mismatch—until Finance/Security
records the external truth and reviewed remediation. Quarantine never
authorizes reopening, balance restoration, `lifetimePaid` decrement, or a new
send. For a `PROCESSING` row, `attempts` and `lockedAt` together are its only
worker authority. A recovered worker must increment the attempt and assign a
new timestamp; never copy either value or let a stale process mark the event
terminal. Canonical completion evidence records both fields so the database
can reject a stale claimant before any payout liability changes.

Inspect live generic payout claims without changing their token:

```sql
SELECT
  e.id,
  e.provider,
  e."eventType",
  e."providerExecutionId",
  e.status,
  e.attempts,
  e."lockedAt",
  CURRENT_TIMESTAMP - e."lockedAt" AS lease_age,
  e."receivedAt",
  e."lastError"
FROM "PayoutWebhookEvent" e
WHERE e.status = 'PROCESSING'
  AND NOT (
    e.provider = 'stripe_connect'
    AND e."eventType" = 'account.updated'
  )
ORDER BY e."lockedAt";
```

Stripe account-routing events must also be visible until their gated sync
finishes:

```sql
SELECT
  e.id,
  e."providerAccountExternalId",
  e.status,
  e.attempts,
  e."availableAt",
  e."lockedAt",
  e."receivedAt",
  e."processedAt",
  e."lastError"
FROM "PayoutWebhookEvent" e
WHERE e.provider = 'stripe_connect'
  AND e."eventType" = 'account.updated'
  AND e.status <> 'PROCESSED'
ORDER BY e."receivedAt";
```

These events are deliberately not consumed by the generic payout-completion
worker. `locked` mode retains the signed normalized evidence and returns
non-2xx so Stripe redelivers it. Recovery requires the exact signed event to be
redelivered while recovery processing is allowed; never mark the row processed
or reactivate a payout method with SQL.

## Payout-method liability counter and inactive-route drift

The trigger-maintained counter must exactly match the authoritative
nonterminal withdrawals:

```sql
WITH authoritative AS (
  SELECT
    method.id AS payout_method_id,
    method."publisherId",
    method."nonterminalWithdrawalCount" AS stored_count,
    COUNT(withdrawal.id) FILTER (
      WHERE withdrawal.status IN (
        'PENDING',
        'APPROVED',
        'PROCESSING',
        'FAILED'
      )
    )::INTEGER AS authoritative_count
  FROM "PayoutMethod" method
  LEFT JOIN "Withdrawal" withdrawal
    ON withdrawal."payoutMethodId" = method.id
  GROUP BY
    method.id,
    method."publisherId",
    method."nonterminalWithdrawalCount"
)
SELECT
  payout_method_id,
  "publisherId",
  stored_count,
  authoritative_count,
  stored_count - authoritative_count AS difference
FROM authoritative
WHERE stored_count <> authoritative_count
ORDER BY "publisherId", payout_method_id;
```

This query must also return zero rows:

```sql
SELECT
  method.id AS payout_method_id,
  method."publisherId",
  method.type AS payout_method_type,
  method."nonterminalWithdrawalCount",
  withdrawal.id AS withdrawal_id,
  withdrawal.status AS withdrawal_status,
  MIN(withdrawal."createdAt") AS requested_at,
  COUNT(DISTINCT execution.id) AS execution_count,
  COUNT(DISTINCT claim.id) AS execution_claim_count,
  BOOL_OR(
    execution."providerExecutionId" IS NOT NULL
    OR execution."providerTransferId" IS NOT NULL
    OR execution."providerPayoutId" IS NOT NULL
  ) AS has_provider_reference
FROM "PayoutMethod" method
JOIN "Withdrawal" withdrawal
  ON withdrawal."payoutMethodId" = method.id
LEFT JOIN "PayoutExecution" execution
  ON execution."withdrawalId" = withdrawal.id
LEFT JOIN "PayoutExecutionClaim" claim
  ON claim."executionId" = execution.id
WHERE method."isActive" = FALSE
  AND withdrawal.status IN (
    'PENDING',
    'APPROVED',
    'PROCESSING',
    'FAILED'
  )
GROUP BY
  method.id,
  method."publisherId",
  method.type,
  method."nonterminalWithdrawalCount",
  withdrawal.id,
  withdrawal.status
ORDER BY method."publisherId", method.id, requested_at;
```

Any result is a release/reopening blocker. A claim-free `PENDING` withdrawal
may use the normal rejection command; a claim-free `APPROVED` withdrawal may
use the typed safe-abandon command after its full predicate passes.
`PROCESSING`, `FAILED`, any execution claim, or any provider reference
requires provider/bank reconciliation. The migration must not guess or
silently repair counter/route drift.

## Legacy cancellations, stranded pre-provider work, and allocation drift

```sql
-- Stale provider-cancellation commands. These remain reserved and may only
-- use the exact Resume cancellation workflow after provider evidence review.
SELECT
  e.id AS execution_id,
  w.id AS withdrawal_id,
  w."publicReference" AS withdrawal_reference,
  w.status AS withdrawal_status,
  e.status AS execution_status,
  e.stage,
  e."updatedAt",
  NOW() - e."updatedAt" AS cancellation_age,
  e."providerMetadata"
    #>> '{destinationSnapshot,providerAccountExternalId}'
    AS connected_account_id,
  e."providerExecutionId",
  e."providerTransferId",
  e."providerPayoutId",
  e."errorMessage",
  w."requestedBy" AS requester_user_id,
  w."approvedBy" AS approver_user_id,
  e."initiatedByUserId" AS execution_actor_user_id,
  e."cancellationActorUserId" AS cancellation_actor_user_id,
  incident.action AS latest_cancellation_audit_action,
  incident."userId" AS latest_audit_actor_user_id,
  incident."createdAt" AS latest_cancellation_audit_at,
  incident.metadata AS latest_cancellation_audit_metadata
FROM "PayoutExecution" e
JOIN "Withdrawal" w ON w.id = e."withdrawalId"
LEFT JOIN LATERAL (
  SELECT a.action, a."userId", a."createdAt", a.metadata
  FROM "AuditLog" a
  WHERE a."entityType" = 'PayoutExecution'
    AND a."entityId" = e.id
    AND a.action IN (
      'PAYOUT_EXECUTION_CANCEL_REQUESTED',
      'PAYOUT_CANCELLATION_EVIDENCE_QUARANTINED',
      'PAYOUT_EXECUTION_CANCELLED'
    )
  ORDER BY a."createdAt" DESC
  LIMIT 1
) incident ON TRUE
WHERE e.status IN ('PENDING', 'PROCESSING')
  AND e.stage = 'CANCEL_REQUESTED'
  AND e."updatedAt" < NOW() - INTERVAL '15 minutes'
ORDER BY e."updatedAt";

SELECT
  e.id,
  e."withdrawalId",
  p.name AS provider,
  e.status,
  e.stage,
  e."cancellationSource",
  e."cancelledAt",
  e."createdAt"
FROM "PayoutExecution" e
JOIN "PayoutProvider" p ON p.id = e."providerId"
WHERE e."cancellationSource" = 'LEGACY_UNVERIFIED'
ORDER BY e."cancelledAt" NULLS FIRST;

SELECT
  e.id,
  e."withdrawalId",
  e.stage,
  (
    SELECT COUNT(*)
    FROM "PayoutExecutionClaim" claim
    WHERE claim."executionId" = e.id
  ) AS claim_count,
  e."updatedAt"
FROM "PayoutExecution" e
WHERE e.status = 'PROCESSING'
  AND e.stage IN ('CREATED', 'DESTINATION_VALIDATED')
  AND e."providerExecutionId" IS NULL
  AND e."providerTransferId" IS NULL
  AND e."providerPayoutId" IS NULL
ORDER BY e."updatedAt";

SELECT
  w.id,
  w.status,
  COUNT(*) FILTER (WHERE a."releasedAt" IS NULL) AS active_allocations,
  COUNT(*) AS allocation_count
FROM "Withdrawal" w
LEFT JOIN "WithdrawalAllocation" a ON a."withdrawalId" = w.id
WHERE w.status = 'REJECTED'
GROUP BY w.id, w.status
HAVING COUNT(*) = 0
   OR COUNT(*) FILTER (WHERE a."releasedAt" IS NULL) <> 0;
```

Every row from the first query is a held-liability incident. Compare the
connected account, Transfer, Payout, reversal evidence, actor chain, and audit
record against authenticated Stripe truth. The only supported automated action
is **Resume cancellation**. Never use generic Retry, resend a payout, release
allocations, or restore the publisher balance from this query alone.

`LEGACY_UNVERIFIED` cancellation never authorizes a replacement payout.
For a stranded `CREATED`/`DESTINATION_VALIDATED` row, Finance may use the
locked pre-provider Cancel action only after confirming that no durable
`PayoutExecutionClaim` exists (`claim_count = 0`). That
`PRE_PROVIDER_ABORT` records proof that no provider call began; it is not
evidence that a provider object was cancelled. JSON metadata is informational
and cannot establish the no-send boundary. Once a claim or provider ID exists,
require the route's typed provider cancellation/reversal evidence instead. A
rejected withdrawal with active/missing allocations is a critical reservation
contradiction.

The only automatic exception for a missing rejected allocation is the exact
pre-cutover debit plus post-cutover rejection-reversal evidence class handled
by migration `20260802097000`; every other result remains a release blocker.
Do not create or release allocations with ad hoc SQL.

## Completion and lifetime-paid comparison

```sql
WITH completed AS (
  SELECT
    "publisherId",
    SUM(amount) AS completed_amount
  FROM "Withdrawal"
  WHERE status = 'COMPLETED'
  GROUP BY "publisherId"
)
SELECT
  b."publisherId",
  b."lifetimePaid",
  COALESCE(c.completed_amount, 0) AS completed_amount,
  b."lifetimePaid" - COALESCE(c.completed_amount, 0) AS difference
FROM "PublisherBalance" b
LEFT JOIN completed c
  ON c."publisherId" = b."publisherId"
WHERE b."lifetimePaid" <> COALESCE(c.completed_amount, 0);
```

Agreement here is necessary but not sufficient: completed withdrawals must
also pass route-specific provider/manual evidence checks.

## Post-repair evidence

Only after an incident-specific compensating command has been implemented,
reviewed, and tested:

1. rerun the relevant query and the full reconciliation endpoint;
2. compare provider transactions/balances for the incident window;
3. verify exactly one compensation ledger row and audit event;
4. verify the command is idempotent by safely replaying its incident key;
5. attach before/after results to the incident record.
