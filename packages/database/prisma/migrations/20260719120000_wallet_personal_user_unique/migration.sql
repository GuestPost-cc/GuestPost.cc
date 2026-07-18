-- One personal wallet per user without constraining organization wallets.
--
-- Wallet.userId records the creator on organization wallets, so a global
-- UNIQUE(userId) would incorrectly prevent the same customer from owning more
-- than one organization. This migration deduplicates only legacy personal
-- wallets (organizationId IS NULL) and protects that subset with a partial
-- unique index.

DO $$
DECLARE
  keep RECORD;
  dup RECORD;
BEGIN
  FOR keep IN
    SELECT DISTINCT ON ("userId") id, "userId", currency
    FROM "Wallet"
    WHERE "organizationId" IS NULL AND "userId" IS NOT NULL
    ORDER BY "userId", "createdAt" ASC, id ASC
  LOOP
    IF EXISTS (
      SELECT 1
      FROM "Wallet"
      WHERE "organizationId" IS NULL
        AND "userId" = keep."userId"
        AND currency <> keep.currency
    ) THEN
      RAISE EXCEPTION
        'Cannot merge personal wallets for user % with different currencies',
        keep."userId";
    END IF;

    FOR dup IN
      SELECT id, "availableBalance", "reservedBalance", version
      FROM "Wallet"
      WHERE "organizationId" IS NULL
        AND "userId" = keep."userId"
        AND id <> keep.id
      ORDER BY "createdAt" ASC, id ASC
    LOOP
      UPDATE "Transaction"
      SET "walletId" = keep.id
      WHERE "walletId" = dup.id;

      UPDATE "Wallet"
      SET "availableBalance" = "availableBalance" + dup."availableBalance",
          "reservedBalance" = "reservedBalance" + dup."reservedBalance",
          version = GREATEST(version, dup.version) + 1,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = keep.id;

      DELETE FROM "Wallet" WHERE id = dup.id;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Wallet_userId_personal_key"
  ON "Wallet"("userId")
  WHERE "organizationId" IS NULL AND "userId" IS NOT NULL;
