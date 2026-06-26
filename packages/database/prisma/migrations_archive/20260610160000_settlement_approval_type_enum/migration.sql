-- SettlementApproval.type: raw string -> enum (prevents typo pollution)
-- Fail closed — raise if any unexpected value exists rather than silently
-- converting business data.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "SettlementApproval"
        WHERE "type" NOT IN ('CUSTOMER', 'ADMIN')
    ) THEN
        RAISE EXCEPTION 'Unexpected SettlementApproval.type values detected';
    END IF;
END $$;

CREATE TYPE "SettlementApprovalType" AS ENUM ('CUSTOMER', 'ADMIN');

ALTER TABLE "SettlementApproval"
  ALTER COLUMN "type" TYPE "SettlementApprovalType"
  USING "type"::"SettlementApprovalType";
