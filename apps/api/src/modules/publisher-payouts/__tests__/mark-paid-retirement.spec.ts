import { GoneException } from "@nestjs/common"
import { PATH_METADATA } from "@nestjs/common/constants"
import { STAFF_ROLES_KEY } from "../../../common/decorators/staff-roles.decorator"
import { AdminController } from "../../admin/admin.controller"
import { PublisherPayoutsController } from "../publisher-payouts.controller"

describe("legacy publisher Mark Paid retirement", () => {
  it("keeps the old admin route as an explicit 410 compatibility response", () => {
    const handler = AdminController.prototype.markWithdrawalPaid

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "withdrawals/:id/mark-paid",
    )
    expect(Reflect.getMetadata(STAFF_ROLES_KEY, handler)).toEqual([
      "SUPER_ADMIN",
      "FINANCE",
    ])
    try {
      handler.call({} as AdminController, "wd-1")
      throw new Error("Expected the legacy route to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(GoneException)
      expect((error as GoneException).getStatus()).toBe(410)
      expect((error as GoneException).getResponse()).toEqual(
        expect.objectContaining({ code: "LEGACY_MARK_PAID_RETIRED" }),
      )
    }
  })

  it("does not expose the old publisher mark-paid route", () => {
    const prototype = PublisherPayoutsController.prototype as unknown as Record<
      string,
      unknown
    >
    expect(prototype.markPaid).toBeUndefined()
    const routePaths = Object.getOwnPropertyNames(prototype)
      .map((name) =>
        typeof prototype[name] === "function"
          ? Reflect.getMetadata(PATH_METADATA, prototype[name])
          : undefined,
      )
      .filter(Boolean)
    expect(routePaths).not.toContain("withdrawals/:id/mark-paid")
    expect(routePaths).toContain("withdrawals/:id/manual-complete")
  })
})
