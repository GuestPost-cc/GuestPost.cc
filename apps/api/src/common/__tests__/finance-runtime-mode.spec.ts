import { ServiceUnavailableException } from "@nestjs/common"
import { OrderReviewService } from "../../modules/orders/services/order-review.service"
import { assertApiFinanceOperationAllowed } from "../finance-runtime-mode"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("API finance runtime mode", () => {
  it("returns a stable 503 instead of leaking runtime configuration", () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"

    try {
      assertApiFinanceOperationAllowed("external_send")
      throw new Error("expected finance mode rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException)
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        statusCode: 503,
        error: "Finance operation temporarily unavailable",
        code: "FINANCE_OPERATION_BLOCKED",
        mode: "recovery_only",
      })
    }
  })

  it("keeps evidence recovery available during recovery-only mode", () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"

    expect(() => assertApiFinanceOperationAllowed("recovery")).not.toThrow()
  })

  it.each([
    "recovery_only",
    "locked",
  ])("blocks delivery confirmation before it can create financial state in %s", async (mode) => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = mode
    const prisma = {
      order: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    }
    const service = new OrderReviewService(
      prisma as any,
      {} as any,
      {} as any,
      { assertNoActiveCancellation: jest.fn() } as any,
    )

    await expect(
      service.confirmDelivery("order-1", "org-1", "user-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("gates the shared settlement/revenue creation boundary", async () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "locked"
    const cancellation = { assertNoActiveCancellation: jest.fn() }
    const service = new OrderReviewService(
      {} as any,
      {} as any,
      {} as any,
      cancellation as any,
    )

    await expect(
      service.createSettlementForOrder({} as any, "order-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(cancellation.assertNoActiveCancellation).not.toHaveBeenCalled()
  })
})
