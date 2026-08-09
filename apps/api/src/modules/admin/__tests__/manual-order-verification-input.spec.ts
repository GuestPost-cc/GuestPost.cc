import { validate } from "class-validator"
import { ManualVerifyDto } from "../dto/admin-action-bodies.dto"

describe("ManualVerifyDto", () => {
  it("accepts only the canonical persisted admin verification method", async () => {
    const canonical = Object.assign(new ManualVerifyDto(), {
      method: "MANUAL_ADMIN",
    })
    const obsolete = Object.assign(new ManualVerifyDto(), {
      method: "MANUAL_CHECK",
    })
    const automatic = Object.assign(new ManualVerifyDto(), { method: "AUTO" })

    await expect(validate(canonical)).resolves.toEqual([])
    await expect(validate(obsolete)).resolves.not.toEqual([])
    await expect(validate(automatic)).resolves.not.toEqual([])
  })
})
