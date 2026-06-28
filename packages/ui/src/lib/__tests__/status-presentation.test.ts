/**
 * Phase 7.9 #28 — runtime-shape sanity for the status-presentation table.
 *
 * Coverage of "every status key is mapped" is enforced by the
 * `Record<XStatus, StatusPresentation>` types at COMPILE time — missing
 * an entry fails `tsc`, not the spec. This file covers what types
 * can't: the runtime shape of each entry's values.
 */
import { describe, expect, it } from "vitest"
import {
  CAMPAIGN_STATUS_PRESENTATION,
  DISPUTE_STATUS_PRESENTATION,
  getCampaignStatusPresentation,
  getDisputeStatusPresentation,
  getListingStatusPresentation,
  getOrderStatusPresentation,
  getTicketStatusPresentation,
  LISTING_STATUS_PRESENTATION,
  ORDER_STATUS_PRESENTATION,
  type StatusVariant,
  TICKET_STATUS_PRESENTATION,
} from "../status-presentation"

const VALID_VARIANTS: StatusVariant[] = [
  "default",
  "success",
  "warning",
  "destructive",
  "info",
  "pending",
]

const HEX_RE = /^#[0-9a-f]{6}$/i

const ALL_TABLES = {
  order: ORDER_STATUS_PRESENTATION,
  ticket: TICKET_STATUS_PRESENTATION,
  dispute: DISPUTE_STATUS_PRESENTATION,
  listing: LISTING_STATUS_PRESENTATION,
  campaign: CAMPAIGN_STATUS_PRESENTATION,
} as const

describe("status-presentation runtime shape", () => {
  for (const [family, table] of Object.entries(ALL_TABLES)) {
    describe(`${family} family`, () => {
      it("every entry has a valid StatusVariant", () => {
        for (const [_status, p] of Object.entries(table)) {
          expect(VALID_VARIANTS).toContain(p.variant)
        }
      })
      it("every entry has a non-empty label", () => {
        for (const [status, p] of Object.entries(table)) {
          expect(typeof p.label).toBe("string")
          expect(p.label.length).toBeGreaterThan(0)
          // Sanity: label should be the human form, not the raw enum.
          expect(p.label).not.toBe(status)
        }
      })
      it("every entry has a 6-digit hex chartColor", () => {
        for (const [_status, p] of Object.entries(table)) {
          expect(p.chartColor).toMatch(HEX_RE)
        }
      })
    })
  }
})

describe("deliberate cross-family divergence (regression guard)", () => {
  // Ticket OPEN is conversational → blue/info.
  // Dispute OPEN is adversarial → red/destructive.
  // A future contributor "fixing" these to match each other should read
  // the header comment in status-presentation.ts first. This spec
  // catches the change if they don't.
  it("ticket OPEN renders as info (blue)", () => {
    expect(getTicketStatusPresentation("OPEN").variant).toBe("info")
  })
  it("dispute OPEN renders as destructive (red)", () => {
    expect(getDisputeStatusPresentation("OPEN").variant).toBe("destructive")
  })
})

describe("fallback for unrecognised status (defence-in-depth)", () => {
  it("getOrderStatusPresentation falls back to DRAFT", () => {
    const p = getOrderStatusPresentation("__UNKNOWN__" as never)
    expect(p).toBeDefined()
    expect(p.variant).toBe("pending")
    expect(p.label).toBe("Draft")
  })
  it("getTicketStatusPresentation falls back to OPEN", () => {
    const p = getTicketStatusPresentation("__UNKNOWN__" as never)
    expect(p).toBeDefined()
    expect(p.variant).toBe("info")
  })
  it("getDisputeStatusPresentation falls back to OPEN", () => {
    const p = getDisputeStatusPresentation("__UNKNOWN__" as never)
    expect(p).toBeDefined()
    expect(p.variant).toBe("destructive")
  })
  it("getListingStatusPresentation falls back to DRAFT", () => {
    const p = getListingStatusPresentation("__UNKNOWN__" as never)
    expect(p).toBeDefined()
    expect(p.variant).toBe("pending")
  })
  it("getCampaignStatusPresentation falls back to ARCHIVED", () => {
    const p = getCampaignStatusPresentation("__UNKNOWN__" as never)
    expect(p).toBeDefined()
    expect(p.variant).toBe("pending")
  })
})

describe("per-family accessors are typed (compile-time documentation)", () => {
  // The whole point of per-family accessors is that cross-family calls
  // FAIL AT COMPILE TIME. We can't directly test "tsc rejects this", but
  // the positive path documents the contract.
  it("getOrderStatusPresentation accepts an OrderStatus", () => {
    const p = getOrderStatusPresentation("PUBLISHED")
    expect(p.variant).toBe("success")
    expect(p.label).toBe("Published")
  })
  it("getListingStatusPresentation accepts a ListingStatus", () => {
    const p = getListingStatusPresentation("APPROVED")
    expect(p.variant).toBe("success")
    expect(p.label).toBe("Approved")
  })
  it("getCampaignStatusPresentation handles all 4 Prisma values", () => {
    // The roadmap mentioned 2 Campaign states; Prisma actually has 4.
    // Covered here so a future enum addition fails this assertion
    // before reaching production.
    expect(getCampaignStatusPresentation("ACTIVE").variant).toBe("success")
    expect(getCampaignStatusPresentation("PAUSED").variant).toBe("warning")
    expect(getCampaignStatusPresentation("COMPLETED").variant).toBe("success")
    expect(getCampaignStatusPresentation("ARCHIVED").variant).toBe("pending")
  })
})
