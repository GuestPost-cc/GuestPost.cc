// Phase 7.1 — PlatformRevenue aggregation for the admin Finance > Revenue tab.
//
// Reads PlatformRevenue with 4 groupings (channel | month | serviceType |
// listing), computes a same-duration previous-period comparison, and surfaces
// a currency-mismatch warning when any Order in the range was non-USD
// (PlatformRevenue itself has no `currency` column per Phase 0 finding, so
// we check the source Orders).
//
// Invariants:
//   - reversedAt IS NOT NULL rows are excluded from sums but counted as
//     `reversedCount` so Finance sees refunds happened.
//   - NULL snapshot fields collapse into a single "(unknown)" bucket (audit
//     #21 — pre-Phase-6 rows). Never throw, never silently drop.
//   - Decimals are serialized as strings (JSON precision).
//   - `currency` is the constant "USD" in every bucket today. PlatformRevenue
//     has no currency column; Order does. Mismatch detection lives at the
//     Order layer.

import { Prisma } from "@guestpost/database"
import { Injectable, Logger } from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { RevenueGroupBy } from "../dto/get-revenue-query.dto"

const USD = "USD"
const UNKNOWN_BUCKET = "(unknown)"

export interface RevenueBucket {
  bucket: string
  bucketKey: string
  // Populated only when groupBy="listing"
  listingServiceId?: string | null
  listingId?: string | null
  listingTitle?: string | null
  grossAmount: string
  platformFee: string
  netRevenue: string
  rowCount: number
  reversedCount: number
  currency: string
}

export interface RevenueTotalsSlice {
  grossAmount: string
  platformFee: string
  netRevenue: string
  rowCount: number
  reversedCount: number
  currency: string
}

export interface RevenueDeltaPct {
  grossAmount: number
  platformFee: number
  netRevenue: number
}

export interface RevenueCurrencyMismatch {
  rowCount: number
  distinctCurrencies: string[]
}

export interface RevenueResponse {
  buckets: RevenueBucket[]
  totals: {
    current: RevenueTotalsSlice
    previous: RevenueTotalsSlice | null
    deltaPct: RevenueDeltaPct | null
  }
  meta: {
    from: string | null
    to: string | null
    groupBy: RevenueGroupBy
    timezone: "UTC"
    currencyMismatch: RevenueCurrencyMismatch | null
  }
}

interface ResolvedRange {
  from: Date | null
  to: Date | null
  durationMs: number | null
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date string: ${value}`)
  }
  return d
}

function resolveRange(
  from: string | undefined,
  to: string | undefined,
): ResolvedRange {
  const f = parseDate(from)
  const t = parseDate(to)
  if (f && t && t.getTime() < f.getTime()) {
    throw new Error("`to` must be on or after `from`")
  }
  const durationMs = f && t ? t.getTime() - f.getTime() : null
  return { from: f, to: t, durationMs }
}

function rangeFilter(
  range: ResolvedRange,
): Prisma.PlatformRevenueWhereInput["recordedAt"] | undefined {
  if (!range.from && !range.to) return undefined
  const f: { gte?: Date; lte?: Date } = {}
  if (range.from) f.gte = range.from
  if (range.to) f.lte = range.to
  return f
}

function _zeroTotals(): RevenueTotalsSlice {
  return {
    grossAmount: "0",
    platformFee: "0",
    netRevenue: "0",
    rowCount: 0,
    reversedCount: 0,
    currency: USD,
  }
}

// Add a Decimal-like serialized as string. Both inputs and output are strings
// representing money to 2 dp. We avoid JS Number arithmetic to preserve
// precision; instead, do exact integer arithmetic on "cents" (×100).
function addMoney(a: string, b: string): string {
  const aCents = Math.round(Number(a) * 100)
  const bCents = Math.round(Number(b) * 100)
  return ((aCents + bCents) / 100).toFixed(2)
}

function toMoneyString(
  v: Prisma.Decimal | string | number | null | undefined,
): string {
  if (v === null || v === undefined) return "0.00"
  // Prisma.Decimal has toFixed(); plain numbers/strings go through Number first.
  if (typeof v === "object" && "toFixed" in v)
    return (v as { toFixed: (n: number) => string }).toFixed(2)
  return Number(v).toFixed(2)
}

function deltaPct(currentStr: string, previousStr: string): number {
  const c = Number(currentStr)
  const p = Number(previousStr)
  if (p === 0) return 0 // caller decides whether to expose `null` for whole deltaPct object
  return ((c - p) / p) * 100
}

@Injectable()
export class RevenueService {
  private readonly logger = new Logger(RevenueService.name)

  constructor(private readonly prisma: PrismaService) {}

  async getRevenue(input: {
    from?: string
    to?: string
    groupBy: RevenueGroupBy
  }): Promise<RevenueResponse> {
    const range = resolveRange(input.from, input.to)

    this.logger.log("revenue query", {
      groupBy: input.groupBy,
      from: range.from?.toISOString() ?? null,
      to: range.to?.toISOString() ?? null,
    })

    // Run aggregation + current totals + previous totals + currency check in parallel.
    // Each is index-bounded on (recordedAt) or (recordedAt, fulfillmentChannel|serviceType|listingServiceId).
    const previousRange: ResolvedRange =
      range.from && range.to && range.durationMs !== null
        ? {
            from: new Date(range.from.getTime() - range.durationMs),
            to: range.from,
            durationMs: range.durationMs,
          }
        : { from: null, to: null, durationMs: null }

    const [buckets, currentTotals, previousTotals, currencyMismatch] =
      await Promise.all([
        this.aggregateBuckets(range, input.groupBy),
        this.aggregateTotals(range),
        previousRange.from
          ? this.aggregateTotals(previousRange)
          : Promise.resolve(null),
        this.detectCurrencyMismatch(range),
      ])

    this.logger.log("revenue result", {
      groupBy: input.groupBy,
      bucketCount: buckets.length,
      currentGross: currentTotals.grossAmount,
      hasPrevious: previousTotals !== null,
      currencyMismatch: currencyMismatch?.distinctCurrencies ?? null,
    })

    const totalsSlice: {
      current: RevenueTotalsSlice
      previous: RevenueTotalsSlice | null
      deltaPct: RevenueDeltaPct | null
    } = {
      current: currentTotals,
      previous: previousTotals,
      deltaPct: null,
    }

    if (previousTotals) {
      const prevGross = Number(previousTotals.grossAmount)
      // Hide deltaPct when previous gross is zero — avoids "+∞%" / "NaN%".
      if (prevGross !== 0) {
        totalsSlice.deltaPct = {
          grossAmount: deltaPct(
            currentTotals.grossAmount,
            previousTotals.grossAmount,
          ),
          platformFee: deltaPct(
            currentTotals.platformFee,
            previousTotals.platformFee,
          ),
          netRevenue: deltaPct(
            currentTotals.netRevenue,
            previousTotals.netRevenue,
          ),
        }
      }
    }

    return {
      buckets,
      totals: totalsSlice,
      meta: {
        from: input.from ?? null,
        to: input.to ?? null,
        groupBy: input.groupBy,
        timezone: "UTC",
        currencyMismatch,
      },
    }
  }

  // ── Buckets ──────────────────────────────────────────────────────────────

  private async aggregateBuckets(
    range: ResolvedRange,
    groupBy: RevenueGroupBy,
  ): Promise<RevenueBucket[]> {
    const recordedAt = rangeFilter(range)
    const baseWhere: Prisma.PlatformRevenueWhereInput = recordedAt
      ? { recordedAt }
      : {}

    if (groupBy === "channel") {
      return this.groupBySingleField(baseWhere, "fulfillmentChannel")
    }
    if (groupBy === "serviceType") {
      return this.groupBySingleField(baseWhere, "serviceType")
    }
    if (groupBy === "listing") {
      return this.groupByListing(baseWhere)
    }
    // month — Prisma groupBy doesn't support date_trunc; use $queryRaw for the
    // month bucket and then run separate aggregates per bucket. Cheap because
    // the count of distinct months is small (typically ≤ 36 even for years).
    return this.groupByMonth(baseWhere, range)
  }

  private async groupBySingleField(
    baseWhere: Prisma.PlatformRevenueWhereInput,
    field: "fulfillmentChannel" | "serviceType",
  ): Promise<RevenueBucket[]> {
    // Sum non-reversed + count
    const nonReversedSums = await (
      this.prisma as unknown as {
        platformRevenue: {
          groupBy: (args: unknown) => Promise<
            Array<{
              fulfillmentChannel?: string | null
              serviceType?: string | null
              _sum: {
                amount: Prisma.Decimal | null
                platformFee: Prisma.Decimal | null
                netRevenue: Prisma.Decimal | null
              }
              _count: { _all: number }
            }>
          >
        }
      }
    ).platformRevenue.groupBy({
      by: [field],
      where: { ...baseWhere, reversedAt: null },
      _sum: { amount: true, platformFee: true, netRevenue: true },
      _count: { _all: true },
    })

    // Count reversed separately (we never sum reversed rows into gross/fee/net)
    const reversedCounts = await (
      this.prisma as unknown as {
        platformRevenue: {
          groupBy: (args: unknown) => Promise<
            Array<{
              fulfillmentChannel?: string | null
              serviceType?: string | null
              _count: { _all: number }
            }>
          >
        }
      }
    ).platformRevenue.groupBy({
      by: [field],
      where: { ...baseWhere, reversedAt: { not: null } },
      _count: { _all: true },
    })

    const reversedMap = new Map<string, number>()
    for (const r of reversedCounts) {
      const key = String(
        (r as Record<string, unknown>)[field] ?? UNKNOWN_BUCKET,
      )
      reversedMap.set(key, r._count._all)
    }

    const buckets: RevenueBucket[] = nonReversedSums.map((row) => {
      const rawKey = (row as Record<string, unknown>)[field]
      const bucketKey = rawKey == null ? UNKNOWN_BUCKET : String(rawKey)
      return {
        bucket: bucketKey,
        bucketKey,
        grossAmount: toMoneyString(row._sum.amount),
        platformFee: toMoneyString(row._sum.platformFee),
        netRevenue: toMoneyString(row._sum.netRevenue),
        rowCount: row._count._all,
        reversedCount: reversedMap.get(bucketKey) ?? 0,
        currency: USD,
      }
    })

    // Fold any reversed-only buckets (no non-reversed rows) so they're not lost.
    for (const [key, count] of reversedMap.entries()) {
      if (!buckets.find((b) => b.bucketKey === key)) {
        buckets.push({
          bucket: key,
          bucketKey: key,
          grossAmount: "0.00",
          platformFee: "0.00",
          netRevenue: "0.00",
          rowCount: 0,
          reversedCount: count,
          currency: USD,
        })
      }
    }

    buckets.sort((a, b) =>
      a.bucketKey < b.bucketKey ? -1 : a.bucketKey > b.bucketKey ? 1 : 0,
    )
    return buckets
  }

  private async groupByMonth(
    baseWhere: Prisma.PlatformRevenueWhereInput,
    range: ResolvedRange,
  ): Promise<RevenueBucket[]> {
    // Build a parameterized query that returns sums per UTC month.
    // Using raw SQL because Prisma groupBy doesn't support date_trunc.
    // Uses clauses[] + params[] accumulation pattern (not brittle $1/$2 ternary arithmetic).
    const clauses: string[] = []
    const params: unknown[] = []
    let paramIndex = 0

    if (range.from) {
      paramIndex++
      clauses.push(`"recordedAt" >= $${paramIndex}::timestamptz`)
      params.push(range.from)
    }
    if (range.to) {
      paramIndex++
      clauses.push(`"recordedAt" <= $${paramIndex}::timestamptz`)
      params.push(range.to)
    }

    const whereClause =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""

    type MonthRow = {
      month: Date
      gross: Prisma.Decimal | null
      fee: Prisma.Decimal | null
      net: Prisma.Decimal | null
      row_count: bigint
      reversed_count: bigint
    }
    const sql = `
      SELECT
        date_trunc('month', "recordedAt" AT TIME ZONE 'UTC') AS month,
        SUM(CASE WHEN "reversedAt" IS NULL THEN "amount" ELSE 0 END) AS gross,
        SUM(CASE WHEN "reversedAt" IS NULL THEN "platformFee" ELSE 0 END) AS fee,
        SUM(CASE WHEN "reversedAt" IS NULL THEN "netRevenue" ELSE 0 END) AS net,
        COUNT(*) FILTER (WHERE "reversedAt" IS NULL) AS row_count,
        COUNT(*) FILTER (WHERE "reversedAt" IS NOT NULL) AS reversed_count
      FROM "PlatformRevenue"
      ${whereClause}
      GROUP BY date_trunc('month', "recordedAt" AT TIME ZONE 'UTC')
      ORDER BY month ASC
    `
    const rows = await this.prisma.$queryRawUnsafe<MonthRow[]>(sql, ...params)

    return rows.map((r) => {
      const monthIso = r.month.toISOString()
      const ymd = monthIso.slice(0, 10) // YYYY-MM-01
      const label = ymd.slice(0, 7) // YYYY-MM
      void baseWhere // kept for signature symmetry — month path goes through raw SQL
      return {
        bucket: label,
        bucketKey: ymd,
        grossAmount: toMoneyString(r.gross),
        platformFee: toMoneyString(r.fee),
        netRevenue: toMoneyString(r.net),
        rowCount: Number(r.row_count),
        reversedCount: Number(r.reversed_count),
        currency: USD,
      }
    })
  }

  private async groupByListing(
    baseWhere: Prisma.PlatformRevenueWhereInput,
  ): Promise<RevenueBucket[]> {
    type Row = {
      listingServiceId: string | null
      _sum: {
        amount: Prisma.Decimal | null
        platformFee: Prisma.Decimal | null
        netRevenue: Prisma.Decimal | null
      }
      _count: { _all: number }
    }

    const nonReversedSums = (await (
      this.prisma as unknown as {
        platformRevenue: {
          groupBy: (args: unknown) => Promise<Row[]>
        }
      }
    ).platformRevenue.groupBy({
      by: ["listingServiceId"],
      where: { ...baseWhere, reversedAt: null },
      _sum: { amount: true, platformFee: true, netRevenue: true },
      _count: { _all: true },
    })) as Row[]

    const reversedCounts = (await (
      this.prisma as unknown as {
        platformRevenue: {
          groupBy: (
            args: unknown,
          ) => Promise<
            Array<{ listingServiceId: string | null; _count: { _all: number } }>
          >
        }
      }
    ).platformRevenue.groupBy({
      by: ["listingServiceId"],
      where: { ...baseWhere, reversedAt: { not: null } },
      _count: { _all: true },
    })) as Array<{ listingServiceId: string | null; _count: { _all: number } }>

    const reversedMap = new Map<string, number>()
    for (const r of reversedCounts) {
      reversedMap.set(r.listingServiceId ?? UNKNOWN_BUCKET, r._count._all)
    }

    // Resolve listing titles + parent listing IDs via a single follow-up query.
    const ids = nonReversedSums
      .map((r) => r.listingServiceId)
      .filter((v): v is string => v !== null)
      .concat(
        reversedCounts
          .map((r) => r.listingServiceId)
          .filter((v): v is string => v !== null),
      )
    const distinctIds = Array.from(new Set(ids))
    const listingServiceRows = distinctIds.length
      ? await this.prisma.listingService.findMany({
          where: { id: { in: distinctIds } },
          select: {
            id: true,
            listingId: true,
            listing: { select: { title: true } },
          },
        })
      : []
    const lsLookup = new Map<
      string,
      { listingId: string; listingTitle: string | null }
    >()
    for (const ls of listingServiceRows) {
      lsLookup.set(ls.id, {
        listingId: ls.listingId,
        listingTitle: ls.listing?.title ?? null,
      })
    }

    const out: RevenueBucket[] = []
    const seen = new Set<string>()

    for (const row of nonReversedSums) {
      const lsId = row.listingServiceId
      const bucketKey = lsId ?? UNKNOWN_BUCKET
      seen.add(bucketKey)
      const meta = lsId ? lsLookup.get(lsId) : undefined
      const title = meta?.listingTitle ?? null
      out.push({
        bucket:
          lsId == null ? UNKNOWN_BUCKET : (title ?? "(listing not found)"),
        bucketKey,
        listingServiceId: lsId,
        listingId: meta?.listingId ?? null,
        listingTitle: title,
        grossAmount: toMoneyString(row._sum.amount),
        platformFee: toMoneyString(row._sum.platformFee),
        netRevenue: toMoneyString(row._sum.netRevenue),
        rowCount: row._count._all,
        reversedCount: reversedMap.get(bucketKey) ?? 0,
        currency: USD,
      })
    }

    // Fold reversed-only buckets so they're not lost.
    for (const [key, count] of reversedMap.entries()) {
      if (seen.has(key)) continue
      const lsId = key === UNKNOWN_BUCKET ? null : key
      const meta = lsId ? lsLookup.get(lsId) : undefined
      const title = meta?.listingTitle ?? null
      out.push({
        bucket:
          lsId == null ? UNKNOWN_BUCKET : (title ?? "(listing not found)"),
        bucketKey: key,
        listingServiceId: lsId,
        listingId: meta?.listingId ?? null,
        listingTitle: title,
        grossAmount: "0.00",
        platformFee: "0.00",
        netRevenue: "0.00",
        rowCount: 0,
        reversedCount: count,
        currency: USD,
      })
    }

    // Sort by net revenue DESC (top earners first), unknown bucket last.
    out.sort((a, b) => {
      if (a.bucketKey === UNKNOWN_BUCKET) return 1
      if (b.bucketKey === UNKNOWN_BUCKET) return -1
      const diff = Number(b.netRevenue) - Number(a.netRevenue)
      if (diff !== 0) return diff
      return a.bucketKey < b.bucketKey ? -1 : 1
    })

    return out
  }

  // ── Totals (current + previous window) ───────────────────────────────────

  private async aggregateTotals(
    range: ResolvedRange,
  ): Promise<RevenueTotalsSlice> {
    const recordedAt = rangeFilter(range)
    const baseWhere: Prisma.PlatformRevenueWhereInput = recordedAt
      ? { recordedAt }
      : {}

    const [nonReversed, reversed] = await Promise.all([
      this.prisma.platformRevenue.aggregate({
        where: { ...baseWhere, reversedAt: null },
        _sum: { amount: true, platformFee: true, netRevenue: true },
        _count: { _all: true },
      }),
      this.prisma.platformRevenue.count({
        where: { ...baseWhere, reversedAt: { not: null } },
      }),
    ])

    return {
      grossAmount: toMoneyString(nonReversed._sum.amount),
      platformFee: toMoneyString(nonReversed._sum.platformFee),
      netRevenue: toMoneyString(nonReversed._sum.netRevenue),
      rowCount: nonReversed._count._all,
      reversedCount: reversed,
      currency: USD,
    }
  }

  // ── Currency mismatch (queries Order, not PlatformRevenue) ──────────────

  private async detectCurrencyMismatch(
    range: ResolvedRange,
  ): Promise<RevenueCurrencyMismatch | null> {
    // Phase 0 finding: PlatformRevenue has no `currency` column. We check
    // the source Orders for non-USD currency in the same date window. The
    // mapping is "Orders that contributed revenue in this range" — which
    // for the dashboard's purposes is "Orders that were delivered/refunded
    // in this range."
    const where: Prisma.OrderWhereInput = {
      currency: { not: USD },
      status: { in: ["DELIVERED", "COMPLETED", "REFUNDED"] },
    }
    if (range.from || range.to) {
      where.deliveredAt = {}
      if (range.from)
        (where.deliveredAt as { gte?: Date; lte?: Date }).gte = range.from
      if (range.to)
        (where.deliveredAt as { gte?: Date; lte?: Date }).lte = range.to
    }

    const distinctRows = await this.prisma.order.findMany({
      where,
      select: { currency: true },
      distinct: ["currency"],
    })
    if (distinctRows.length === 0) return null

    const rowCount = await this.prisma.order.count({ where })
    const distinctCurrencies = distinctRows.map((r) => r.currency).sort()
    this.logger.warn("non-USD currency detected in revenue range", {
      distinctCurrencies,
      rowCount,
    })
    return {
      rowCount,
      distinctCurrencies,
    }
  }
}

// Exported for tests
export const __internals = {
  addMoney,
  deltaPct,
  parseDate,
  resolveRange,
  toMoneyString,
  UNKNOWN_BUCKET,
  USD,
}
