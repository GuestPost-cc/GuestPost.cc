-- Phase 6.6: ticket message visibility (PUBLIC | INTERNAL)
--
-- Adds a `visibility` column on TicketMessage so staff can post internal
-- notes that are invisible to the ticket's customer + publisher. Combined
-- with the channel-aware reply matrix enforced server-side, this lets
-- Finance (read-only on PLATFORM tickets) flag concerns to Admin/Ops
-- without writing to the customer-facing thread.
--
-- Additive only: default = 'PUBLIC' so every existing row keeps its
-- historical semantic without a data migration.

CREATE TYPE "TicketMessageVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

ALTER TABLE "TicketMessage"
  ADD COLUMN "visibility" "TicketMessageVisibility" NOT NULL DEFAULT 'PUBLIC';

CREATE INDEX "TicketMessage_ticketId_visibility_idx"
  ON "TicketMessage"("ticketId", "visibility");
