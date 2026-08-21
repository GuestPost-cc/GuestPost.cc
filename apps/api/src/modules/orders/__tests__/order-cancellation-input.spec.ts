import "reflect-metadata"
import {
  CancellationResolution,
  CancellationResponsibility,
} from "@guestpost/database"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import {
  FinanceApproveCancellationDto,
  ReviewCancellationRequestDto,
} from "../dto/order-cancellation.dto"

describe("ReviewCancellationRequestDto", () => {
  function input(reason: string) {
    return plainToInstance(ReviewCancellationRequestDto, {
      resolution: CancellationResolution.FULL_REFUND,
      responsibility: CancellationResponsibility.PLATFORM,
      reason,
    })
  }

  it("normalizes a meaningful review reason before validation", async () => {
    const dto = input(
      "  Confirmed evidence requires a full customer refund review.  ",
    )

    await expect(validate(dto)).resolves.toEqual([])
    expect(dto.reason).toBe(
      "Confirmed evidence requires a full customer refund review.",
    )
  })

  it.each([
    "x".repeat(19),
    ` ${"x".repeat(19)} `,
    "x".repeat(2001),
  ])("rejects a review reason outside the normalized 20–2000 character range", async (reason) => {
    await expect(validate(input(reason))).resolves.not.toEqual([])
  })
})

describe("FinanceApproveCancellationDto", () => {
  it("normalizes before rejecting a whitespace-only Finance reason", async () => {
    const dto = plainToInstance(FinanceApproveCancellationDto, {
      reason: " ".repeat(30),
    })

    await expect(validate(dto)).resolves.not.toEqual([])
    expect(dto.reason).toBe("")
  })
})
