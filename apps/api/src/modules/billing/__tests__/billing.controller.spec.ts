import { NotFoundException } from "@nestjs/common"
import { BillingController } from "../billing.controller"

describe("BillingController — ENABLE_DIRECT_DEPOSIT gate (M-3)", () => {
  let controller: BillingController
  let billingMock: any

  beforeEach(() => {
    billingMock = { deposit: jest.fn() }
    controller = new BillingController(billingMock)
  })

  afterEach(() => {
    delete process.env.ENABLE_DIRECT_DEPOSIT
  })

  // deposit() throws synchronously (not async) when the flag is unset,
  // so we use toThrow() instead of rejects.toThrow() for the blocked cases.

  it("returns 404 when ENABLE_DIRECT_DEPOSIT is unset", () => {
    delete process.env.ENABLE_DIRECT_DEPOSIT
    expect(() => controller.deposit("wallet-1", {} as any, {} as any)).toThrow(
      NotFoundException,
    )
    expect(billingMock.deposit).not.toHaveBeenCalled()
  })

  it("returns 404 when ENABLE_DIRECT_DEPOSIT is empty string", () => {
    process.env.ENABLE_DIRECT_DEPOSIT = ""
    expect(() => controller.deposit("wallet-1", {} as any, {} as any)).toThrow(
      NotFoundException,
    )
    expect(billingMock.deposit).not.toHaveBeenCalled()
  })

  it("passes through to billing.deposit when ENABLE_DIRECT_DEPOSIT is true", async () => {
    process.env.ENABLE_DIRECT_DEPOSIT = "true"
    billingMock.deposit.mockResolvedValue({
      id: "wallet-1",
      availableBalance: 1500,
    })

    const result = await controller.deposit(
      "wallet-1",
      { amount: 500, reference: "ref-1" },
      { id: "user-1", organizationId: "org-1" },
    )

    expect(billingMock.deposit).toHaveBeenCalledWith(
      "wallet-1",
      500,
      { id: "user-1", organizationId: "org-1" },
      "ref-1",
    )
    expect(result).toEqual({ id: "wallet-1", availableBalance: 1500 })
  })
})
