// Phase 2 → Phase 4 bridge. Populates the new Order snapshot columns
// (fulfillmentChannel, listingId, listingServiceId, turnaroundDays) for
// orders created before the snapshot existed.
//
// Strategy per legacy order:
//   1. fulfillmentChannel: read from website.ownershipType (PLATFORM ↔
//      PLATFORM, else PUBLISHER). This is non-ambiguous — every order with a
//      websiteId can be channel-classified.
//   2. listingId / listingServiceId: look up the website's APPROVED listing
//      and the ListingService row for the order's serviceType. If either is
//      missing the order keeps NULL — Phase 4 will treat NULL as "legacy
//      order, no snapshot". Doesn't abort the run.
//   3. turnaroundDays: copied from the resolved ListingService if any.
//
// Idempotent — only updates rows where the target column is still NULL.
// Safe to re-run any time.
//
// Run: pnpm tsx scripts/backfill-order-listing-snapshot.ts [--dry-run]

import { config } from "dotenv"
import { resolve } from "path"
// Load the same env file the API uses so DATABASE_URL is available when this
// script is invoked from the repo root.
config({ path: resolve(__dirname, "../.env.development") })

import { prisma } from "@guestpost/database"

const DRY_RUN = process.argv.includes("--dry-run")

async function backfill() {
  // Pull every order missing the channel snapshot. We don't filter on the
  // other columns because all four must agree per order — we always
  // recompute them as a unit.
  const orders = await prisma.order.findMany({
    where: { fulfillmentChannel: null },
    select: {
      id: true,
      type: true,
      websiteId: true,
      website: { select: { id: true, ownershipType: true } },
    },
  })

  console.log(`Found ${orders.length} orders without fulfillmentChannel snapshot${DRY_RUN ? " [DRY RUN]" : ""}`)

  let channelOnly = 0      // orders we could classify but couldn't resolve a service for
  let fullSnapshot = 0     // orders we fully snapshotted
  let skipped = 0          // orders with no website — nothing to snapshot
  let errors = 0

  for (const order of orders) {
    try {
      if (!order.website) {
        skipped++
        continue
      }
      const channel = order.website.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER"

      // Find the matching listing + service. Both nullable on this side —
      // a publisher may have deleted their listing, etc.
      let listingId: string | null = null
      let listingServiceId: string | null = null
      let turnaroundDays: number | null = null

      const listing = await prisma.marketplaceListing.findFirst({
        where: { websiteId: order.website.id, status: "APPROVED" },
        select: { id: true },
      })
      if (listing) {
        listingId = listing.id
        const ls = await prisma.listingService.findUnique({
          where: { listingId_serviceType: { listingId: listing.id, serviceType: order.type } },
          select: { id: true, turnaroundDays: true },
        })
        if (ls) {
          listingServiceId = ls.id
          turnaroundDays = ls.turnaroundDays
        }
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] order=${order.id} channel=${channel} listing=${listingId ?? "—"} service=${listingServiceId ?? "—"} TAT=${turnaroundDays ?? "—"}`)
      } else {
        await prisma.order.update({
          where: { id: order.id },
          data: { fulfillmentChannel: channel, listingId, listingServiceId, turnaroundDays },
        })
      }

      if (listingServiceId) fullSnapshot++
      else channelOnly++
    } catch (err) {
      errors++
      console.error(`  ERROR on order=${order.id}: ${(err as Error).message}`)
    }
  }

  console.log("")
  console.log("Backfill complete:")
  console.log(`  Fully snapshotted (channel + listing + service): ${fullSnapshot}`)
  console.log(`  Channel only (no matching ListingService):       ${channelOnly}`)
  console.log(`  Skipped (no website on order):                   ${skipped}`)
  console.log(`  Errors:                                          ${errors}`)
}

backfill()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
