import {
  type FetchResult,
  runDeliveryLinkRecheck,
} from "../delivery-verification-core"

const version = {
  id: "delivery-1",
  orderId: "order-1",
  publishedUrl: "https://publisher.example/article",
  normalizedUrl: "https://publisher.example/article",
  verificationStatus: "FAILED",
  interventionStatus: "REJECTED",
  verificationVersion: 3,
  supersededByVersion: null,
}

const order = {
  id: "order-1",
  organizationId: "organization-1",
  customerId: "customer-1",
  status: "VERIFIED",
  version: 5,
  activeDeliveryVersionId: version.id,
  targetUrl: "https://customer.example/product",
  anchorText: "customer product",
  website: {
    url: "https://publisher.example",
    publisherId: "publisher-1",
  },
}

const restoredHtml =
  '<a href="https://customer.example/product">customer product</a>'

function restoredFetch(): Promise<FetchResult> {
  return Promise.resolve({
    finalUrl: version.publishedUrl,
    status: 200,
    headers: {},
    html: restoredHtml,
    redirectChain: [],
  })
}

describe("delivery link restoration after a confirmed fraud finding", () => {
  it("does not treat an already-confirmed LINK_REMOVED flag as remediable", async () => {
    const fetchUrl = jest.fn(restoredFetch)
    const prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(version),
        updateMany: jest.fn(),
      },
      deliveryFraudFlag: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            where.finding === null
              ? null
              : { id: "confirmed-flag", finding: { id: "finding-1" } },
          ),
      },
      deliveryFraudFlagResolution: { create: jest.fn() },
      $transaction: jest.fn(),
    }

    await expect(
      runDeliveryLinkRecheck(
        { prisma, fetchUrl, putObject: jest.fn() },
        version.id,
      ),
    ).resolves.toEqual({ skipped: "not_verified" })

    expect(prisma.deliveryFraudFlag.findFirst).toHaveBeenCalledWith({
      where: {
        deliveryVersionId: version.id,
        type: "LINK_REMOVED",
        resolution: null,
        finding: null,
      },
      select: { id: true },
    })
    expect(fetchUrl).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
  })

  it("re-reads the finding exclusion after the Order lock", async () => {
    const fetchUrl = jest.fn(restoredFetch)
    const tx: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(version),
        updateMany: jest.fn(),
      },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      deliveryFraudFlagResolution: { create: jest.fn() },
      deliveryVerificationEvidence: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: order.id }]),
    }
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      orderDeliveryVersion: {
        findUnique: jest.fn().mockResolvedValue(version),
      },
      deliveryFraudFlag: {
        findFirst: jest.fn().mockResolvedValue({
          id: "flag-1",
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
        }),
      },
      $transaction: jest.fn(
        async (operation: (client: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    }

    await expect(
      runDeliveryLinkRecheck(
        { prisma, fetchUrl, putObject: jest.fn() },
        version.id,
      ),
    ).resolves.toEqual({ skipped: "version_conflict" })

    expect(tx.deliveryFraudFlag.findFirst).toHaveBeenCalledWith({
      where: {
        deliveryVersionId: version.id,
        type: "LINK_REMOVED",
        resolution: null,
        finding: null,
      },
      select: { id: true, createdAt: true },
    })
    expect(tx.deliveryVerificationEvidence.create).not.toHaveBeenCalled()
    expect(tx.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    expect(tx.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
  })
})
