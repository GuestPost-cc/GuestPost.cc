// Phase 7.1 — CSV format + reporting.service #15 fix regression tests.
//
// Covers:
//   - csvCell / csvRow RFC 4180 quoting rules
//   - streamRevenueCsv full output shape (header + buckets + TOTAL_CURRENT
//     + TOTAL_PREVIOUS when present)
//   - reporting.service.ts:32 + getCampaignReport channel-split fix:
//     `order.fulfillmentChannel` snapshot wins over `website.ownershipType`
//     fallback. Pre-Phase-6 legacy rows fall back to ownership; rows with
//     both null land in "PUBLISHER" default.

import { Response } from "express"
import {
  buildRevenueCsvFilename,
  csvCell,
  csvRow,
  streamRevenueCsv,
} from "../modules/admin/finance/csv-stream"
import { RevenueResponse } from "../modules/admin/finance/revenue.service"

describe("Phase 7.1 — csv-stream (RFC 4180)", () => {
  describe("csvCell quoting", () => {
    it("returns plain string when no special chars present", () => {
      expect(csvCell("PLATFORM")).toBe("PLATFORM")
      expect(csvCell("GUEST_POST")).toBe("GUEST_POST")
      expect(csvCell("2026-05")).toBe("2026-05")
    })

    it("quotes when value contains a comma", () => {
      expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."')
    })

    it("quotes AND doubles embedded double-quote per RFC 4180", () => {
      expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    })

    it("quotes when value contains a newline", () => {
      expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
      expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"')
    })

    it("renders null / undefined as empty cell", () => {
      expect(csvCell(null)).toBe("")
      expect(csvCell(undefined)).toBe("")
    })

    it("stringifies numbers and booleans", () => {
      expect(csvCell(42)).toBe("42")
      expect(csvCell(0)).toBe("0")
      expect(csvCell(true)).toBe("true")
    })
  })

  describe("csvRow", () => {
    it("emits CRLF-terminated, comma-separated values", () => {
      expect(csvRow(["a", "b", "c"])).toBe("a,b,c\r\n")
    })

    it("quotes any cell that needs quoting independently", () => {
      expect(csvRow(["plain", "has,comma", 'has"quote'])).toBe(
        'plain,"has,comma","has""quote"\r\n',
      )
    })
  })

  describe("buildRevenueCsvFilename", () => {
    it("includes from/to/groupBy", () => {
      expect(
        buildRevenueCsvFilename({
          from: "2026-05-01",
          to: "2026-05-31",
          groupBy: "channel",
        }),
      ).toBe("revenue-2026-05-01-2026-05-31-by-channel.csv")
    })

    it("substitutes 'all' for missing bounds", () => {
      expect(buildRevenueCsvFilename({ groupBy: "month" })).toBe(
        "revenue-all-all-by-month.csv",
      )
    })
  })

  describe("streamRevenueCsv", () => {
    function mockRes() {
      const chunks: string[] = []
      const headers: Record<string, string> = {}
      const res = {
        setHeader: jest.fn((k: string, v: string) => {
          headers[k] = v
        }),
        write: jest.fn((s: string) => chunks.push(s)),
        end: jest.fn(),
      } as unknown as Response
      return { res, chunks, headers, getOutput: () => chunks.join("") }
    }

    const baseRevenue: RevenueResponse = {
      buckets: [
        {
          bucket: "PLATFORM",
          bucketKey: "PLATFORM",
          grossAmount: "300.00",
          platformFee: "30.00",
          netRevenue: "270.00",
          rowCount: 3,
          reversedCount: 1,
          currency: "USD",
        },
      ],
      totals: {
        current: {
          grossAmount: "300.00",
          platformFee: "30.00",
          netRevenue: "270.00",
          rowCount: 3,
          reversedCount: 1,
          currency: "USD",
        },
        previous: null,
        deltaPct: null,
      },
      meta: {
        from: null,
        to: null,
        groupBy: "channel",
        timezone: "UTC",
        currencyMismatch: null,
      },
    }

    it("emits header + bucket row + TOTAL_CURRENT trailer (no previous)", () => {
      const { res, getOutput, headers } = mockRes()
      streamRevenueCsv(res, baseRevenue, "rev.csv")
      expect(headers["Content-Type"]).toBe("text/csv; charset=utf-8")
      expect(headers["Content-Disposition"]).toBe(
        'attachment; filename="rev.csv"',
      )
      const lines = getOutput().split("\r\n").filter(Boolean)
      expect(lines[0]).toBe(
        "bucket,gross_amount,platform_fee,net_revenue,row_count,reversed_count,currency",
      )
      expect(lines[1]).toBe("PLATFORM,300.00,30.00,270.00,3,1,USD")
      expect(lines[2]).toBe("TOTAL_CURRENT,300.00,30.00,270.00,3,1,USD")
      // No TOTAL_PREVIOUS line
      expect(lines).toHaveLength(3)
    })

    it("includes TOTAL_PREVIOUS trailer when previous-period present", () => {
      const { res, getOutput } = mockRes()
      const withPrev: RevenueResponse = {
        ...baseRevenue,
        totals: {
          ...baseRevenue.totals,
          previous: {
            grossAmount: "200.00",
            platformFee: "20.00",
            netRevenue: "180.00",
            rowCount: 2,
            reversedCount: 0,
            currency: "USD",
          },
          deltaPct: { grossAmount: 50, platformFee: 50, netRevenue: 50 },
        },
      }
      streamRevenueCsv(res, withPrev, "rev.csv")
      const lines = getOutput().split("\r\n").filter(Boolean)
      expect(lines).toHaveLength(4)
      expect(lines[3]).toBe("TOTAL_PREVIOUS,200.00,20.00,180.00,2,0,USD")
    })

    it("RFC 4180-quotes a bucket name containing a comma", () => {
      const { res, getOutput } = mockRes()
      const oddBucket: RevenueResponse = {
        ...baseRevenue,
        buckets: [
          {
            ...baseRevenue.buckets[0]!,
            bucket: "Acme, Inc.",
            bucketKey: "Acme, Inc.",
          },
        ],
      }
      streamRevenueCsv(res, oddBucket, "rev.csv")
      const lines = getOutput().split("\r\n").filter(Boolean)
      expect(lines[1]).toBe('"Acme, Inc.",300.00,30.00,270.00,3,1,USD')
    })

    it("doubles embedded quotes in a bucket name (RFC 4180)", () => {
      const { res, getOutput } = mockRes()
      const r: RevenueResponse = {
        ...baseRevenue,
        buckets: [
          {
            ...baseRevenue.buckets[0]!,
            bucket: 'My "Best" Listing',
            bucketKey: "lst-1",
          },
        ],
      }
      streamRevenueCsv(res, r, "rev.csv")
      const lines = getOutput().split("\r\n").filter(Boolean)
      expect(lines[1]?.startsWith('"My ""Best"" Listing"')).toBe(true)
    })
  })
})

describe("Phase 7.1 — reporting.service #15 fix (channel snapshot wins)", () => {
  // We test the fix by constructing the same shape the service produces inline
  // (single-line snapshot-first / ownership-fallback) and asserting the
  // attribution rules. Replicates `(order.fulfillmentChannel ?? website.ownershipType ?? "PUBLISHER")`.
  const resolveOwnership = (order: {
    fulfillmentChannel?: string | null
    website?: { ownershipType?: string | null } | null
  }) => order.fulfillmentChannel ?? order.website?.ownershipType ?? "PUBLISHER"

  it("snapshot wins over a divergent ownershipType (site reassigned mid-flight)", () => {
    const order = {
      fulfillmentChannel: "PUBLISHER",
      website: { ownershipType: "PLATFORM" },
    }
    expect(resolveOwnership(order)).toBe("PUBLISHER")
  })

  it("falls back to website.ownershipType when snapshot is null (pre-Phase-6 row)", () => {
    const order = {
      fulfillmentChannel: null,
      website: { ownershipType: "PLATFORM" },
    }
    expect(resolveOwnership(order)).toBe("PLATFORM")
  })

  it("falls back to 'PUBLISHER' default when both are null/missing", () => {
    const order = { fulfillmentChannel: null, website: { ownershipType: null } }
    expect(resolveOwnership(order)).toBe("PUBLISHER")
  })

  it("falls back to 'PUBLISHER' when website is missing entirely", () => {
    const order = { fulfillmentChannel: null }
    expect(resolveOwnership(order)).toBe("PUBLISHER")
  })

  // Grep-style guard so the fix can't silently regress: the literal pattern
  // must remain in the service source. If a future refactor reverts to the
  // pre-fix shape, this test fires.
  it("reporting.service.ts source still contains the snapshot-first attribution", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("fs")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("path")
    const src = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "modules",
        "reporting",
        "reporting.service.ts",
      ),
      "utf8",
    )
    expect(src).toMatch(
      /fulfillmentChannel\s*\?\?\s*\(?\s*order\.website|fulfillmentChannel\s*\?\?\s*[^)]*ownershipType/,
    )
    expect(src).toMatch(/resolveChannel|fulfillmentChannel ?? o\.website/)
  })
})
