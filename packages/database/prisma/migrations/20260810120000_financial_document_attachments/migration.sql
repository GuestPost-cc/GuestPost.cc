-- Immutable, sequential financial documents used for secure email PDF
-- attachments. Billing profiles remain mutable; issued documents snapshot
-- their values so accounting history cannot be silently rewritten.

CREATE TYPE "FinancialDocumentKind" AS ENUM (
  'PAID_INVOICE',
  'CREDIT_NOTE',
  'DEPOSIT_RECEIPT'
);

CREATE TABLE "BillingProfile" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "legalName" VARCHAR(160) NOT NULL,
  "billingEmail" VARCHAR(320),
  "addressLine1" VARCHAR(160) NOT NULL,
  "addressLine2" VARCHAR(160),
  "city" VARCHAR(100) NOT NULL,
  "region" VARCHAR(100),
  "postalCode" VARCHAR(32) NOT NULL,
  "countryCode" VARCHAR(2) NOT NULL,
  "taxIdType" VARCHAR(32),
  "taxId" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingProfile_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingProfile_nonblank_check" CHECK (
    btrim("legalName") <> '' AND
    btrim("addressLine1") <> '' AND
    btrim("city") <> '' AND
    btrim("postalCode") <> ''
  ),
  CONSTRAINT "BillingProfile_countryCode_check" CHECK (
    "countryCode" ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT "BillingProfile_tax_pair_check" CHECK (
    ("taxIdType" IS NULL AND "taxId" IS NULL) OR
    (btrim("taxIdType") <> '' AND btrim("taxId") <> '')
  )
);

CREATE UNIQUE INDEX "BillingProfile_organizationId_key"
  ON "BillingProfile"("organizationId");
CREATE INDEX "BillingProfile_countryCode_idx"
  ON "BillingProfile"("countryCode");

ALTER TABLE "BillingProfile"
  ADD CONSTRAINT "BillingProfile_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunicationDelivery"
  ADD COLUMN "attachmentName" VARCHAR(191),
  ADD COLUMN "attachmentSha256" CHAR(64),
  ADD COLUMN "attachmentSize" INTEGER;

ALTER TABLE "CommunicationDelivery"
  ADD CONSTRAINT "CommunicationDelivery_attachment_metadata_check" CHECK (
    ("attachmentName" IS NULL AND "attachmentSha256" IS NULL AND "attachmentSize" IS NULL) OR
    (
      btrim("attachmentName") <> '' AND
      "attachmentSha256" ~ '^[0-9a-f]{64}$' AND
      "attachmentSize" BETWEEN 1 AND 5242880
    )
  );

CREATE SEQUENCE "FinancialDocument_sequenceNumber_seq" AS BIGINT;

CREATE TABLE "FinancialDocument" (
  "id" TEXT NOT NULL,
  "sequenceNumber" BIGINT NOT NULL DEFAULT nextval('"FinancialDocument_sequenceNumber_seq"'),
  "kind" "FinancialDocumentKind" NOT NULL,
  "numberPrefix" VARCHAR(12) NOT NULL,
  "aggregateType" VARCHAR(64) NOT NULL,
  "aggregateId" VARCHAR(191) NOT NULL,
  "organizationId" TEXT,
  "relatedDocumentId" TEXT,
  "currency" VARCHAR(3) NOT NULL,
  "subtotal" DECIMAL(18,2) NOT NULL,
  "taxAmount" DECIMAL(18,2) NOT NULL,
  "total" DECIMAL(18,2) NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshot" JSONB NOT NULL,
  "dedupKey" VARCHAR(256) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FinancialDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialDocument_prefix_check" CHECK (
    "numberPrefix" ~ '^[A-Z0-9]{2,12}$'
  ),
  CONSTRAINT "FinancialDocument_currency_check" CHECK (
    "currency" ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT "FinancialDocument_amounts_check" CHECK (
    "subtotal" >= 0 AND
    "taxAmount" >= 0 AND
    "total" >= 0 AND
    "total" = "subtotal" + "taxAmount"
  )
);

ALTER SEQUENCE "FinancialDocument_sequenceNumber_seq"
  OWNED BY "FinancialDocument"."sequenceNumber";

CREATE UNIQUE INDEX "FinancialDocument_sequenceNumber_key"
  ON "FinancialDocument"("sequenceNumber");
CREATE UNIQUE INDEX "FinancialDocument_dedupKey_key"
  ON "FinancialDocument"("dedupKey");
CREATE UNIQUE INDEX "FinancialDocument_kind_aggregateType_aggregateId_key"
  ON "FinancialDocument"("kind", "aggregateType", "aggregateId");
CREATE INDEX "FinancialDocument_organizationId_issuedAt_idx"
  ON "FinancialDocument"("organizationId", "issuedAt");
CREATE INDEX "FinancialDocument_aggregateType_aggregateId_idx"
  ON "FinancialDocument"("aggregateType", "aggregateId");
CREATE INDEX "FinancialDocument_relatedDocumentId_idx"
  ON "FinancialDocument"("relatedDocumentId");

ALTER TABLE "FinancialDocument"
  ADD CONSTRAINT "FinancialDocument_relatedDocumentId_fkey"
  FOREIGN KEY ("relatedDocumentId") REFERENCES "FinancialDocument"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION reject_financial_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'issued financial documents are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "FinancialDocument_immutable_update"
BEFORE UPDATE ON "FinancialDocument"
FOR EACH ROW EXECUTE FUNCTION reject_financial_document_mutation();

CREATE TRIGGER "FinancialDocument_immutable_delete"
BEFORE DELETE ON "FinancialDocument"
FOR EACH ROW EXECUTE FUNCTION reject_financial_document_mutation();
