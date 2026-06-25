// Phase 6 backfill — fills the five reporting snapshot columns on
// historical Settlement and PlatformRevenue rows by joining to the source
// Order. Idempotent: only touches rows where the snapshot is still NULL.
//
// Safe to re-run any time. Run after the Phase 6 additive migration lands.
// Run: pnpm tsx scripts/backfill-settlement-snapshots.ts [--dry-run]

import { resolve } from "node:path"
import { config } from "dotenv"

config({ path: resolve(__dirname, "../.env.development") })

import { prisma } from "@guestpost/database"

const DRY_RUN = process.argv.includes("--dry-run")

async function backfillSettlements() {
  const rows = await prisma.settlement.findMany({
    where: { listingServiceId: null },
    select: {
      id: true,
      orderId: true,
      order: {
        select: {
          listingServiceId: true,
          type: true,
          fulfillmentChannel: true,
          website: { select: { ownershipType: true } },
        },
      },
    },
  })

  console.log(
    `Settlement: ${rows.length} rows missing snapshot${DRY_RUN ? " [DRY RUN]" : ""}`,
  )

  let updated = 0,
    skipped = 0
  for (const r of rows) {
    const lsId = r.order?.listingServiceId ?? null
    const channel = r.order?.fulfillmentChannel ?? null
    const ownerType = r.order?.website?.ownershipType ?? null
    const serviceType = r.order?.type ?? null

    // unitPrice has to come from the live ListingService row. If the order's
    // service has since been deleted (FK is SET NULL via the row itself) we
    // leave unitPrice NULL — reports degrade gracefully.
    let unitPrice: any = null
    if (lsId) {
      const ls = await prisma.listingService.findUnique({
        where: { id: lsId },
        select: { price: true },
      })
      unitPrice = ls?.price ?? null
    }

    if (!lsId && !channel && !ownerType && !serviceType && !unitPrice) {
      skipped++
      continue
    }

    if (!DRY_RUN) {
      await prisma.settlement.update({
        where: { id: r.id },
        data: {
          listingServiceId: lsId,
          serviceType,
          ownerType,
          fulfillmentChannel: channel,
          unitPrice,
        },
      })
    }
    updated++
  }
  console.log(`Settlement: updated=${updated} skipped=${skipped}`)
}

async function backfillPlatformRevenue() {
  const rows = await prisma.platformRevenue.findMany({
    where: { listingServiceId: null },
    select: {
      id: true,
      orderId: true,
      order: {
        select: {
          listingServiceId: true,
          type: true,
          fulfillmentChannel: true,
          website: { select: { ownershipType: true } },
        },
      },
    },
  })

  console.log(
    `PlatformRevenue: ${rows.length} rows missing snapshot${DRY_RUN ? " [DRY RUN]" : ""}`,
  )

  let updated = 0,
    skipped = 0
  for (const r of rows) {
    const lsId = r.order?.listingServiceId ?? null
    const channel = r.order?.fulfillmentChannel ?? null
    const ownerType = r.order?.website?.ownershipType ?? null
    const serviceType = r.order?.type ?? null

    let unitPrice: any = null
    if (lsId) {
      const ls = await prisma.listingService.findUnique({
        where: { id: lsId },
        select: { price: true },
      })
      unitPrice = ls?.price ?? null
    }

    if (!lsId && !channel && !ownerType && !serviceType && !unitPrice) {
      skipped++
      continue
    }

    if (!DRY_RUN) {
      await prisma.platformRevenue.update({
        where: { id: r.id },
        data: {
          listingServiceId: lsId,
          serviceType,
          ownerType,
          fulfillmentChannel: channel,
          unitPrice,
        },
      })
    }
    updated++
  }
  console.log(`PlatformRevenue: updated=${updated} skipped=${skipped}`)
}

async function main() {
  await backfillSettlements()
  await backfillPlatformRevenue()
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
