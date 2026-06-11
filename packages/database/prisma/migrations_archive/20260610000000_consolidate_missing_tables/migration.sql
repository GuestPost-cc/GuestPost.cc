-- DisputeStatus historically existed only via db push; guard for fresh databases
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DisputeStatus') THEN
    CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED_REFUNDED', 'RESOLVED_REJECTED', 'RESOLVED_RESTORED');
  END IF;
END $$;

CREATE TYPE "ListingType" AS ENUM ('INTERNAL_SERVICE', 'PUBLISHER_WEBSITE', 'GUEST_POST', 'NICHE_EDIT', 'EDITORIAL_LINK', 'DIGITAL_PR', 'SPONSORED_CONTENT', 'OUTREACH_LINK', 'LOCAL_CITATION', 'FOUNDATION_LINK', 'BLOG_ARTICLE', 'SEO_CONTENT');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ListingFulfillmentType" AS ENUM ('INTERNAL', 'PUBLISHER', 'HYBRID');

CREATE TABLE "ActiveContext" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "activePublisherId" TEXT,

    CONSTRAINT "ActiveContext_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderDispute" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "raisedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderDispute_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SettlementApproval" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "roleAtTime" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketplaceCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceCategory_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceTag_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceListing" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "shortDescription" TEXT,
    "type" "ListingType" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "fulfillmentType" "ListingFulfillmentType" NOT NULL DEFAULT 'PUBLISHER',
    "price" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceType" TEXT NOT NULL DEFAULT 'fixed',
    "minPrice" DECIMAL(65,30),
    "maxPrice" DECIMAL(65,30),
    "domainRating" INTEGER,
    "domainAuthority" INTEGER,
    "traffic" INTEGER,
    "referringDomains" INTEGER,
    "spamScore" INTEGER,
    "country" TEXT,
    "language" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "turnaroundDays" INTEGER,
    "revisionRounds" INTEGER NOT NULL DEFAULT 2,
    "warrantyDays" INTEGER,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "allowGuestPost" BOOLEAN NOT NULL DEFAULT true,
    "allowNicheEdit" BOOLEAN NOT NULL DEFAULT true,
    "doFollowOnly" BOOLEAN NOT NULL DEFAULT false,
    "websiteUrl" TEXT,
    "sampleUrl" TEXT,
    "signupUrl" TEXT,
    "metricsData" JSONB,
    "trafficData" JSONB,
    "semrushData" JSONB,
    "publisherId" TEXT,
    "websiteId" TEXT,
    "organizationId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,

    CONSTRAINT "MarketplaceListing_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceListingTag" (
    "listingId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "MarketplaceListingTag_pkey" PRIMARY KEY ("listingId","tagId")
);


CREATE TABLE "MarketplaceListingImage" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceListingImage_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplacePricingTier" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "description" TEXT,
    "features" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplacePricingTier_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceReview" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceReview_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceFavorite_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceListingView" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceListingView_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceListingClick" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "ipAddress" TEXT,
    "action" TEXT NOT NULL DEFAULT 'view',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceListingClick_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceSearchHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "query" TEXT NOT NULL,
    "filters" JSONB,
    "resultCount" INTEGER,
    "clickedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceSearchHistory_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceRecommendation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceRecommendation_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "PublisherProfile" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "bio" TEXT,
    "stats" JSONB,
    "responseTime" INTEGER,
    "completionRate" DOUBLE PRECISION,
    "rating" DOUBLE PRECISION,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublisherProfile_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "MarketplaceFlag" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "data" JSONB,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceFlag_pkey" PRIMARY KEY ("id")
);


CREATE TABLE "ListingFulfillmentRule" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingFulfillmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (already created by init on fresh databases; guard for both paths)
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Session_token_key" ON "Session"("token");

-- CreateIndex


CREATE UNIQUE INDEX "ActiveContext_userId_key" ON "ActiveContext"("userId");
CREATE UNIQUE INDEX "OrderDispute_orderId_key" ON "OrderDispute"("orderId");
CREATE INDEX "SettlementApproval_settlementId_idx" ON "SettlementApproval"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementApproval_settlementId_type_key" ON "SettlementApproval"("settlementId", "type");
CREATE UNIQUE INDEX "MarketplaceCategory_slug_key" ON "MarketplaceCategory"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceCategory_slug_idx" ON "MarketplaceCategory"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceCategory_parentId_idx" ON "MarketplaceCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceTag_name_key" ON "MarketplaceTag"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceTag_slug_key" ON "MarketplaceTag"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceListing_slug_key" ON "MarketplaceListing"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceListing_slug_idx" ON "MarketplaceListing"("slug");

-- CreateIndex
CREATE INDEX "MarketplaceListing_type_idx" ON "MarketplaceListing"("type");

-- CreateIndex
CREATE INDEX "MarketplaceListing_status_idx" ON "MarketplaceListing"("status");

-- CreateIndex
CREATE INDEX "MarketplaceListing_publisherId_idx" ON "MarketplaceListing"("publisherId");

-- CreateIndex
CREATE INDEX "MarketplaceListing_categoryId_idx" ON "MarketplaceListing"("categoryId");

-- CreateIndex
CREATE INDEX "MarketplaceListing_featured_idx" ON "MarketplaceListing"("featured");

-- CreateIndex
CREATE INDEX "MarketplaceListing_createdAt_idx" ON "MarketplaceListing"("createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceListing_price_idx" ON "MarketplaceListing"("price");
CREATE INDEX "MarketplaceListingImage_listingId_idx" ON "MarketplaceListingImage"("listingId");

-- CreateIndex
CREATE INDEX "MarketplacePricingTier_listingId_idx" ON "MarketplacePricingTier"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceReview_listingId_idx" ON "MarketplaceReview"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceReview_userId_idx" ON "MarketplaceReview"("userId");

-- CreateIndex
CREATE INDEX "MarketplaceFavorite_userId_idx" ON "MarketplaceFavorite"("userId");

-- CreateIndex
CREATE INDEX "MarketplaceFavorite_listingId_idx" ON "MarketplaceFavorite"("listingId");
CREATE UNIQUE INDEX "MarketplaceFavorite_userId_listingId_key" ON "MarketplaceFavorite"("userId", "listingId");
CREATE INDEX "MarketplaceListingView_listingId_idx" ON "MarketplaceListingView"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceListingView_createdAt_idx" ON "MarketplaceListingView"("createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceListingView_userId_idx" ON "MarketplaceListingView"("userId");

-- CreateIndex
CREATE INDEX "MarketplaceListingClick_listingId_idx" ON "MarketplaceListingClick"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceListingClick_createdAt_idx" ON "MarketplaceListingClick"("createdAt");

-- CreateIndex
CREATE INDEX "MarketplaceListingClick_action_idx" ON "MarketplaceListingClick"("action");

-- CreateIndex
CREATE INDEX "MarketplaceSearchHistory_userId_idx" ON "MarketplaceSearchHistory"("userId");

-- CreateIndex
CREATE INDEX "MarketplaceSearchHistory_query_idx" ON "MarketplaceSearchHistory"("query");

-- CreateIndex
CREATE INDEX "MarketplaceRecommendation_userId_idx" ON "MarketplaceRecommendation"("userId");

-- CreateIndex
CREATE INDEX "MarketplaceRecommendation_listingId_idx" ON "MarketplaceRecommendation"("listingId");

-- CreateIndex
CREATE INDEX "MarketplaceRecommendation_type_idx" ON "MarketplaceRecommendation"("type");

-- CreateIndex
CREATE UNIQUE INDEX "PublisherProfile_publisherId_key" ON "PublisherProfile"("publisherId");

-- CreateIndex
CREATE INDEX "MarketplaceFlag_type_idx" ON "MarketplaceFlag"("type");

-- CreateIndex
CREATE INDEX "MarketplaceFlag_status_idx" ON "MarketplaceFlag"("status");

-- CreateIndex
CREATE INDEX "MarketplaceFlag_severity_idx" ON "MarketplaceFlag"("severity");

-- CreateIndex
CREATE INDEX "ListingFulfillmentRule_listingId_idx" ON "ListingFulfillmentRule"("listingId");

ALTER TABLE "ActiveContext" ADD CONSTRAINT "ActiveContext_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderDispute" ADD CONSTRAINT "OrderDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementApproval" ADD CONSTRAINT "SettlementApproval_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceCategory" ADD CONSTRAINT "MarketplaceCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MarketplaceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListing" ADD CONSTRAINT "MarketplaceListing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MarketplaceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListingTag" ADD CONSTRAINT "MarketplaceListingTag_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListingTag" ADD CONSTRAINT "MarketplaceListingTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "MarketplaceTag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListingImage" ADD CONSTRAINT "MarketplaceListingImage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplacePricingTier" ADD CONSTRAINT "MarketplacePricingTier_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceReview" ADD CONSTRAINT "MarketplaceReview_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceReview" ADD CONSTRAINT "MarketplaceReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceFavorite" ADD CONSTRAINT "MarketplaceFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceFavorite" ADD CONSTRAINT "MarketplaceFavorite_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketplaceListingView" ADD CONSTRAINT "MarketplaceListingView_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceListingClick" ADD CONSTRAINT "MarketplaceListingClick_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublisherProfile" ADD CONSTRAINT "PublisherProfile_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceSavedListItem" ADD CONSTRAINT "MarketplaceSavedListItem_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceSearchHistory" ADD CONSTRAINT "MarketplaceSearchHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceFlag" ADD CONSTRAINT "MarketplaceFlag_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRecommendation" ADD CONSTRAINT "MarketplaceRecommendation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketplaceRecommendation" ADD CONSTRAINT "MarketplaceRecommendation_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListingFulfillmentRule" ADD CONSTRAINT "ListingFulfillmentRule_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
