-- Durable, detection-only reconciliation workbench. This migration does not
-- alter balances or ledger evidence and intentionally creates no repair path.

CREATE TYPE "ReconciliationCaseStatus" AS ENUM (
  'DETECTED',
  'NEEDS_EVIDENCE',
  'AWAITING_APPROVAL',
  'APPLIED',
  'VERIFIED',
  'BLOCKED'
);

CREATE TABLE "ReconciliationCase" (
  "id" TEXT NOT NULL,
  "aggregateType" VARCHAR(64) NOT NULL,
  "aggregateId" VARCHAR(191) NOT NULL,
  "orderId" TEXT,
  "status" "ReconciliationCaseStatus" NOT NULL DEFAULT 'DETECTED',
  "currentFingerprint" CHAR(64) NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReconciliationCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationCase_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReconciliationScan" (
  "id" TEXT NOT NULL,
  "reportVersion" INTEGER NOT NULL,
  "detector" VARCHAR(64) NOT NULL,
  "ranAt" TIMESTAMP(3) NOT NULL,
  "report" JSONB NOT NULL,
  "initiatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationScan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReconciliationCaseSnapshot" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "evidenceFingerprint" CHAR(64) NOT NULL,
  "findingCodes" TEXT[] NOT NULL,
  "findings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReconciliationCaseSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReconciliationCaseSnapshot_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ReconciliationCaseSnapshot_scanId_fkey"
    FOREIGN KEY ("scanId") REFERENCES "ReconciliationScan"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReconciliationCase_aggregateType_aggregateId_key"
  ON "ReconciliationCase"("aggregateType", "aggregateId");
CREATE INDEX "ReconciliationCase_status_lastDetectedAt_idx"
  ON "ReconciliationCase"("status", "lastDetectedAt");
CREATE INDEX "ReconciliationCase_orderId_idx" ON "ReconciliationCase"("orderId");
CREATE INDEX "ReconciliationScan_ranAt_idx" ON "ReconciliationScan"("ranAt");
CREATE INDEX "ReconciliationScan_detector_ranAt_idx"
  ON "ReconciliationScan"("detector", "ranAt");
CREATE UNIQUE INDEX "ReconciliationCaseSnapshot_caseId_scanId_key"
  ON "ReconciliationCaseSnapshot"("caseId", "scanId");
CREATE INDEX "ReconciliationCaseSnapshot_caseId_createdAt_idx"
  ON "ReconciliationCaseSnapshot"("caseId", "createdAt");
CREATE INDEX "ReconciliationCaseSnapshot_evidenceFingerprint_idx"
  ON "ReconciliationCaseSnapshot"("evidenceFingerprint");

CREATE FUNCTION "guard_reconciliation_case"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."aggregateType" <> 'Order'
     OR NEW."orderId" IS NULL
     OR NEW."aggregateId" <> NEW."orderId"
     OR NEW."currentFingerprint" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reconciliation cases must be order-bound, canonical detector evidence';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."aggregateType" <> OLD."aggregateType"
       OR NEW."aggregateId" <> OLD."aggregateId"
       OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."detectedAt" <> OLD."detectedAt"
       OR NEW."lastDetectedAt" < OLD."lastDetectedAt"
       OR NEW."version" <> OLD."version" + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'reconciliation case identity and detection history are immutable';
    END IF;
    IF OLD."status" IN ('APPLIED', 'VERIFIED') AND NEW."status" <> OLD."status" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'terminal reconciliation case status is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReconciliationCase_guard"
BEFORE INSERT OR UPDATE ON "ReconciliationCase"
FOR EACH ROW EXECUTE FUNCTION "guard_reconciliation_case"();

CREATE FUNCTION "reject_reconciliation_evidence_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'reconciliation scan evidence is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReconciliationScan_no_update"
BEFORE UPDATE OR DELETE ON "ReconciliationScan"
FOR EACH ROW EXECUTE FUNCTION "reject_reconciliation_evidence_mutation"();

CREATE TRIGGER "ReconciliationCaseSnapshot_no_update"
BEFORE UPDATE OR DELETE ON "ReconciliationCaseSnapshot"
FOR EACH ROW EXECUTE FUNCTION "reject_reconciliation_evidence_mutation"();

CREATE FUNCTION "guard_reconciliation_case_snapshot"()
RETURNS TRIGGER AS $$
BEGIN
  IF cardinality(NEW."findingCodes") = 0
     OR NEW."evidenceFingerprint" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'reconciliation snapshots require canonical finding evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReconciliationCaseSnapshot_guard"
BEFORE INSERT ON "ReconciliationCaseSnapshot"
FOR EACH ROW EXECUTE FUNCTION "guard_reconciliation_case_snapshot"();
