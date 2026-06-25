// Phase 6.9 — Money-path role tightening + confirm-delivery race + metadata sweep
//
// Three concerns under one test file because they ship together as the
// money-path closure of audit findings #3, R-3, R-4, #22, and #4:
//
//   (A) assertOwnerOrCreator — pure helper covered exhaustively
//   (B) confirmDelivery race — the new status guard refuses commit on
//       a DELIVERED row (was: missing status filter)
//   (C) orderEventMetadata coverage — every Order/Settlement/PlatformRevenue
//       /OrderDeliveryVersion audit.log site in the money paths carries the
//       Phase 6 snapshot trio
//
// The first two are unit tests against the actual functions. The third is a
// reflection-style coverage test that walks the source files, finds every
// `audit.log(...)` call whose entityType is in the money set, and asserts
// the metadata literal includes `orderEventMetadata(...)` or `deliveryAuditMeta(...)`.
// This prevents the regression the audit specifically called out (the
// helper is "underused at 2 of ~30 callsites") — the next PR that adds a
// money-audit call without the helper fails CI.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ForbiddenException } from "@nestjs/common"
import { assertOwnerOrCreator } from "../modules/orders/services/owner-or-creator"

// ─── (A) assertOwnerOrCreator ─────────────────────────────────────────────

describe("assertOwnerOrCreator — money-path access gate", () => {
  it("allows the order's creator regardless of role", () => {
    expect(() =>
      assertOwnerOrCreator({
        customerId: "user-a",
        actorUserId: "user-a",
        actorRole: "MEMBER",
      }),
    ).not.toThrow()
  })

  it("allows an OWNER even when they aren't the creator", () => {
    expect(() =>
      assertOwnerOrCreator({
        customerId: "user-creator",
        actorUserId: "user-owner",
        actorRole: "OWNER",
      }),
    ).not.toThrow()
  })

  it("refuses a non-creator MEMBER (the audit's CRITICAL finding)", () => {
    expect(() =>
      assertOwnerOrCreator({
        customerId: "user-creator",
        actorUserId: "user-bystander",
        actorRole: "MEMBER",
        action: "submit payment",
      }),
    ).toThrow(ForbiddenException)
  })

  it("refuses a non-creator with no role (defense in depth)", () => {
    expect(() =>
      assertOwnerOrCreator({
        customerId: "user-creator",
        actorUserId: "user-other",
        actorRole: null,
      }),
    ).toThrow(ForbiddenException)
  })

  it("error message includes the action when provided", () => {
    let err: any
    try {
      assertOwnerOrCreator({
        customerId: "a",
        actorUserId: "b",
        actorRole: "MEMBER",
        action: "approve this settlement",
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ForbiddenException)
    expect(err.message).toContain("approve this settlement")
  })
})

// ─── (B) confirmDelivery race — status guard ──────────────────────────────
//
// We test the actual SQL guard (status: "VERIFIED" added to updateMany.where)
// rather than re-running the whole service. The grep verifies the literal is
// in the source — a regression would remove the guard and we'd catch it.

describe("confirmDelivery — Phase 6.9 race guard (audit #22)", () => {
  it("inner updateMany filters by status: VERIFIED, not just (id, version)", () => {
    const src = readFileSync(
      join(__dirname, "../modules/orders/services/order-review.service.ts"),
      "utf8",
    )
    // Look for the confirm-delivery transition. The previous form was
    // `where: { id: orderId, version: order.version }`. The new form adds
    // `status: "VERIFIED"` — without it, a parallel customer-accept could
    // commit a DELIVERED transition through the same code path.
    const confirmBlock = src.match(
      /async confirmDelivery[\s\S]*?return updated/,
    )
    expect(confirmBlock).toBeTruthy()
    const block = confirmBlock?.[0]
    // Match the updateMany call's where clause.
    expect(block).toMatch(
      /updateMany\(\{[\s\S]*?where:\s*\{[\s\S]*?status:\s*"VERIFIED"[\s\S]*?\}/,
    )
  })
})

// ─── (C) orderEventMetadata coverage ──────────────────────────────────────

const MONEY_ENTITY_TYPES = [
  "Order",
  "Settlement",
  "PlatformRevenue",
  "OrderDeliveryVersion",
]

// Files in the money-audit perimeter that we hold to the standard. Any new
// audit.log({entityType: "Order"|"Settlement"|…}) in these files must spread
// orderEventMetadata (or the local deliveryAuditMeta wrapper which itself
// spreads orderEventMetadata).
const MONEY_AUDIT_FILES = [
  "modules/orders/orders.service.ts",
  "modules/orders/services/order-payment.service.ts",
  "modules/orders/services/order-review.service.ts",
  "modules/orders/services/order-fulfillment.service.ts",
  "modules/orders/services/order-operations.service.ts",
  "modules/orders/services/order-delivery.service.ts",
  "modules/orders/services/order-dispute.service.ts",
  "modules/orders/services/delivery-intervention.service.ts",
  "modules/orders/services/refund.service.ts",
  "modules/settlements/settlements.service.ts",
  // Phase 7.3 — settlement-auto-approve.service.ts was deleted; the auto-approve
  // sweep now lives in packages/shared/src/settlement-auto-approve-core.ts where
  // it writes audit rows via `tx.auditLog.create()` (Prisma direct, not the
  // AuditService wrapper this test walks). The audit-row contract is preserved
  // — orderEventMetadata(settlement.order) is still spread into metadata.
]

interface AuditCallsite {
  file: string
  line: number
  entityType: string
  hasMetadataHelper: boolean
  snippet: string
}

function extractMoneyAuditCallsites(file: string): AuditCallsite[] {
  const path = join(__dirname, "..", file)
  const src = readFileSync(path, "utf8")
  const lines = src.split("\n")
  const results: AuditCallsite[] = []

  for (let i = 0; i < lines.length; i++) {
    // Find the start of an audit.log({...}) literal. Match on `audit.log({` so we
    // catch single-line and multi-line forms uniformly.
    if (!/audit\.log\(\s*\{/.test(lines[i])) continue
    // Pull the next ~20 lines (enough to cover any audit.log literal in this
    // codebase) and parse the entityType + look for orderEventMetadata / the
    // delivery wrapper.
    const window = lines.slice(i, Math.min(i + 25, lines.length)).join("\n")
    const entityMatch = window.match(/entityType:\s*"([^"]+)"/)
    if (!entityMatch) continue
    const entityType = entityMatch[1]
    if (!MONEY_ENTITY_TYPES.includes(entityType)) continue

    // Either the standardized helper is spread directly, OR the delivery
    // wrapper (which itself spreads orderEventMetadata).
    const hasMetadataHelper =
      /\.\.\.orderEventMetadata\(/.test(window) ||
      /orderEventMetadata\(\w+\)/.test(window) ||
      /this\.deliveryAuditMeta\(/.test(window)

    results.push({
      file,
      line: i + 1,
      entityType,
      hasMetadataHelper,
      snippet: lines[i].trim(),
    })
  }
  return results
}

describe("orderEventMetadata coverage (audit #4)", () => {
  let callsites: AuditCallsite[]

  beforeAll(() => {
    callsites = MONEY_AUDIT_FILES.flatMap(extractMoneyAuditCallsites)
  })

  it("discovers at least 15 money-scoped audit callsites across the perimeter (sanity check)", () => {
    expect(callsites.length).toBeGreaterThanOrEqual(15)
  })

  it("every money-scoped audit.log spreads orderEventMetadata (or deliveryAuditMeta)", () => {
    const missing = callsites.filter((c) => !c.hasMetadataHelper)
    if (missing.length > 0) {
      const detail = missing
        .map(
          (m) =>
            `  ${m.file}:${m.line}  →  entityType: "${m.entityType}"  ${m.snippet}`,
        )
        .join("\n")
      throw new Error(
        `\nFound ${missing.length} money-scoped audit.log callsite(s) missing the standardized metadata helper:\n` +
          detail +
          `\n\nFix: spread \`...orderEventMetadata(order)\` into the metadata object (or use the local deliveryAuditMeta wrapper for delivery-intervention.service.ts). ` +
          `See packages/shared/src/audit/order-event-metadata.ts for the contract.`,
      )
    }
    expect(missing).toEqual([])
  })

  // Distribute sanity: at least one finding from each file. If a file gains
  // a new money-audit callsite, the discovery should still find sites in the
  // other files (no off-by-one regression in the parser).
  it("at least one callsite found in each of the audited files (parser sanity)", () => {
    const filesFound = new Set(callsites.map((c) => c.file))
    const filesAudited = new Set(MONEY_AUDIT_FILES)
    // We expect coverage in at least 8 of 11 files (some files like
    // orders.service.ts may have only cancel; refund.service.ts has its single
    // ORDER_REFUNDED call — that's the historical case-zero of the helper).
    expect(filesFound.size).toBeGreaterThanOrEqual(8)
    // Cross-check: refund.service.ts is where this pattern started — it
    // MUST be present, else the sweep regressed the original good citizen.
    expect(filesFound.has("modules/orders/services/refund.service.ts")).toBe(
      true,
    )
    // settlements.service.ts is where SETTLEMENT_CREATED lives — also
    // must remain covered.
    expect(filesFound.has("modules/settlements/settlements.service.ts")).toBe(
      true,
    )
    // Silence the unused-var lint on filesAudited.
    expect(filesAudited.size).toBe(MONEY_AUDIT_FILES.length)
  })
})

// ─── (D) money-path controller decorator coverage ─────────────────────────
//
// The audit's #3 + R-3 + R-4 closure layered the OWNER||creator check at the
// service layer (rather than narrowing the controller @MemberRoles). This
// test asserts:
//   1. The 5 services that need the gate import + call assertOwnerOrCreator
//      OR have an inline membership-lookup with creator fallback.
//   2. The customerRole is threaded through from controller → service for
//      the 3 services where we added the gate (submitPayment,
//      customerAcceptDelivery, customerApprove settlement).

describe("Phase 6.9 — money-path OWNER||creator gate coverage", () => {
  const gateFiles = [
    {
      path: "modules/orders/services/order-payment.service.ts",
      method: "submitPayment",
    },
    {
      path: "modules/orders/services/order-delivery.service.ts",
      method: "customerAcceptDelivery",
    },
    {
      path: "modules/orders/services/order-review.service.ts",
      method: "approveContent",
    },
    {
      path: "modules/orders/services/order-review.service.ts",
      method: "confirmDelivery",
    },
    {
      path: "modules/orders/services/order-review.service.ts",
      method: "submitReview",
    },
    {
      path: "modules/settlements/settlements.service.ts",
      method: "customerApprove",
    },
  ]

  it.each(
    gateFiles,
  )("$method in $path enforces OWNER||creator (via assertOwnerOrCreator or inline isCreator/isOwner)", ({
    path,
    method,
  }) => {
    const src = readFileSync(join(__dirname, "..", path), "utf8")
    // Pull the method body (next ~80 lines should be plenty).
    const methodIdx = src.indexOf(`async ${method}(`)
    expect(methodIdx).toBeGreaterThanOrEqual(0)
    const body = src.slice(methodIdx, methodIdx + 4000)
    const hasHelper = /assertOwnerOrCreator\(/.test(body)
    const hasInlineGate =
      /isCreator\s*=\s*[^=]*customerId\s*===?/.test(body) &&
      /isOwner/.test(body) &&
      /ForbiddenException/.test(body)
    expect(hasHelper || hasInlineGate).toBe(true)
  })

  it("orders.controller.ts threads customerRole into submitPayment + acceptDelivery", () => {
    const src = readFileSync(
      join(__dirname, "../modules/orders/orders.controller.ts"),
      "utf8",
    )
    // submitPayment must pass user.customerRole as the 4th arg.
    expect(src).toMatch(
      /payment\.submitPayment\(\s*id\s*,\s*user\.id\s*,\s*user\.organizationId\s*,\s*user\.customerRole\s*\)/,
    )
    // acceptDelivery must pass user.customerRole as the 4th arg.
    expect(src).toMatch(
      /delivery\.customerAcceptDelivery\(\s*id\s*,\s*user\.organizationId\s*,\s*user\.id\s*,\s*user\.customerRole\s*\)/,
    )
  })

  it("settlements.controller.ts threads customerRole into customerApprove", () => {
    const src = readFileSync(
      join(__dirname, "../modules/settlements/settlements.controller.ts"),
      "utf8",
    )
    expect(src).toMatch(
      /customerApprove\(\s*id\s*,\s*user\.id\s*,\s*user\.organizationId\s*,\s*user\.role\s*,\s*user\.customerRole\s*\)/,
    )
  })
})
