-- FIN-02 — provider-aware uniqueness on Transaction
--
-- Audit finding FIN-02: Transaction idempotency relied solely on
-- `reference` uniqueness (Stripe session.id). A replayed webhook returning
-- with a different session.id but the same payment_intent could write a
-- second DEPOSIT row crediting the wallet a second time — `reference` was
-- different (new session.id) so the existing `@@unique([reference])` did not
-- catch it. The code-level `findFirst({ where: { providerRef, type } })` was
-- only an advisory fast path, not a hard guarantee.
--
-- This migration closes that race at the DB level. The composite key is
-- `[provider, providerRef]` — NOT `[providerRef, type]` — because different
-- providers (Stripe, Wise, PayPal, manual) may legitimately reuse the same
-- external identifier format; only the provider + ref pair is globally
-- unique. Scoped via `WHERE "providerRef" IS NOT NULL` so internal ledger
-- rows (PURCHASE / REFUND / WITHDRAWAL / SETTLEMENT_CLAWBACK / etc.) that
-- intentionally carry `providerRef = null` stay exempt — same partial-unique
-- pattern used by `MarketplaceFavorite_userId_listingId_serviceType_key`
-- and `MarketplaceListing_websiteId_active_key`.
--
-- Multi-statement file → Prisma migrate runner wraps all statements in a
-- single transaction. `CREATE UNIQUE INDEX CONCURRENTLY` cannot run inside
-- a tx, so we use the non-concurrent form (matches the convention used by
-- `20260713120000_listing_per_website_unique`). On a populated prod DB the
-- index build is short — the partial predicate filters out the vast
-- majority of rows (anything without a providerRef), leaving the working
-- set to the DEPOSIT rows + their chargeback-hold siblings.

-- 1. Add the `provider` column. Retrofits onto existing rows as NULL — the
--    partial-unique predicate (`WHERE providerRef IS NOT NULL`) doesn't see
--    NULL-provider rows unless they also have a non-NULL providerRef, which
--    we backfill next.
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "provider" TEXT;

-- 2. Backfill historical DEPOSIT / RESERVATION rows that carry a
--    providerRef (Stripe payment_intent). All such rows originate from
--    `processSuccessfulPayment` and `handleChargeback` in billing.service.ts,
--    which only ever talk to Stripe — so 'stripe' is the correct label.
--    Rows with `providerRef = null` (PURCHASE, REFUND, WITHDRAWAL,
--    SETTLEMENT_CLAWBACK, DEBT_REPAYMENT, RELEASE) keep `provider = null`
--    and stay outside the partial-unique predicate.
UPDATE "Transaction"
  SET "provider" = 'stripe'
  WHERE "providerRef" IS NOT NULL AND "provider" IS NULL;

-- 3. Partial unique index — the hard guarantee. Two webhooks replaying the
--    same payment_intent under different session.ids both attempt to insert
--    ('stripe', 'pi_xxx'); PostgreSQL's B-tree unique check fails the
--    second insert with P2002, which `processSuccessfulPayment` swallows as
--    a duplicate (webhook returns 200 to Stripe so the event isn't retried).
CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_provider_providerRef_key"
  ON "Transaction" ("provider", "providerRef")
  WHERE "providerRef" IS NOT NULL;