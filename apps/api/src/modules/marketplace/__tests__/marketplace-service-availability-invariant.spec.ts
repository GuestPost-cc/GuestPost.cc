import { AdminService } from "../../admin/admin.service"
import { MarketplaceService } from "../marketplace.service"

type ServiceRow = {
  id: string
  listingId: string
  serviceType: "GUEST_POST"
  price: string
  currency: "USD"
  version: number
  availability: "AVAILABLE" | "PAUSED"
}

function createHarness(initialStatus = "APPROVED", serviceCount = 2) {
  let listingStatus = initialStatus
  const services = new Map<string, ServiceRow>()
  for (let index = 1; index <= serviceCount; index += 1) {
    services.set(`service-${index}`, {
      id: `service-${index}`,
      listingId: "listing-1",
      serviceType: "GUEST_POST",
      price: "100.00",
      currency: "USD",
      version: 0,
      availability: "AVAILABLE",
    })
  }
  const listingRecord = () => ({
    id: "listing-1",
    status: listingStatus,
    title: "Listing",
    organizationId: "org-1",
    publisherId: "publisher-1",
    publisher: { email: "publisher@example.com" },
    ownerType: "PUBLISHER",
    websiteId: null,
    website: null,
    currency: "USD",
    services: [...services.values()]
      .filter((service) => service.availability === "AVAILABLE")
      .slice(0, 1)
      .map((service) => ({ id: service.id })),
    categories: [{ categoryId: "category-1" }],
    language: "English",
    sportsGamingAllowed: false,
    pharmacyAllowed: false,
    cryptoAllowed: false,
    backlinkCount: 1,
    linkType: "DOFOLLOW",
    linkValidity: "PERMANENT",
    googleNews: false,
    markedSponsored: false,
    foreignLanguageAllowed: false,
  })
  let transactionTail = Promise.resolve()
  const lockQueries: string[] = []
  const prisma: any = {
    $queryRaw: jest.fn().mockImplementation((parts: TemplateStringsArray) => {
      lockQueries.push(parts.join("?"))
      return Promise.resolve([{ id: "listing-1" }])
    }),
    $transaction: jest.fn(async (work: (tx: any) => unknown) => {
      let release!: () => void
      const predecessor = transactionTail
      transactionTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await predecessor
      try {
        return await work(prisma)
      } finally {
        release()
      }
    }),
    marketplaceListing: {
      findUnique: jest
        .fn()
        .mockImplementation((args: any) =>
          Promise.resolve(
            args.select?.status ? { status: listingStatus } : listingRecord(),
          ),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        if (where.status !== listingStatus) return Promise.resolve({ count: 0 })
        listingStatus = data.status
        return Promise.resolve({ count: 1 })
      }),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(() => Promise.resolve(listingRecord())),
    },
    listingService: {
      findUnique: jest.fn().mockImplementation((args: any) => {
        const service = services.get(args.where.id)
        if (!service) return Promise.resolve(null)
        return Promise.resolve(
          args.include
            ? { ...service, listing: listingRecord() }
            : { ...service },
        )
      }),
      count: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            [...services.values()].filter(
              (service) => service.availability === "AVAILABLE",
            ).length,
          ),
        ),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        const service = services.get(where.id)
        if (!service || service.version !== where.version) {
          return Promise.resolve({ count: 0 })
        }
        service.version += 1
        if (data.availability) service.availability = data.availability
        return Promise.resolve({ count: 1 })
      }),
    },
    publisherMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: "marketplace-audit" }),
    },
    marketplaceFavorite: { findMany: jest.fn().mockResolvedValue([]) },
  }
  const audit = {
    log: jest.fn().mockResolvedValue({ id: "listing-transition-audit" }),
  }
  const communications = {
    publisherRecipients: jest.fn().mockResolvedValue(["publisher-user"]),
    record: jest
      .fn()
      .mockResolvedValue({ eventId: "listing-event", deliveryIds: [] }),
    dispatchManyBestEffort: jest.fn(),
  }
  return {
    prisma,
    services,
    lockQueries,
    marketplace: new MarketplaceService(prisma, { addJob: jest.fn() } as any),
    admin: new AdminService(
      prisma,
      audit as any,
      {} as any,
      communications as any,
    ),
    listingStatus: () => listingStatus,
  }
}

const publisherActor = {
  userId: "publisher-user",
  activePublisherId: "publisher-1",
}

describe("approved listing service availability invariant", () => {
  it("rejects disabling the last available service on an approved listing", async () => {
    const harness = createHarness("APPROVED", 1)

    await expect(
      harness.marketplace.updateServiceOnListing(
        publisherActor,
        "listing-1",
        "service-1",
        { availability: "PAUSED", version: 0 },
      ),
    ).rejects.toMatchObject({
      response: { code: "LAST_AVAILABLE_SERVICE" },
    })

    expect(harness.services.get("service-1")?.availability).toBe("AVAILABLE")
    expect(harness.prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("serializes two concurrent pauses so one available service remains", async () => {
    const harness = createHarness("APPROVED", 2)

    const results = await Promise.allSettled([
      harness.marketplace.updateServiceOnListing(
        publisherActor,
        "listing-1",
        "service-1",
        { availability: "PAUSED", version: 0 },
      ),
      harness.marketplace.updateServiceOnListing(
        publisherActor,
        "listing-1",
        "service-2",
        { availability: "PAUSED", version: 0 },
      ),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    expect(
      [...harness.services.values()].filter(
        (service) => service.availability === "AVAILABLE",
      ),
    ).toHaveLength(1)
    expect(harness.prisma.auditLog.create).toHaveBeenCalledTimes(1)
  })

  it("serializes approval against a concurrent last-service pause", async () => {
    const harness = createHarness("PENDING_REVIEW", 1)

    const results = await Promise.allSettled([
      harness.admin.updateListingStatus(
        "listing-1",
        "APPROVED",
        { id: "admin-1", staffRole: "SUPER_ADMIN" },
        false,
      ),
      harness.marketplace.updateServiceOnListing(
        publisherActor,
        "listing-1",
        "service-1",
        { availability: "PAUSED", version: 0 },
      ),
    ])

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    expect(harness.listingStatus()).toBe("APPROVED")
    expect(harness.services.get("service-1")?.availability).toBe("AVAILABLE")
    expect(
      harness.lockQueries.filter((query) =>
        query.includes("MarketplaceListing"),
      ),
    ).toHaveLength(2)
  })
})
