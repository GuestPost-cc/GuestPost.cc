import * as fs from "node:fs"
import * as path from "node:path"
import type { OrderStatus } from "@guestpost/shared"
import { getOrderBadgeVariant } from "../../../admin/src/lib/order-status-badge-variant"
import { getPublisherOrderBadgeVariant } from "../../../publisher/src/lib/order-status-badge-variant"

const PROJECT_ROOT = path.resolve(__dirname, "../../../..")

describe("Phase 7.9 — STATUS_PRESENTATION adoption (audit #21)", () => {
  describe("architecture regression guards", () => {
    const targets: Array<{ file: string; helper: string }> = [
      {
        file: "apps/admin/src/app/dashboard/page.tsx",
        helper: "getOrderBadgeVariant",
      },
      {
        file: "apps/admin/src/app/dashboard/orders/page.tsx",
        helper: "getOrderBadgeVariant",
      },
      {
        file: "apps/publisher/src/app/dashboard/page.tsx",
        helper: "getPublisherOrderBadgeVariant",
      },
    ]

    for (const { file, helper } of targets) {
      it(`${file} — statusVariant( is gone`, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf-8")
        expect(content).not.toContain("statusVariant(")
      })

      it(`${file} — imports ${helper}`, () => {
        const content = fs.readFileSync(path.join(PROJECT_ROOT, file), "utf-8")
        expect(content).toContain(helper)
      })
    }
  })

  describe("admin adapter mapping", () => {
    it("COMPLETED (success) → default", () => {
      expect(getOrderBadgeVariant("COMPLETED" as OrderStatus)).toBe("default")
    })
    it("PUBLISHED (success) → default", () => {
      expect(getOrderBadgeVariant("PUBLISHED" as OrderStatus)).toBe("default")
    })
    it("PENDING_PAYMENT (warning) → secondary", () => {
      expect(getOrderBadgeVariant("PENDING_PAYMENT" as OrderStatus)).toBe(
        "secondary",
      )
    })
    it("PAID (info) → secondary", () => {
      expect(getOrderBadgeVariant("PAID" as OrderStatus)).toBe("secondary")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(getOrderBadgeVariant("CANCELLED" as OrderStatus)).toBe(
        "destructive",
      )
    })
    it("DRAFT (pending) → outline", () => {
      expect(getOrderBadgeVariant("DRAFT" as OrderStatus)).toBe("outline")
    })
  })

  describe("publisher adapter mapping", () => {
    it("COMPLETED (success) → success", () => {
      expect(getPublisherOrderBadgeVariant("COMPLETED" as OrderStatus)).toBe(
        "success",
      )
    })
    it("PUBLISHED (success) → success", () => {
      expect(getPublisherOrderBadgeVariant("PUBLISHED" as OrderStatus)).toBe(
        "success",
      )
    })
    it("PENDING_PAYMENT (warning) → warning", () => {
      expect(
        getPublisherOrderBadgeVariant("PENDING_PAYMENT" as OrderStatus),
      ).toBe("warning")
    })
    it("PAID (info) → info", () => {
      expect(getPublisherOrderBadgeVariant("PAID" as OrderStatus)).toBe("info")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(getPublisherOrderBadgeVariant("CANCELLED" as OrderStatus)).toBe(
        "destructive",
      )
    })
    it("DRAFT (pending) → secondary", () => {
      expect(getPublisherOrderBadgeVariant("DRAFT" as OrderStatus)).toBe(
        "secondary",
      )
    })
  })
})
