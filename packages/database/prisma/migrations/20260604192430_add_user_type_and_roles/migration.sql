-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('CUSTOMER', 'PUBLISHER', 'STAFF');

-- CreateEnum
CREATE TYPE "CustomerRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "PublisherRole" AS ENUM ('PUBLISHER_OWNER');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS');

-- AlterTable: add userType to User
ALTER TABLE "User" ADD COLUMN "userType" "UserType" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable: make Wallet.organizationId nullable
ALTER TABLE "Wallet" ALTER COLUMN "organizationId" DROP NOT NULL;

-- AlterTable: change Membership.role from MemberRole to CustomerRole
ALTER TABLE "Membership" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Membership" ALTER COLUMN "role" TYPE "CustomerRole" USING (
  CASE
    WHEN "role" = 'OWNER' THEN 'OWNER'::"CustomerRole"
    ELSE 'MEMBER'::"CustomerRole"
  END
);
ALTER TABLE "Membership" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- CreateTable: PublisherMembership
CREATE TABLE "PublisherMembership" (
    "id" TEXT NOT NULL,
    "role" "PublisherRole" NOT NULL DEFAULT 'PUBLISHER_OWNER',
    "userId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublisherMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StaffMembership
CREATE TABLE "StaffMembership" (
    "id" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'OPERATIONS',
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublisherMembership_userId_publisherId_key" ON "PublisherMembership"("userId", "publisherId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffMembership_userId_key" ON "StaffMembership"("userId");

-- AddForeignKey
ALTER TABLE "PublisherMembership" ADD CONSTRAINT "PublisherMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublisherMembership" ADD CONSTRAINT "PublisherMembership_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "Publisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMembership" ADD CONSTRAINT "StaffMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
