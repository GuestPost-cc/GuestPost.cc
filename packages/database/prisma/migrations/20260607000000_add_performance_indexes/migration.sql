-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_action_createdAt_idx" ON "AuditLog"("organizationId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_idx" ON "Campaign"("organizationId");

-- CreateTable: MarketplaceSavedList (missing from earlier migrations)
CREATE TABLE IF NOT EXISTS "MarketplaceSavedList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MarketplaceSavedList_pkey" PRIMARY KEY ("id")
);

-- CreateTable: MarketplaceSavedListItem (missing from earlier migrations)
CREATE TABLE IF NOT EXISTS "MarketplaceSavedListItem" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "note" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketplaceSavedListItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: MarketplaceSavedList
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceSavedList_userId_slug_key" ON "MarketplaceSavedList"("userId", "slug");
CREATE INDEX IF NOT EXISTS "MarketplaceSavedList_userId_idx" ON "MarketplaceSavedList"("userId");

-- CreateIndex: MarketplaceSavedListItem
CREATE UNIQUE INDEX IF NOT EXISTS "MarketplaceSavedListItem_listId_listingId_key" ON "MarketplaceSavedListItem"("listId", "listingId");
CREATE INDEX IF NOT EXISTS "MarketplaceSavedListItem_listingId_idx" ON "MarketplaceSavedListItem"("listingId");

-- AddForeignKey: MarketplaceSavedList → User
ALTER TABLE "MarketplaceSavedList" ADD CONSTRAINT "MarketplaceSavedList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: MarketplaceSavedListItem → MarketplaceSavedList
ALTER TABLE "MarketplaceSavedListItem" ADD CONSTRAINT "MarketplaceSavedListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "MarketplaceSavedList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOTE: MarketplaceSavedListItem → MarketplaceListing FK is in the consolidation migration

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "Notification"("read");

-- CreateIndex
CREATE INDEX "Order_organizationId_status_idx" ON "Order"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Order_customerId_status_idx" ON "Order"("customerId", "status");

-- CreateIndex
CREATE INDEX "Order_assigneeId_idx" ON "Order"("assigneeId");

-- CreateIndex
CREATE INDEX "Order_websiteId_idx" ON "Order"("websiteId");

-- CreateIndex
CREATE INDEX "Order_campaignId_idx" ON "Order"("campaignId");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderEvent_actorId_idx" ON "OrderEvent"("actorId");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_publisherId_idx" ON "OrderItem"("publisherId");

-- CreateIndex
CREATE INDEX "OrderItem_websiteId_idx" ON "OrderItem"("websiteId");

-- CreateIndex
CREATE INDEX "Publication_orderItemId_idx" ON "Publication"("orderItemId");

-- CreateIndex
CREATE INDEX "Publication_verifiedBy_idx" ON "Publication"("verifiedBy");

-- CreateIndex
CREATE INDEX "Publication_verificationStatus_idx" ON "Publication"("verificationStatus");

-- CreateIndex
CREATE INDEX "Publisher_organizationId_idx" ON "Publisher"("organizationId");

-- CreateIndex
CREATE INDEX "PublisherMembership_publisherId_idx" ON "PublisherMembership"("publisherId");

-- CreateIndex
CREATE INDEX "Report_orderId_idx" ON "Report"("orderId");

-- CreateIndex
CREATE INDEX "Revision_orderId_idx" ON "Revision"("orderId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Settlement_orderId_idx" ON "Settlement"("orderId");

-- CreateIndex
CREATE INDEX "Settlement_publisherId_status_idx" ON "Settlement"("publisherId", "status");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX "Team_organizationId_idx" ON "Team"("organizationId");

-- CreateIndex
CREATE INDEX "Ticket_organizationId_status_idx" ON "Ticket"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Ticket_userId_idx" ON "Ticket"("userId");

-- CreateIndex
CREATE INDEX "Ticket_status_idx" ON "Ticket"("status");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_idx" ON "TicketMessage"("ticketId");

-- CreateIndex
CREATE INDEX "Transaction_walletId_idx" ON "Transaction"("walletId");

-- CreateIndex
CREATE INDEX "Transaction_orderId_idx" ON "Transaction"("orderId");

-- CreateIndex
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");

-- CreateIndex
CREATE INDEX "Transaction_createdAt_idx" ON "Transaction"("createdAt");

-- CreateIndex
CREATE INDEX "Wallet_organizationId_idx" ON "Wallet"("organizationId");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "Website_publisherId_idx" ON "Website"("publisherId");

-- CreateIndex
CREATE INDEX "Website_isActive_idx" ON "Website"("isActive");

-- CreateIndex
CREATE INDEX "Withdrawal_publisherId_status_idx" ON "Withdrawal"("publisherId", "status");

-- CreateIndex
CREATE INDEX "Withdrawal_approvedBy_idx" ON "Withdrawal"("approvedBy");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");
