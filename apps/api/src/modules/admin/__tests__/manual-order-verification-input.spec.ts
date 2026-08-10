import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { MarkVerifiedDto } from "../dto/admin-action-bodies.dto"

describe("manual order verification input", () => {
  it("requires an audited delivery override reason", async () => {
    const canonical = plainToInstance(MarkVerifiedDto, {
      reason: "OTHER",
      notes: "  Evidence reviewed by operations  ",
    })
    const legacyStatusOnly = plainToInstance(MarkVerifiedDto, {
      method: "MANUAL_ADMIN",
    })
    const unknownReason = plainToInstance(MarkVerifiedDto, {
      reason: "UNREVIEWED_OVERRIDE",
    })
    const unexplainedOther = plainToInstance(MarkVerifiedDto, {
      reason: "OTHER",
    })

    await expect(validate(canonical)).resolves.toEqual([])
    expect(canonical.notes).toBe("Evidence reviewed by operations")
    await expect(validate(legacyStatusOnly)).resolves.not.toEqual([])
    await expect(validate(unknownReason)).resolves.not.toEqual([])
    await expect(validate(unexplainedOther)).resolves.not.toEqual([])
  })

  it("allows short normalized optional notes for a classified reason", async () => {
    const input = plainToInstance(MarkVerifiedDto, {
      reason: "CRAWLER_BLOCKED",
      notes: "  confirmed  ",
    })

    await expect(validate(input)).resolves.toEqual([])
    expect(input.notes).toBe("confirmed")
  })

  it("rejects whitespace-only or too-short OTHER explanations", async () => {
    const whitespaceOnly = plainToInstance(MarkVerifiedDto, {
      reason: "OTHER",
      notes: "                        ",
    })
    const tooShortAfterTrim = plainToInstance(MarkVerifiedDto, {
      reason: "OTHER",
      notes: "       too short       ",
    })

    await expect(validate(whitespaceOnly)).resolves.not.toEqual([])
    await expect(validate(tooShortAfterTrim)).resolves.not.toEqual([])
  })

  it("rejects non-string and oversized optional notes", async () => {
    const nonString = plainToInstance(MarkVerifiedDto, {
      reason: "CRAWLER_BLOCKED",
      notes: 42,
    })
    const oversized = plainToInstance(MarkVerifiedDto, {
      reason: "CRAWLER_BLOCKED",
      notes: ` ${"x".repeat(800)} `,
    })

    await expect(validate(nonString)).resolves.not.toEqual([])
    await expect(validate(oversized)).resolves.not.toEqual([])
  })
})
