import { validate } from "class-validator"
import { MarkVerifiedDto } from "../dto/admin-action-bodies.dto"

describe("manual order verification input", () => {
  it("requires an audited delivery override reason", async () => {
    const canonical = Object.assign(new MarkVerifiedDto(), {
      reason: "OTHER",
      notes: "Evidence reviewed by operations",
    })
    const legacyStatusOnly = Object.assign(new MarkVerifiedDto(), {
      method: "MANUAL_ADMIN",
    })
    const unknownReason = Object.assign(new MarkVerifiedDto(), {
      reason: "UNREVIEWED_OVERRIDE",
    })
    const unexplainedOther = Object.assign(new MarkVerifiedDto(), {
      reason: "OTHER",
    })

    await expect(validate(canonical)).resolves.toEqual([])
    await expect(validate(legacyStatusOnly)).resolves.not.toEqual([])
    await expect(validate(unknownReason)).resolves.not.toEqual([])
    await expect(validate(unexplainedOther)).resolves.not.toEqual([])
  })
})
