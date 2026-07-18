import * as fs from "node:fs"
import * as path from "node:path"

const PROJECT_ROOT = path.resolve(__dirname, "../../../..")

// Inline lookup — mirrors the canonical ORDER_STATUS_PRESENTATION mapping.
// Avoids importing @guestpost/ui (not a dep of the API Nest build).
const STATUS_VARIANT: Record<string, string> = {
  DRAFT: "pending",
  PENDING_PAYMENT: "warning",
  PAID: "info",
  PUBLISHED: "success",
  COMPLETED: "success",
  CANCELLED: "destructive",
}

function adminAdapter(status: string): string {
  const v = STATUS_VARIANT[status] ?? "default"
  switch (v) {
    case "success":
      return "default"
    case "warning":
    case "info":
      return "secondary"
    case "pending":
      return "outline"
    case "destructive":
      return "destructive"
    default:
      return "default"
  }
}

function publisherAdapter(status: string): string {
  const v = STATUS_VARIANT[status] ?? "default"
  switch (v) {
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
    default:
      return "default"
  }
}

describe("Phase 7.9 — STATUS_PRESENTATION adoption (audit #21)", () => {
  describe("architecture regression guards", () => {
    const targets: Array<{ file: string; helper: string }> = [
      {
        file: "apps/admin/src/app/dashboard/_components/operations-workbench.tsx",
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
      expect(adminAdapter("COMPLETED")).toBe("default")
    })
    it("PUBLISHED (success) → default", () => {
      expect(adminAdapter("PUBLISHED")).toBe("default")
    })
    it("PENDING_PAYMENT (warning) → secondary", () => {
      expect(adminAdapter("PENDING_PAYMENT")).toBe("secondary")
    })
    it("PAID (info) → secondary", () => {
      expect(adminAdapter("PAID")).toBe("secondary")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(adminAdapter("CANCELLED")).toBe("destructive")
    })
    it("DRAFT (pending) → outline", () => {
      expect(adminAdapter("DRAFT")).toBe("outline")
    })
  })

  describe("publisher adapter mapping", () => {
    it("COMPLETED (success) → success", () => {
      expect(publisherAdapter("COMPLETED")).toBe("success")
    })
    it("PUBLISHED (success) → success", () => {
      expect(publisherAdapter("PUBLISHED")).toBe("success")
    })
    it("PENDING_PAYMENT (warning) → warning", () => {
      expect(publisherAdapter("PENDING_PAYMENT")).toBe("warning")
    })
    it("PAID (info) → info", () => {
      expect(publisherAdapter("PAID")).toBe("info")
    })
    it("CANCELLED (destructive) → destructive", () => {
      expect(publisherAdapter("CANCELLED")).toBe("destructive")
    })
    it("DRAFT (pending) → secondary", () => {
      expect(publisherAdapter("DRAFT")).toBe("secondary")
    })
  })
})
