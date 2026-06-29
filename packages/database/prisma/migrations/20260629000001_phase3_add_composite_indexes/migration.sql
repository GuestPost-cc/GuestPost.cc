-- Phase 3 — Add composite indexes for operational queries
--   User(userType, banned)     — moderation/user listing queries
--   Transaction(walletId, type) — wallet transaction history filtered by type

CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_userType_banned_idx" ON "User"("userType", "banned");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transaction_walletId_type_idx" ON "Transaction"("walletId", "type");
