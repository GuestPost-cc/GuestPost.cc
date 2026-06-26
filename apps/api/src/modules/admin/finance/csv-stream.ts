// Phase 7.1 — RFC 4180 CSV writer for streamed Express responses.
//
// Tiny inline helper instead of pulling in `csv-stringify` — keeps the dep
// tree clean and the rules are short enough to inline correctly:
//
//   - Fields containing comma, quote, or newline must be wrapped in double
//     quotes
//   - Embedded double quotes are doubled (`"` becomes `""`)
//   - Line endings are CRLF per spec
//   - null / undefined → empty cell
//
// `writeRow` writes one row at a time so callers can stream large exports
// without buffering the whole CSV in memory.

import { Response } from "express"
import { RevenueResponse } from "./revenue.service"

const CRLF = "\r\n"
const QUOTE_REQUIRED = /[",\r\n]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const str = typeof value === "string" ? value : String(value)
  if (!QUOTE_REQUIRED.test(str)) return str
  return `"${str.replace(/"/g, '""')}"`
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",") + CRLF
}

/**
 * Stream the revenue response as CSV directly to the Express response.
 * Writes header + bucket rows + TOTAL_CURRENT + (TOTAL_PREVIOUS when present).
 *
 * Header order: bucket,gross_amount,platform_fee,net_revenue,row_count,reversed_count,currency
 */
export function streamRevenueCsv(
  res: Response,
  revenue: RevenueResponse,
  filename: string,
): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
  res.setHeader("Cache-Control", "no-store")

  res.write(
    csvRow([
      "bucket",
      "gross_amount",
      "platform_fee",
      "net_revenue",
      "row_count",
      "reversed_count",
      "currency",
    ]),
  )

  for (const b of revenue.buckets) {
    res.write(
      csvRow([
        b.bucket,
        b.grossAmount,
        b.platformFee,
        b.netRevenue,
        b.rowCount,
        b.reversedCount,
        b.currency,
      ]),
    )
  }

  // Trailer rows so the CSV alone tells the same story as the UI.
  const c = revenue.totals.current
  res.write(
    csvRow([
      "TOTAL_CURRENT",
      c.grossAmount,
      c.platformFee,
      c.netRevenue,
      c.rowCount,
      c.reversedCount,
      c.currency,
    ]),
  )

  if (revenue.totals.previous) {
    const p = revenue.totals.previous
    res.write(
      csvRow([
        "TOTAL_PREVIOUS",
        p.grossAmount,
        p.platformFee,
        p.netRevenue,
        p.rowCount,
        p.reversedCount,
        p.currency,
      ]),
    )
  }

  res.end()
}

export function buildRevenueCsvFilename(opts: {
  from?: string
  to?: string
  groupBy: string
}): string {
  const f = opts.from ?? "all"
  const t = opts.to ?? "all"
  return `revenue-${f}-${t}-by-${opts.groupBy}.csv`
}
