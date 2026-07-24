-- Customer source articles and fulfillment submissions have distinct,
-- immutable provenance. Article bodies are never stored in audit metadata.

CREATE TYPE "OrderArticleSource" AS ENUM (
  'CUSTOMER',
  'PUBLISHER',
  'OPERATIONS'
);

CREATE TYPE "OrderArticlePurpose" AS ENUM (
  'SOURCE_ARTICLE',
  'FINAL_SUBMISSION'
);

CREATE TYPE "OrderArticleFormat" AS ENUM (
  'PLAIN_TEXT',
  'MARKDOWN'
);

CREATE TABLE "OrderArticleVersion" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "source" "OrderArticleSource" NOT NULL,
  "purpose" "OrderArticlePurpose" NOT NULL,
  "title" VARCHAR(200),
  "body" TEXT NOT NULL,
  "format" "OrderArticleFormat" NOT NULL DEFAULT 'MARKDOWN',
  "checksum" VARCHAR(64) NOT NULL,
  "wordCount" INTEGER NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "supersedesId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderArticleVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderArticleVersion_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 200000),
  CONSTRAINT "OrderArticleVersion_word_count_check"
    CHECK ("wordCount" >= 0)
);

CREATE UNIQUE INDEX "OrderArticleVersion_orderId_source_purpose_version_key"
  ON "OrderArticleVersion"("orderId", "source", "purpose", "version");
CREATE INDEX "OrderArticleVersion_orderId_purpose_createdAt_idx"
  ON "OrderArticleVersion"("orderId", "purpose", "createdAt");
CREATE INDEX "OrderArticleVersion_createdByUserId_idx"
  ON "OrderArticleVersion"("createdByUserId");
CREATE INDEX "OrderArticleVersion_supersedesId_idx"
  ON "OrderArticleVersion"("supersedesId");

ALTER TABLE "OrderArticleVersion"
  ADD CONSTRAINT "OrderArticleVersion_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderArticleVersion"
  ADD CONSTRAINT "OrderArticleVersion_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "OrderArticleVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
