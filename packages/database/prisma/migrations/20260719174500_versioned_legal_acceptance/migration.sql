-- Persist immutable evidence that a user accepted a specific legal document
-- during account creation. A new Terms version creates a new row.
CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "audience" "UserType" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LegalAcceptance_userId_documentType_documentVersion_key"
ON "LegalAcceptance"("userId", "documentType", "documentVersion");

CREATE INDEX "LegalAcceptance_acceptedAt_idx"
ON "LegalAcceptance"("acceptedAt");

CREATE INDEX "LegalAcceptance_audience_acceptedAt_idx"
ON "LegalAcceptance"("audience", "acceptedAt");

ALTER TABLE "LegalAcceptance"
ADD CONSTRAINT "LegalAcceptance_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
