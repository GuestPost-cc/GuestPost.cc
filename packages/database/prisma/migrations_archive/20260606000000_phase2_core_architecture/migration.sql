-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('ORDER_CREATED', 'PAYMENT_RECEIVED', 'ASSIGNED', 'CONTENT_SUBMITTED', 'CONTENT_APPROVED', 'PUBLISHED', 'VERIFIED', 'UNDER_REVIEW', 'SETTLED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'DISPUTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublisherTier" AS ENUM ('NEW', 'TRUSTED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'DISPUTED');

-- AlterEnum: OrderStatus — add new values, keep existing ones
BEGIN;
CREATE TYPE "OrderStatus_new" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'ASSIGNED', 'CONTENT_CREATION', 'OUTREACH', 'PUBLISHED', 'VERIFIED', 'UNDER_REVIEW', 'SETTLED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'REJECTED', 'DISPUTED');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING ("status"::text::"OrderStatus_new");
ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "OrderStatus_old";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterEnum: add FINANCE to StaffRole
ALTER TYPE "StaffRole" ADD VALUE 'FINANCE';

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "ipAddress" TEXT,
ADD COLUMN "userAgent" TEXT;

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN "tier" "PublisherTier" NOT NULL DEFAULT 'NEW';

-- AlterTable: Wallet — rename balance to availableBalance, add reservedBalance
ALTER TABLE "Wallet" DROP COLUMN "balance",
ADD COLUMN "availableBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "reservedBalance" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable: Update Order default status
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- CreateTable: OrderItem
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "websiteId" TEXT,
    "publisherId" TEXT,
    "targetUrl" TEXT,
    "anchorText" TEXT,
    "price" DECIMAL(65,30),
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: OrderEvent
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventType" "OrderEventType" NOT NULL,
    "actorId" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Publication
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "publishedUrl" TEXT,
    "targetUrl" TEXT,
    "anchorText" TEXT,
    "publicationDate" TIMESTAMP(3),
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "screenshotUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Settlement
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "grossAmount" DECIMAL(65,30) NOT NULL,
    "platformFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "publisherAmount" DECIMAL(65,30) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "reviewEndsAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PublisherBalance
CREATE TABLE "PublisherBalance" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "pendingBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "approvedBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "withdrawableBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lifetimeEarnings" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublisherBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Withdrawal
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'bank_transfer',
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ApiKey
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublisherBalance_publisherId_key" ON "PublisherBalance"("publisherId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- AddForeignKey: OrderItem → Order
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: OrderItem → Website
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "Website"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: OrderEvent → Order
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: OrderEvent → User (actor)
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Publication → OrderItem
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Publication → User (verifier)
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_verifiedBy_fkey" FOREIGN KEY ("verifiedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Settlement → Order
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Settlement → Publisher
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: PublisherBalance → Publisher
ALTER TABLE "PublisherBalance" ADD CONSTRAINT "PublisherBalance_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Withdrawal → Publisher
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: Withdrawal → User (approver)
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ApiKey → Organization
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop old Wallet FK and recreate (column structure unchanged, just schema sync)
ALTER TABLE "Wallet" DROP CONSTRAINT IF EXISTS "Wallet_organizationId_fkey";
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
