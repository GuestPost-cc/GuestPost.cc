-- Pending-invite flow: a membership is PENDING until the invited user accepts.
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING', 'ACTIVE');

-- Existing memberships are already active (they predate the accept step).
ALTER TABLE "Membership" ADD COLUMN "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");
