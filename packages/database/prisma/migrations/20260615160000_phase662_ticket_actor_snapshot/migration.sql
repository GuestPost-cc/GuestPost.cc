-- Phase 6.6.2: actorSnapshot on TicketMessage.
--
-- The uncollapsed companion to participantRole. participantRole says "OPS"
-- or "FINANCE" — actorSnapshot preserves the raw schema-level roles
-- (StaffRole / CustomerRole / PublisherRole) so investigation queries can
-- answer specifically: "was this CUSTOMER an OWNER or MEMBER?" / "was this
-- STAFF SUPER_ADMIN vs OPERATIONS?" — without joining through
-- StaffMembership / Membership, both of which mutate over time and would
-- give the *current* role, not the one held at write time.
--
-- Purely additive. Nullable column, no backfill. Pre-migration rows stay
-- NULL (and queries against them gracefully degrade to participantRole).

ALTER TABLE "TicketMessage"
  ADD COLUMN "actorSnapshot" JSONB;
