import { CampaignsService } from "../campaigns.service"

describe("CampaignsService.listCampaigns", () => {
  it("returns authoritative order counts without leaking the Prisma count shape", async () => {
    const campaign = {
      id: "campaign-1",
      name: "Launch",
      organizationId: "org-1",
      _count: { orders: 7 },
    }
    const prisma: any = {
      campaign: {
        findMany: jest.fn().mockResolvedValue([campaign]),
        count: jest.fn().mockResolvedValue(1),
      },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    }
    const service = new CampaignsService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
    )

    const result = await service.listCampaigns("org-1", 25, 0)

    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        take: 25,
        skip: 0,
        include: { _count: { select: { orders: true } } },
      }),
    )
    expect(result).toEqual({
      items: [
        {
          id: "campaign-1",
          name: "Launch",
          organizationId: "org-1",
          orderCount: 7,
        },
      ],
      total: 1,
      take: 25,
      skip: 0,
    })
  })

  it("delegates the legacy campaign revision route to the canonical order state machine", async () => {
    const orderReview = {
      requestRevision: jest.fn().mockResolvedValue({ id: "revision-1" }),
    }
    const prisma = { order: { findFirst: jest.fn() } }
    const service = new CampaignsService(
      prisma as any,
      {} as any,
      {} as any,
      orderReview as any,
    )

    await expect(
      service.requestRevision(
        "order-1",
        "org-1",
        "Please update the requested content.",
        "user-1",
      ),
    ).resolves.toEqual({
      id: "revision-1",
      website: undefined,
      items: [],
      events: [],
      settlements: [],
    })

    expect(orderReview.requestRevision).toHaveBeenCalledWith(
      "order-1",
      "org-1",
      "user-1",
      "Please update the requested content.",
    )
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })
})
