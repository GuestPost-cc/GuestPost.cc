-- SettlementApproval.type: raw string -> enum (prevents typo pollution)
CREATE TYPE "SettlementApprovalType" AS ENUM ('CUSTOMER', 'ADMIN');

ALTER TABLE "SettlementApproval"
  ALTER COLUMN "type" TYPE "SettlementApprovalType"
  USING "type"::"SettlementApprovalType";
