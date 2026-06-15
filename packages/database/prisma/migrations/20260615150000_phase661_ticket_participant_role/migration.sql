-- Phase 6.6.1: TicketParticipantRole + TicketMessageType snapshot on every
-- TicketMessage row.
--
-- Why: support tickets are now part of disputes / refund investigations /
-- settlement reviews / publisher trust reviews. Without a snapshotted role,
-- an audit trail forces a join through User → StaffMembership → Role, and
-- worse, the join returns the CURRENT role. A staffer promoted from OPS to
-- SUPER_ADMIN six months later would have her historical "Delivery verified"
-- message re-rendered as [ADMIN] instead of [OPS]. Snapshotting fixes this.
--
-- This mirrors the SettlementApproval.roleAtTime pattern already in place
-- elsewhere in the platform.
--
-- Strategy: nullable column → backfill from best-available current data →
-- ALTER NOT NULL. The backfill is best-effort for historical rows: a staffer
-- whose StaffMembership role has since changed will be backfilled with their
-- CURRENT role. We log this caveat in the migration metadata so future
-- forensic queries know rows older than this migration may carry the wrong
-- role; rows written after this migration are always accurate (server
-- derives + persists at write time).

CREATE TYPE "TicketParticipantRole" AS ENUM (
  'CUSTOMER',
  'PUBLISHER',
  'OPS',
  'ADMIN',
  'FINANCE'
);

CREATE TYPE "TicketMessageType" AS ENUM (
  'MESSAGE',
  'INTERNAL_NOTE',
  'SYSTEM_EVENT'
);

-- Step 1: add columns (participantRole nullable for backfill window).
ALTER TABLE "TicketMessage"
  ADD COLUMN "participantRole" "TicketParticipantRole",
  ADD COLUMN "messageType"     "TicketMessageType" NOT NULL DEFAULT 'MESSAGE';

-- Step 2: backfill participantRole.
--
-- Order matters — we set the more-specific class first (STAFF roles), then
-- PUBLISHER, then default the residue to CUSTOMER. A user might appear in
-- multiple memberships; the WHERE on userType narrows STAFF/PUBLISHER paths
-- so the residue is correctly CUSTOMER.

-- STAFF authors: derive from current StaffMembership.role.
UPDATE "TicketMessage" m
SET "participantRole" = CASE sm."role"
  WHEN 'SUPER_ADMIN' THEN 'ADMIN'::"TicketParticipantRole"
  WHEN 'OPERATIONS'  THEN 'OPS'::"TicketParticipantRole"
  WHEN 'FINANCE'     THEN 'FINANCE'::"TicketParticipantRole"
END
FROM "User" u
JOIN "StaffMembership" sm ON sm."userId" = u."id"
WHERE m."userId" = u."id"
  AND u."userType" = 'STAFF'
  AND m."participantRole" IS NULL;

-- PUBLISHER authors.
UPDATE "TicketMessage" m
SET "participantRole" = 'PUBLISHER'::"TicketParticipantRole"
FROM "User" u
WHERE m."userId" = u."id"
  AND u."userType" = 'PUBLISHER'
  AND m."participantRole" IS NULL;

-- Residue: everything else is CUSTOMER. Covers CUSTOMER user-type and any
-- STAFF authors who somehow have no StaffMembership row.
UPDATE "TicketMessage"
SET "participantRole" = 'CUSTOMER'::"TicketParticipantRole"
WHERE "participantRole" IS NULL;

-- Step 3: lock in NOT NULL so new rows can never be written without a role.
ALTER TABLE "TicketMessage"
  ALTER COLUMN "participantRole" SET NOT NULL;

-- Audit/investigation filter: "all FINANCE messages on this ticket",
-- "all OPS replies in this window".
CREATE INDEX "TicketMessage_ticketId_participantRole_idx"
  ON "TicketMessage"("ticketId", "participantRole");
