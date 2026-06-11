-- Financial integrity constraints
--
-- 1. Wallet: one wallet per organization (fixes duplicate-wallet race).
--    Existing duplicates are merged into the oldest wallet per org before
--    the unique index is created.
-- 2. Settlement: at most one non-cancelled settlement per order (fixes
--    double-settlement race). Newer duplicate active settlements are
--    cancelled before the partial unique index is created.

-- ── Wallet: merge duplicate org wallets into the oldest one ────────────────
DO $$
DECLARE
  keep RECORD;
  dup RECORD;
BEGIN
  FOR keep IN
    SELECT DISTINCT ON ("organizationId") id, "organizationId"
    FROM "Wallet"
    WHERE "organizationId" IS NOT NULL
    ORDER BY "organizationId", "createdAt" ASC
  LOOP
    FOR dup IN
      SELECT id, "availableBalance", "reservedBalance"
      FROM "Wallet"
      WHERE "organizationId" = keep."organizationId" AND id <> keep.id
    LOOP
      UPDATE "Transaction" SET "walletId" = keep.id WHERE "walletId" = dup.id;
      UPDATE "Wallet"
        SET "availableBalance" = "availableBalance" + dup."availableBalance",
            "reservedBalance"  = "reservedBalance"  + dup."reservedBalance"
        WHERE id = keep.id;
      DELETE FROM "Wallet" WHERE id = dup.id;
    END LOOP;
  END LOOP;
END $$;

DROP INDEX IF EXISTS "Wallet_organizationId_idx";
CREATE UNIQUE INDEX "Wallet_organizationId_key" ON "Wallet"("organizationId");

-- ── Settlement: cancel newer duplicate active settlements ──────────────────
UPDATE "Settlement" s
SET    "status" = 'CANCELLED'
WHERE  s."status" <> 'CANCELLED'
AND EXISTS (
  SELECT 1 FROM "Settlement" s2
  WHERE  s2."orderId" = s."orderId"
  AND    s2."status" <> 'CANCELLED'
  AND    (s2."createdAt" < s."createdAt" OR (s2."createdAt" = s."createdAt" AND s2.id < s.id))
);

-- Partial unique index: only one non-cancelled settlement per order.
-- Not representable in Prisma schema — see comment on the Settlement model.
CREATE UNIQUE INDEX "Settlement_orderId_active_key"
  ON "Settlement"("orderId")
  WHERE "status" <> 'CANCELLED';
