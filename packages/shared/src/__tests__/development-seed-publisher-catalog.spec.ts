import {
  DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON,
  ensureDevelopmentSeedPublisherCatalog,
} from "../development-seed-publisher-catalog"

const NOW = new Date("2026-08-03T00:00:00.000Z")
const args = {
  publisherId: "publisher-1",
  organizationId: "publisher-org-1",
  actorUserId: "admin-1",
  now: NOW,
}

type Store = {
  categories: any[]
  websites: any[]
  metrics: any[]
  metricRevisions: any[]
  listings: any[]
  listingCategories: Array<{ listingId: string; categoryId: string }>
  services: any[]
  audits: any[]
}

function createDatabase() {
  let nextId = 1
  const id = (prefix: string) => `${prefix}-${nextId++}`
  const store: Store = {
    categories: [],
    websites: [],
    metrics: [],
    metricRevisions: [],
    listings: [],
    listingCategories: [],
    services: [],
    audits: [],
  }

  const hydrateListing = (listing: any) => ({
    ...listing,
    categories: store.listingCategories
      .filter((row) => row.listingId === listing.id)
      .map(({ categoryId }) => ({ categoryId })),
    services: store.services.filter((row) => row.listingId === listing.id),
  })
  const applyUpdate = (row: any, data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        "increment" in value
      ) {
        row[key] = (row[key] ?? 0) + value.increment
      } else {
        row[key] = value
      }
    }
    return row
  }

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    publisher: {
      findUnique: jest.fn().mockResolvedValue({
        id: args.publisherId,
        organizationId: args.organizationId,
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: args.actorUserId,
        userType: "STAFF",
        banned: false,
      }),
    },
    staffMembership: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ userId: args.actorUserId, role: "SUPER_ADMIN" }),
    },
    marketplaceCategory: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.categories.find((row) => row.slug === where.slug),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id("category"), isActive: true, ...data }
        store.categories.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.categories.find((item) => item.id === where.id)
        return applyUpdate(row, data)
      }),
    },
    website: {
      findMany: jest.fn(async ({ where }: any) =>
        store.websites.filter((row) =>
          where.OR.some((identity: any) =>
            Object.entries(identity).every(
              ([key, value]) => row[key] === value,
            ),
          ),
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: id("website"),
          verificationFailureReason: null,
          lastSuccessfulVerificationAt: null,
          verificationOverrideExpiresAt: null,
          verificationOverrideReason: null,
          verifiedByUserId: null,
          verificationToken: null,
          activeVerifiedToken: null,
          verificationStatus: "PENDING_VERIFICATION",
          verificationMethod: null,
          verifiedAt: null,
          consecutiveFailures: 0,
          verificationVersion: 0,
          ...data,
        }
        store.websites.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.websites.find((item) => item.id === where.id)
        return applyUpdate(row, data)
      }),
    },
    auditLog: {
      findMany: jest.fn(async ({ where, take }: any) =>
        store.audits
          .filter(
            (row) =>
              row.action === where.action &&
              row.entityType === where.entityType &&
              row.entityId === where.entityId &&
              row.userId === where.userId &&
              row.organizationId === where.organizationId,
          )
          .slice(-take)
          .reverse(),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id("audit"), ...data }
        store.audits.push(row)
        return row
      }),
    },
    websiteMetric: {
      findUnique: jest.fn(async ({ where }: any) =>
        store.metrics.find(
          (row) =>
            row.websiteId === where.websiteId_key.websiteId &&
            row.key === where.websiteId_key.key,
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id("metric"), ...data }
        store.metrics.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.metrics.find((item) => item.id === where.id)
        return applyUpdate(row, data)
      }),
    },
    websiteMetricRevision: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id("metric-revision"), ...data }
        store.metricRevisions.push(row)
        return row
      }),
    },
    marketplaceListing: {
      findMany: jest.fn(async ({ where }: any) =>
        store.listings
          .filter((row) =>
            where.OR.some((identity: any) =>
              Object.entries(identity).every(
                ([key, value]) => row[key] === value,
              ),
            ),
          )
          .map(hydrateListing),
      ),
      create: jest.fn(async ({ data }: any) => {
        const { categories, services, ...listingData } = data
        const row = { id: id("listing"), ...listingData }
        store.listings.push(row)
        for (const category of categories.create) {
          store.listingCategories.push({
            listingId: row.id,
            categoryId: category.categoryId,
          })
        }
        for (const service of services.create) {
          store.services.push({
            id: id("service"),
            listingId: row.id,
            version: 0,
            ...service,
          })
        }
        return hydrateListing(row)
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.listings.find((item) => item.id === where.id)
        applyUpdate(row, data)
        return hydrateListing(row)
      }),
    },
    marketplaceListingCategory: {
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = store.listingCategories.length
        store.listingCategories = store.listingCategories.filter(
          (row) =>
            !(
              row.listingId === where.listingId &&
              row.categoryId !== where.categoryId.not
            ),
        )
        return { count: before - store.listingCategories.length }
      }),
      create: jest.fn(async ({ data }: any) => {
        store.listingCategories.push(data)
        return data
      }),
    },
    listingService: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id("service"), version: 0, ...data }
        store.services.push(row)
        return row
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.services.find((item) => item.id === where.id)
        return applyUpdate(row, data)
      }),
    },
  }
  const prisma = {
    $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  }
  return { prisma, tx, store }
}

describe("development seed publisher catalog", () => {
  it("creates reserved-domain inventory with explicit, audited, expiring no-DNS evidence", async () => {
    const { prisma, store } = createDatabase()

    const result = await ensureDevelopmentSeedPublisherCatalog(prisma, args)

    expect(result).toMatchObject({
      changed: true,
      overrideAuditsCreated: 3,
    })
    expect(store.websites).toHaveLength(3)
    expect(store.audits).toHaveLength(3)
    for (const website of store.websites) {
      expect(website).toMatchObject({
        canonicalDomain: website.domain,
        ownershipType: "PUBLISHER",
        publisherId: args.publisherId,
        verificationStatus: "VERIFIED",
        verificationMethod: "SUPER_ADMIN_OVERRIDE",
        verificationToken: null,
        activeVerifiedToken: null,
        lastSuccessfulVerificationAt: null,
        verificationOverrideReason: DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON,
        verifiedByUserId: args.actorUserId,
        metrics: null,
      })
      expect(
        website.verificationOverrideExpiresAt.getTime() -
          website.verifiedAt.getTime(),
      ).toBe(90 * 86_400_000)
    }
    for (const audit of store.audits) {
      expect(audit).toMatchObject({
        action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE",
        userId: args.actorUserId,
        organizationId: args.organizationId,
        metadata: {
          source: "DEVELOPMENT_SEED",
          evidence: "NO_DNS_EVIDENCE",
          reason: DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON,
        },
      })
    }
    expect(store.metrics).toHaveLength(6)
    expect(
      store.metrics.every(
        (metric) =>
          metric.source === "STAFF_MANUAL" &&
          metric.enteredByUserId === args.actorUserId &&
          metric.status === "CURRENT",
      ),
    ).toBe(true)
    expect(store.listings).toHaveLength(3)
    expect(
      store.listings.every(
        (listing) =>
          listing.status === "APPROVED" &&
          listing.currency === "USD" &&
          listing.ownerType === "PUBLISHER" &&
          listing.fulfillmentType === "PUBLISHER" &&
          listing.organizationId === args.organizationId &&
          listing.traffic === null,
      ),
    ).toBe(true)
    expect(
      store.services.every(
        (service) =>
          service.currency === "USD" &&
          service.availability === "AVAILABLE" &&
          service.revisionRounds === 2,
      ),
    ).toBe(true)
  })

  it("performs no writes or duplicate audits on an exact replay", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    jest.clearAllMocks()

    const result = await ensureDevelopmentSeedPublisherCatalog(prisma, {
      ...args,
      now: new Date(NOW.getTime() + DAY_MS),
    })

    expect(result.changed).toBe(false)
    expect(result.overrideAuditsCreated).toBe(0)
    expect(store.audits).toHaveLength(3)
    expect(tx.website.create).not.toHaveBeenCalled()
    expect(tx.website.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
    expect(tx.websiteMetric.create).not.toHaveBeenCalled()
    expect(tx.websiteMetric.update).not.toHaveBeenCalled()
    expect(tx.marketplaceListing.create).not.toHaveBeenCalled()
    expect(tx.marketplaceListing.update).not.toHaveBeenCalled()
    expect(tx.listingService.create).not.toHaveBeenCalled()
    expect(tx.listingService.update).not.toHaveBeenCalled()
  })

  it("repairs an override missing its atomic audit instead of accepting silent evidence", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    store.audits = store.audits.filter(
      (audit) => audit.entityId !== store.websites[0].id,
    )
    jest.clearAllMocks()

    const result = await ensureDevelopmentSeedPublisherCatalog(prisma, {
      ...args,
      now: new Date(NOW.getTime() + DAY_MS),
    })

    expect(result.overrideAuditsCreated).toBe(1)
    expect(tx.website.update).toHaveBeenCalledTimes(1)
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1)
    expect(
      store.audits.find((audit) => audit.entityId === store.websites[0].id),
    ).toMatchObject({
      metadata: {
        source: "DEVELOPMENT_SEED",
        evidence: "NO_DNS_EVIDENCE",
      },
    })
  })

  it("preserves complete VERIFIED DNS evidence instead of replacing it with an override", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    const website = store.websites[0]
    Object.assign(website, {
      verificationStatus: "VERIFIED",
      verificationMethod: "DNS_TXT",
      activeVerifiedToken: "guestpost-verification=genuine-proof",
      verifiedAt: new Date("2026-08-02T00:00:00.000Z"),
      lastSuccessfulVerificationAt: new Date("2026-08-02T00:00:00.000Z"),
      verificationOverrideExpiresAt: null,
      verificationOverrideReason: null,
      verifiedByUserId: null,
    })
    jest.clearAllMocks()

    await ensureDevelopmentSeedPublisherCatalog(prisma, {
      ...args,
      now: new Date(NOW.getTime() + DAY_MS),
    })

    expect(website.verificationMethod).toBe("DNS_TXT")
    expect(website.activeVerifiedToken).toBe(
      "guestpost-verification=genuine-proof",
    )
    expect(tx.website.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("rejects publisher ownership and source-evidence collisions", async () => {
    const ownershipDatabase = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(ownershipDatabase.prisma, args)
    ownershipDatabase.store.websites[0].publisherId = "publisher-other"
    await expect(
      ensureDevelopmentSeedPublisherCatalog(ownershipDatabase.prisma, args),
    ).rejects.toThrow("website ownership collision")

    const metricDatabase = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(metricDatabase.prisma, args)
    metricDatabase.store.metrics[0].source = "AHREFS_FREE_API"
    await expect(
      ensureDevelopmentSeedPublisherCatalog(metricDatabase.prisma, args),
    ).rejects.toThrow("metric evidence collision")
  })

  it("repairs the existing service in place without deleting service rows", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    const listing = store.listings[0]
    const service = store.services.find(
      (row) => row.listingId === listing.id && row.serviceType === "GUEST_POST",
    )
    service.currency = "EUR"
    service.price = "999"
    service.availability = "PAUSED"
    service.revisionRounds = 0
    service.turnaroundDays = 99
    jest.clearAllMocks()

    await ensureDevelopmentSeedPublisherCatalog(prisma, args)

    expect(tx.listingService.update).toHaveBeenCalledTimes(1)
    expect(service).toMatchObject({
      currency: "USD",
      price: "250",
      availability: "AVAILABLE",
      revisionRounds: 2,
      turnaroundDays: 7,
      version: 1,
    })
    expect(tx.marketplaceListingCategory.deleteMany).not.toHaveBeenCalled()
    expect((tx.listingService as any).delete).toBeUndefined()
    expect((tx.listingService as any).deleteMany).toBeUndefined()
  })

  it("fails closed on unexpected category links instead of deleting them", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    const listing = store.listings[0]
    const extraCategory = {
      id: "category-extra",
      slug: "unrelated",
      name: "Unrelated",
    }
    const unexpectedLink = {
      listingId: listing.id,
      categoryId: extraCategory.id,
    }
    store.categories.push(extraCategory)
    store.listingCategories.push(unexpectedLink)
    jest.clearAllMocks()

    await expect(
      ensureDevelopmentSeedPublisherCatalog(prisma, args),
    ).rejects.toThrow("listing category collision")

    expect(store.listingCategories).toContain(unexpectedLink)
    expect(tx.marketplaceListingCategory.deleteMany).not.toHaveBeenCalled()
    expect(tx.marketplaceListingCategory.create).not.toHaveBeenCalled()
  })

  it("fails closed on unexpected service rows instead of deleting or rewriting them", async () => {
    const { prisma, tx, store } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    const listing = store.listings[0]
    const unexpectedService = {
      id: "service-unexpected",
      listingId: listing.id,
      serviceType: "NICHE_EDIT",
      price: "80",
      currency: "USD",
      turnaroundDays: 3,
      revisionRounds: 1,
      availability: "AVAILABLE",
      version: 0,
    }
    store.services.push(unexpectedService)
    jest.clearAllMocks()

    await expect(
      ensureDevelopmentSeedPublisherCatalog(prisma, args),
    ).rejects.toThrow("listing service collision")

    expect(store.services).toContain(unexpectedService)
    expect(tx.listingService.create).not.toHaveBeenCalled()
    expect(tx.listingService.update).not.toHaveBeenCalled()
    expect((tx.listingService as any).delete).toBeUndefined()
    expect((tx.listingService as any).deleteMany).toBeUndefined()
  })

  it("accepts a unique race only after the complete catalog is a locked exact replay", async () => {
    const { prisma, tx } = createDatabase()
    await ensureDevelopmentSeedPublisherCatalog(prisma, args)
    const collision = Object.assign(new Error("unique"), { code: "P2002" })
    prisma.$transaction = jest
      .fn()
      .mockRejectedValueOnce(collision)
      .mockImplementationOnce(
        async (operation: (client: typeof tx) => unknown) => operation(tx),
      ) as any

    await expect(
      ensureDevelopmentSeedPublisherCatalog(prisma, args),
    ).resolves.toMatchObject({ changed: false, overrideAuditsCreated: 0 })
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
  })
})

const DAY_MS = 86_400_000
