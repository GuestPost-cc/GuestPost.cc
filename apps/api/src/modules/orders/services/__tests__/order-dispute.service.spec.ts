import { CancellationResponsibility } from "@guestpost/database"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common"
import { OrderDisputeService } from "../order-dispute.service"

describe("OrderDisputeService refund authorization", () => {
  const order = {
    id: "order-1",
    status: "DISPUTED",
    version: 3,
    organizationId: "org-1",
    listingId: "listing-1",
    listingServiceId: "service-1",
    fulfillmentChannel: "PUBLISHER",
    website: { ownershipType: "PUBLISHER", publisherId: "publisher-1" },
  }

  function setup() {
    const tx: any = {
      orderDispute: {
        findUnique: jest.fn().mockResolvedValue({
          id: "dispute-1",
          orderId: "order-1",
          status: "UNDER_REVIEW",
          previousStatus: "COMPLETED",
          order,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: "dispute-1",
          status: "RESOLVED_REFUNDED",
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
    }
    const prisma: any = {
      ...tx,
      order: {
        findUnique: jest.fn().mockResolvedValue({
          website: { publisherId: "publisher-1" },
        }),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (callback: any) => callback(tx)),
    }
    const audit = { log: jest.fn().mockResolvedValue({}) }
    const refund = {
      refundOrderInTransaction: jest.fn().mockResolvedValue({
        order,
        refundTransactionId: "refund-transaction-1",
      }),
    }
    const queue = { enqueueTrustRecompute: jest.fn().mockResolvedValue({}) }
    return {
      service: new OrderDisputeService(
        prisma as any,
        audit as any,
        refund as any,
        queue as any,
      ),
      tx,
      refund,
    }
  }

  it("requires Finance or Super Admin for a dispute refund", async () => {
    const { service } = setup()

    await expect(
      service.resolveDispute(
        "dispute-1",
        "ops-1",
        "OPERATIONS",
        "Evidence supports a full refund.",
        "REFUND",
        CancellationResponsibility.PUBLISHER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("requires an explicit non-undetermined responsibility", async () => {
    const { service } = setup()

    await expect(
      service.resolveDispute(
        "dispute-1",
        "finance-1",
        "FINANCE",
        "Evidence supports a full refund.",
        "REFUND",
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("passes Finance attribution into the canonical refund transaction", async () => {
    const { service, tx, refund } = setup()

    await service.resolveDispute(
      "dispute-1",
      "finance-1",
      "FINANCE",
      "Customer campaign was stopped before final use.",
      "REFUND",
      CancellationResponsibility.CUSTOMER,
    )

    expect(refund.refundOrderInTransaction).toHaveBeenCalledWith(
      tx,
      order,
      "Dispute resolved with refund: Customer campaign was stopped before final use.",
      "finance-1",
      "dispute-refund:dispute-1",
      CancellationResponsibility.CUSTOMER,
    )
  })

  it("maps a concurrent duplicate dispute to a domain conflict", async () => {
    const prisma: any = {
      order: {
        findFirst: jest.fn().mockResolvedValue({
          ...order,
          status: "PUBLISHED",
          paymentStatus: "PAID",
          warrantyEndsAt: null,
          cancellationRequests: [],
          dispute: null,
          website: { ownershipType: "PUBLISHER" },
        }),
      },
      $transaction: jest.fn().mockRejectedValue({ code: "P2002" }),
    }
    const service = new OrderDisputeService(
      prisma,
      { log: jest.fn() } as any,
      { refundOrderInTransaction: jest.fn() } as any,
      { enqueueTrustRecompute: jest.fn() } as any,
    )

    await expect(
      service.openDispute(
        "order-1",
        "org-1",
        "customer-1",
        "Published delivery did not match the approved brief.",
      ),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
