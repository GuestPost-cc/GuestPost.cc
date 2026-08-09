-- GuestPost.cc launches with one accounting currency. Currency is part of a
-- money amount's identity; matching numeric values are never exchangeable.
-- This migration deliberately fails when historical non-USD facts exist. Such
-- rows require an evidence-backed reconciliation, never an UPDATE-to-USD.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE
  "DepositAttempt",
  "ListingService",
  "MarketplaceListing",
  "Order",
  "OrderItem",
  "PaymentDispute",
  "PayoutBatch",
  "PayoutExecution",
  "PlatformRevenue",
  "PublisherBalance",
  "PublisherProviderAccount",
  "Settlement",
  "Transaction",
  "Wallet",
  "Withdrawal",
  "WithdrawalAllocation"
IN SHARE MODE;

DO $$
DECLARE
  violation RECORD;
BEGIN
  SELECT money_fact.* INTO violation
  FROM (
    SELECT 'Order' AS relation_name, "id", "currency" FROM "Order"
    UNION ALL SELECT 'Wallet', "id", "currency" FROM "Wallet"
    UNION ALL SELECT 'Transaction', "id", "currency" FROM "Transaction"
    UNION ALL SELECT 'DepositAttempt', "id", "currency" FROM "DepositAttempt"
    UNION ALL SELECT 'PaymentDispute', "id", "currency" FROM "PaymentDispute"
    UNION ALL SELECT 'Withdrawal', "id", "currency" FROM "Withdrawal"
    UNION ALL SELECT 'WithdrawalAllocation', "id", "currency" FROM "WithdrawalAllocation"
    UNION ALL SELECT 'PayoutExecution.sourceCurrency', "id", "sourceCurrency" FROM "PayoutExecution"
    UNION ALL SELECT 'PayoutExecution.destinationCurrency', "id", "destinationCurrency" FROM "PayoutExecution"
    UNION ALL SELECT 'MarketplaceListing', "id", "currency" FROM "MarketplaceListing"
    UNION ALL SELECT 'ListingService', "id", "currency" FROM "ListingService"
  ) AS money_fact
  WHERE money_fact."currency" IS DISTINCT FROM 'USD'
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'USD boundary migration blocked: %s row %s has currency %s',
        violation.relation_name,
        violation."id",
        COALESCE(violation."currency", '<null>')
      );
  END IF;
END
$$;

-- USD catalog/order amounts must be representable in provider minor units.
-- Fail the cutover instead of rounding historical commercial facts.
DO $$
DECLARE
  violation RECORD;
BEGIN
  SELECT amount_fact.* INTO violation
  FROM (
    SELECT 'ListingService' AS relation_name, "id", "price" AS amount
    FROM "ListingService"
    UNION ALL
    SELECT 'Order', "id", "amount" FROM "Order"
    UNION ALL
    SELECT 'OrderItem', "id", "price" FROM "OrderItem"
  ) AS amount_fact
  WHERE amount_fact.amount IS NULL
    OR amount_fact.amount <= 0
    OR amount_fact.amount * 100 <> TRUNC(amount_fact.amount * 100)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'USD boundary migration blocked: %s row %s has invalid positive whole-cent amount %s',
        violation.relation_name,
        violation."id",
        COALESCE(violation.amount::TEXT, '<null>')
      );
  END IF;
END
$$;

DO $$
DECLARE
  provider_account_id TEXT;
BEGIN
  SELECT "id" INTO provider_account_id
  FROM "PublisherProviderAccount"
  WHERE "defaultCurrency" IS NOT NULL
    AND (
      LENGTH("defaultCurrency") <> 3
      OR ("defaultCurrency" COLLATE "C") !~ '^[A-Z]{3}$'
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'USD boundary migration blocked: provider account %s has non-canonical currency evidence',
        provider_account_id
      );
  END IF;
END
$$;

ALTER TABLE "Settlement"
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "PublisherBalance"
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "PlatformRevenue"
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "PayoutBatch"
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE "Order" ADD CONSTRAINT "Order_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "DepositAttempt" ADD CONSTRAINT "DepositAttempt_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "PaymentDispute" ADD CONSTRAINT "PaymentDispute_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "PublisherBalance" ADD CONSTRAINT "PublisherBalance_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "PlatformRevenue" ADD CONSTRAINT "PlatformRevenue_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "WithdrawalAllocation" ADD CONSTRAINT "WithdrawalAllocation_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "PayoutExecution" ADD CONSTRAINT "PayoutExecution_source_currency_usd_check" CHECK ("sourceCurrency" = 'USD');
ALTER TABLE "PayoutExecution" ADD CONSTRAINT "PayoutExecution_destination_currency_usd_check" CHECK ("destinationCurrency" = 'USD');
ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "ListingService" ADD CONSTRAINT "ListingService_currency_usd_check" CHECK ("currency" = 'USD');
ALTER TABLE "ListingService" ADD CONSTRAINT "ListingService_price_usd_minor_unit_check" CHECK (
  "price" > 0 AND "price" * 100 = TRUNC("price" * 100)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_amount_usd_minor_unit_check" CHECK (
  "amount" IS NOT NULL
  AND "amount" > 0
  AND "amount" * 100 = TRUNC("amount" * 100)
);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_price_usd_minor_unit_check" CHECK (
  "price" IS NOT NULL
  AND "price" > 0
  AND "price" * 100 = TRUNC("price" * 100)
);
ALTER TABLE "PublisherProviderAccount" ADD CONSTRAINT "PublisherProviderAccount_default_currency_canonical_check" CHECK (
  "defaultCurrency" IS NULL OR ("defaultCurrency" COLLATE "C") ~ '^[A-Z]{3}$'
);

-- Cross-row guards keep a future schema expansion from accidentally combining
-- amounts denominated by different parent records. They are intentionally
-- redundant while USD-only: defense in depth against direct SQL and old pods.
CREATE FUNCTION "assert_financial_currency_links"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ListingService' THEN
    IF EXISTS (
      SELECT 1 FROM "MarketplaceListing" parent
      WHERE parent."id" = NEW."listingId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'listing service currency does not match listing';
    END IF;
  ELSIF TG_TABLE_NAME = 'Order' THEN
    IF NEW."listingId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "MarketplaceListing" parent
      WHERE parent."id" = NEW."listingId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order currency does not match listing';
    END IF;
    IF NEW."listingServiceId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "ListingService" parent
      WHERE parent."id" = NEW."listingServiceId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'order currency does not match listing service';
    END IF;
  ELSIF TG_TABLE_NAME = 'DepositAttempt' THEN
    IF EXISTS (
      SELECT 1 FROM "Wallet" parent
      WHERE parent."id" = NEW."walletId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'deposit currency does not match wallet';
    END IF;
  ELSIF TG_TABLE_NAME = 'Settlement' THEN
    IF EXISTS (
      SELECT 1 FROM "Order" parent
      WHERE parent."id" = NEW."orderId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'settlement currency does not match order';
    END IF;
  ELSIF TG_TABLE_NAME = 'PlatformRevenue' THEN
    IF EXISTS (
      SELECT 1 FROM "Order" parent
      WHERE parent."id" = NEW."orderId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'platform revenue currency does not match order';
    END IF;
  ELSIF TG_TABLE_NAME = 'Transaction' THEN
    IF NEW."walletId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Wallet" parent
      WHERE parent."id" = NEW."walletId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'transaction currency does not match wallet';
    END IF;
    IF NEW."orderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Order" parent
      WHERE parent."id" = NEW."orderId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'transaction currency does not match order';
    END IF;
    IF NEW."settlementId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Settlement" parent
      WHERE parent."id" = NEW."settlementId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'transaction currency does not match settlement';
    END IF;
  ELSIF TG_TABLE_NAME = 'PaymentDispute' THEN
    IF EXISTS (
      SELECT 1 FROM "Wallet" parent
      WHERE parent."id" = NEW."walletId" AND parent."currency" <> NEW."currency"
    ) OR EXISTS (
      SELECT 1 FROM "DepositAttempt" parent
      WHERE parent."id" = NEW."depositAttemptId" AND parent."currency" <> NEW."currency"
    ) OR EXISTS (
      SELECT 1 FROM "Transaction" parent
      WHERE parent."id" = NEW."depositTransactionId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'payment dispute currency does not match its deposit ledger';
    END IF;
  ELSIF TG_TABLE_NAME = 'Withdrawal' THEN
    IF NEW."payoutBatchId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "PayoutBatch" parent
      WHERE parent."id" = NEW."payoutBatchId" AND parent."currency" <> NEW."currency"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'withdrawal currency does not match payout batch';
    END IF;
  ELSIF TG_TABLE_NAME = 'PayoutExecution' THEN
    IF EXISTS (
      SELECT 1 FROM "Withdrawal" parent
      WHERE parent."id" = NEW."withdrawalId"
        AND (parent."currency" <> NEW."sourceCurrency" OR parent."currency" <> NEW."destinationCurrency")
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'payout execution currency does not match withdrawal';
    END IF;
  ELSIF TG_TABLE_NAME = 'WithdrawalAllocation' THEN
    IF EXISTS (
      SELECT 1 FROM "Withdrawal" parent
      WHERE parent."id" = NEW."withdrawalId" AND parent."currency" <> NEW."currency"
    ) OR (NEW."sourceTransactionId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Transaction" parent
      WHERE parent."id" = NEW."sourceTransactionId" AND parent."currency" <> NEW."currency"
    )) OR (NEW."settlementId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Settlement" parent
      WHERE parent."id" = NEW."settlementId" AND parent."currency" <> NEW."currency"
    )) OR (NEW."orderId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "Order" parent
      WHERE parent."id" = NEW."orderId" AND parent."currency" <> NEW."currency"
    )) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'withdrawal allocation currency does not match its source';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "ListingService_currency_links_guard" BEFORE INSERT OR UPDATE ON "ListingService" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "Order_currency_links_guard" BEFORE INSERT OR UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "DepositAttempt_currency_links_guard" BEFORE INSERT OR UPDATE ON "DepositAttempt" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "Settlement_currency_links_guard" BEFORE INSERT OR UPDATE ON "Settlement" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "PlatformRevenue_currency_links_guard" BEFORE INSERT OR UPDATE ON "PlatformRevenue" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "Transaction_currency_links_guard" BEFORE INSERT OR UPDATE ON "Transaction" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "PaymentDispute_currency_links_guard" BEFORE INSERT OR UPDATE ON "PaymentDispute" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "Withdrawal_currency_links_guard" BEFORE INSERT OR UPDATE ON "Withdrawal" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "PayoutExecution_currency_links_guard" BEFORE INSERT OR UPDATE ON "PayoutExecution" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();
CREATE TRIGGER "WithdrawalAllocation_currency_links_guard" BEFORE INSERT OR UPDATE ON "WithdrawalAllocation" FOR EACH ROW EXECUTE FUNCTION "assert_financial_currency_links"();

COMMIT;
