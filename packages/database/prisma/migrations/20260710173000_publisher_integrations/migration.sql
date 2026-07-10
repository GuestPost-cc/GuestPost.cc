-- CreateEnum
CREATE TYPE "IntegrationOwnerType" AS ENUM ('PUBLISHER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS', 'BING_WEBMASTER');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('PENDING', 'DISCOVERING', 'ACTIVE', 'TOKEN_EXPIRED', 'REAUTH_REQUIRED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "WebsiteIntegrationStatus" AS ENUM ('CONNECTED', 'SYNCING', 'OUT_OF_SYNC', 'REMOVED', 'DISABLED');

-- CreateEnum
CREATE TYPE "IntegrationSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationSyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'OAUTH');

-- CreateEnum
CREATE TYPE "GooglePermissionLevel" AS ENUM ('siteOwner', 'siteFullUser', 'siteLimitedUser', 'siteAssociate', 'none');

-- CreateTable
CREATE TABLE "PublisherIntegration" (
    "id" TEXT NOT NULL,
    "ownerType" "IntegrationOwnerType" NOT NULL DEFAULT 'PUBLISHER',
    "ownerId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncAt" TIMESTAMP(3),
    "discoveredAt" TIMESTAMP(3),
    "discoveredResources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublisherIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptedTokensVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteIntegration" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "propertyUrl" TEXT NOT NULL,
    "permissionLevel" "GooglePermissionLevel" NOT NULL DEFAULT 'none',
    "status" "WebsiteIntegrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSync" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "IntegrationSyncTrigger" NOT NULL DEFAULT 'MANUAL',
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsExpected" INTEGER NOT NULL DEFAULT 0,
    "itemsCompleted" INTEGER NOT NULL DEFAULT 0,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteSearchDaily" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteSearchDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsitePageSearchDaily" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsitePageSearchDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublisherIntegration_provider_providerAccountId_key" ON "PublisherIntegration"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "PublisherIntegration_ownerType_ownerId_idx" ON "PublisherIntegration"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "PublisherIntegration_status_idx" ON "PublisherIntegration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_key" ON "IntegrationCredential"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteIntegration_integrationId_propertyUrl_key" ON "WebsiteIntegration"("integrationId", "propertyUrl");

-- CreateIndex
CREATE INDEX "WebsiteIntegration_websiteId_idx" ON "WebsiteIntegration"("websiteId");

-- CreateIndex
CREATE INDEX "WebsiteIntegration_status_idx" ON "WebsiteIntegration"("status");

-- CreateIndex
CREATE INDEX "IntegrationSync_integrationId_idx" ON "IntegrationSync"("integrationId");

-- CreateIndex
CREATE INDEX "IntegrationSync_status_idx" ON "IntegrationSync"("status");

-- CreateIndex
CREATE INDEX "IntegrationSync_startedAt_idx" ON "IntegrationSync"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteSearchDaily_websiteId_date_key" ON "WebsiteSearchDaily"("websiteId", "date");

-- CreateIndex
CREATE INDEX "WebsiteSearchDaily_websiteId_date_idx" ON "WebsiteSearchDaily"("websiteId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePageSearchDaily_websiteId_pageUrl_date_key" ON "WebsitePageSearchDaily"("websiteId", "pageUrl", "date");

-- CreateIndex
CREATE INDEX "WebsitePageSearchDaily_websiteId_date_idx" ON "WebsitePageSearchDaily"("websiteId", "date");

-- AddForeignKey
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "PublisherIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "PublisherIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteIntegration" ADD CONSTRAINT "WebsiteIntegration_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSync" ADD CONSTRAINT "IntegrationSync_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "PublisherIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
