import * as fs from "node:fs"
import * as path from "node:path"
import type { OrderStatus } from "@guestpost/shared"
import { getOrderStatusPresentation } from "@guestpost/ui"

const PROJECT_ROOT = path.resolve(__dirname, "../../../..")

function adminAdapter(status: OrderStatus): string {
  const { variant } = getOrderStatusPresentation(status)
  switch (variant) {
    case "success":
      return "default"
    case "warning":
    case "info":
      return "secondary"
    case "pending":
      return "outline"
    case "destructive":
      return "destructive"
    case "default":
      return "default"
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

function publisherAdapter(status: OrderStatus): string {
  const { variant } = getOrderStatusPresentation(status)
  switch (variant) {
    case "success":
      return "success"
    case "warning":
      return "warning"
    case "info":
      return "info"
    case "pending":
      return "secondary"
    case "destructive":
      return "destructive"
    case "default":
      return "default"
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

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
      expect(adminAdapter("COMPLETED" as OrderStatus)).toBe("default")
    })
    it("PUBLISHED (success) → default", () => {
      expect(adminAdapter("PUBLISHED" as OrderStatus)).toBe("default")
    })
    it("PENDING_PAYMENT (warning) → secondary", () => {
      expect(adminAdapter("PENDING_PAYMENT" as OrderStatus)).toBe("secondary")
    })
    it("PAID (info) → secondary", () => {
      expect(adminAdapter("PAID" as OrderStatus)).toBe("secondary")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(adminAdapter("CANCELLED" as OrderStatus)).toBe("destructive")
    })
    it("DRAFT (pending) → outline", () => {
      expect(adminAdapter("DRAFT" as OrderStatus)).toBe("outline")
    })
  })

  describe("publisher adapter mapping", () => {
    it("COMPLETED (success) → success", () => {
      expect(publisherAdapter("COMPLETED" as OrderStatus)).toBe("success")
    })
    it("PUBLISHED (success) → success", () => {
      expect(publisherAdapter("PUBLISHED" as OrderStatus)).toBe("success")
    })
    it("PENDING_PAYMENT (warning) → warning", () => {
      expect(publisherAdapter("PENDING_PAYMENT" as OrderStatus)).toBe("warning")
    })
    it("PAID (info) → info", () => {
      expect(publisherAdapter("PAID" as OrderStatus)).toBe("info")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(publisherAdapter("CANCELLED" as OrderStatus)).toBe("destructive")
    })
    it("DRAFT (pending) → secondary", () => {
      expect(publisherAdapter("DRAFT" as OrderStatus)).toBe("secondary")
    })
  })
})
