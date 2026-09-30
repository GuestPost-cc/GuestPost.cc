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

-- Reconciliation evidence is platform-only. A worker with an explicitly
-- scoped worker context may persist detector output; Finance and Super Admin
-- can read it, while only Super Admin has a direct write path. The policies
-- deliberately do not expose rows to customer, publisher, public, webhook,
-- reporting, or auth workloads.
DO $reconciliation_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_api_group') THEN
    GRANT SELECT ON "ReconciliationCase", "ReconciliationScan", "ReconciliationCaseSnapshot"
      TO guestpost_api_group;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_worker_group') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON "ReconciliationCase", "ReconciliationScan", "ReconciliationCaseSnapshot"
      TO guestpost_worker_group;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_rls_authorizer') THEN
    GRANT SELECT ON "ReconciliationCase", "ReconciliationScan", "ReconciliationCaseSnapshot"
      TO guestpost_rls_authorizer;
  END IF;
END
$reconciliation_grants$;

-- Before the staged full-boundary activation, leave every table inert. Once
-- it is active, force these late-added tables immediately so a deployment
-- cannot create an unprotected gap between migrations and the next rollout.
DO $reconciliation_activation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'Order'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    ALTER TABLE "ReconciliationCase" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReconciliationCase" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "ReconciliationScan" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReconciliationScan" FORCE ROW LEVEL SECURITY;
    ALTER TABLE "ReconciliationCaseSnapshot" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "ReconciliationCaseSnapshot" FORCE ROW LEVEL SECURITY;
  END IF;
END
$reconciliation_activation$;

DO $reconciliation_policies$
DECLARE
  model_name text;
  worker_access text :=
    '(guestpost_rls.role_member(current_user, ''guestpost_worker_group'') ' ||
    'AND current_setting(''guestpost.rls_workload'', true) = ''WORKER'' ' ||
    'AND NULLIF(current_setting(''guestpost.rls_worker'', true), '''') IS NOT NULL)';
  super_admin_access text :=
    'guestpost_rls.staff_role_in(ARRAY[''SUPER_ADMIN''])';
BEGIN
  FOREACH model_name IN ARRAY ARRAY[
    'ReconciliationCase', 'ReconciliationScan', 'ReconciliationCaseSnapshot'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (' ||
      'current_user = ''guestpost_rls_authorizer'' OR %s OR %s OR ' ||
      'guestpost_rls.staff_role_in(ARRAY[''FINANCE'']))',
      model_name || '_full_boundary_select', model_name,
      worker_access, super_admin_access
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (%s OR %s)',
      model_name || '_full_boundary_insert', model_name,
      worker_access, super_admin_access
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (%s OR %s) ' ||
      'WITH CHECK (%s OR %s)',
      model_name || '_full_boundary_update', model_name,
      worker_access, super_admin_access, worker_access, super_admin_access
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (%s OR %s)',
      model_name || '_full_boundary_delete', model_name,
      worker_access, super_admin_access
    );
  END LOOP;
END
$reconciliation_policies$;
