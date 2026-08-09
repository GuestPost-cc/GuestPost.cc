import { isPrismaUniqueConstraintError } from "./prisma-transaction-retry"
import { runSerializableTransactionWithRetry } from "./settlement-transaction"

const DAY_MS = 86_400_000
const OVERRIDE_MAX_DAYS = 90

export const DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON =
  "Development seed fixture uses an IANA-reserved example domain; no DNS ownership evidence exists."

const CATEGORIES = [
  {
    name: "Technology & Gadgets",
    slug: "technology-and-gadgets",
    description: "Tech blogs and publications",
    sortOrder: 1,
  },
  {
    name: "Health & Fitness",
    slug: "health-and-fitness",
    description: "Health publications",
    sortOrder: 2,
  },
  {
    name: "Banking & Finance",
    slug: "banking-and-finance",
    description: "Finance and investing sites",
    sortOrder: 3,
  },
] as const

export const DEVELOPMENT_SEED_PUBLISHER_CATALOG = [
  {
    url: "https://techinsider.example.com",
    canonicalDomain: "techinsider.example.com",
    name: "Tech Insider",
    websiteCategory: "Technology",
    websiteLanguage: "en",
    country: "US",
    categorySlug: "technology-and-gadgets",
    listing: {
      title: "Guest Post on Tech Insider (DR72)",
      slug: "guest-post-tech-insider",
      description:
        "High-authority technology publication accepting in-depth guest posts. Dofollow link included, permanent placement.",
      shortDescription: "DR72 tech site, dofollow, permanent",
      language: "English",
      domainRating: 72,
      organicTraffic: 145_000,
      price: "250",
      turnaroundDays: 7,
    },
  },
  {
    url: "https://healthdaily.example.com",
    canonicalDomain: "healthdaily.example.com",
    name: "Health Daily",
    websiteCategory: "Health",
    websiteLanguage: "en",
    country: "UK",
    categorySlug: "health-and-fitness",
    listing: {
      title: "Guest Post on Health Daily (DR64)",
      slug: "guest-post-health-daily",
      description:
        "UK health publication with engaged readership. Editorial review, dofollow link.",
      shortDescription: "DR64 health site, UK audience",
      language: "English",
      domainRating: 64,
      organicTraffic: 89_000,
      price: "195",
      turnaroundDays: 10,
    },
  },
  {
    url: "https://financehub.example.com",
    canonicalDomain: "financehub.example.com",
    name: "Finance Hub",
    websiteCategory: "Finance",
    websiteLanguage: "en",
    country: "US",
    categorySlug: "banking-and-finance",
    listing: {
      title: "Guest Post on Finance Hub (DR78)",
      slug: "guest-post-finance-hub",
      description:
        "Premium finance publication. Strict editorial standards, high-value placement.",
      shortDescription: "DR78 finance site, premium",
      language: "English",
      domainRating: 78,
      organicTraffic: 210_000,
      price: "420",
      turnaroundDays: 14,
    },
  },
] as const

type CatalogFixture = (typeof DEVELOPMENT_SEED_PUBLISHER_CATALOG)[number]

export type DevelopmentSeedPublisherCatalogArgs = {
  publisherId: string
  organizationId: string
  actorUserId: string
  now?: Date
}

export type DevelopmentSeedPublisherCatalogResult = {
  websites: Array<{ id: string; name: string; listingTitle: string }>
  changed: boolean
  overrideAuditsCreated: number
}

type CatalogState = DevelopmentSeedPublisherCatalogResult & {
  categoryIds: Map<string, string>
}

class DevelopmentSeedCatalogInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DevelopmentSeedCatalogInvariantError"
  }
}

function invariant(message: string): never {
  throw new DevelopmentSeedCatalogInvariantError(message)
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function decimalEquals(value: unknown, expected: string | number): boolean {
  return (
    value !== null && value !== undefined && String(value) === String(expected)
  )
}

function isReservedExampleDomain(domain: string): boolean {
  const normalized = domain.toLowerCase()
  return (
    normalized === "example" ||
    normalized.endsWith(".example") ||
    normalized === "example.com" ||
    normalized.endsWith(".example.com") ||
    normalized === "example.net" ||
    normalized.endsWith(".example.net") ||
    normalized === "example.org" ||
    normalized.endsWith(".example.org")
  )
}

function assertFixtureIdentity(fixture: CatalogFixture): void {
  const url = new URL(fixture.url)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.toLowerCase() !== fixture.canonicalDomain ||
    !isReservedExampleDomain(fixture.canonicalDomain)
  ) {
    invariant(
      `Development seed website ${fixture.name} is not an exact reserved example-domain root URL`,
    )
  }
}

function isGenuineDnsVerification(website: any): boolean {
  return Boolean(
    website.verificationStatus === "VERIFIED" &&
      website.verificationMethod === "DNS_TXT" &&
      typeof website.activeVerifiedToken === "string" &&
      website.activeVerifiedToken.trim().length > 0 &&
      validDate(website.verifiedAt) &&
      validDate(website.lastSuccessfulVerificationAt),
  )
}

function hasDnsEvidenceFragment(website: any): boolean {
  return Boolean(
    website.verificationMethod === "DNS_TXT" ||
      website.activeVerifiedToken ||
      website.lastSuccessfulVerificationAt,
  )
}

function isExactUnexpiredSeedOverride(
  website: any,
  args: DevelopmentSeedPublisherCatalogArgs,
  now: Date,
): boolean {
  if (
    website.verificationStatus !== "VERIFIED" ||
    website.verificationMethod !== "SUPER_ADMIN_OVERRIDE" ||
    website.verificationOverrideReason !==
      DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON ||
    website.verifiedByUserId !== args.actorUserId ||
    website.verificationToken !== null ||
    website.activeVerifiedToken !== null ||
    website.lastSuccessfulVerificationAt !== null ||
    website.verificationFailureReason !== null ||
    website.consecutiveFailures !== 0 ||
    !validDate(website.verifiedAt) ||
    !validDate(website.verificationOverrideExpiresAt)
  ) {
    return false
  }

  const lifetime =
    website.verificationOverrideExpiresAt.getTime() -
    website.verifiedAt.getTime()
  return (
    website.verificationOverrideExpiresAt.getTime() > now.getTime() &&
    lifetime > 0 &&
    lifetime <= OVERRIDE_MAX_DAYS * DAY_MS
  )
}

async function hasExactSeedOverrideAudit(
  tx: any,
  website: any,
  args: DevelopmentSeedPublisherCatalogArgs,
): Promise<boolean> {
  if (!validDate(website.verificationOverrideExpiresAt)) return false
  const audits = await tx.auditLog.findMany({
    where: {
      action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE",
      entityType: "Website",
      entityId: website.id,
      userId: args.actorUserId,
      organizationId: args.organizationId,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  })
  const expectedExpiry = website.verificationOverrideExpiresAt.toISOString()
  return audits.some((audit: any) => {
    const metadata = audit.metadata
    return Boolean(
      metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        metadata.source === "DEVELOPMENT_SEED" &&
        metadata.evidence === "NO_DNS_EVIDENCE" &&
        metadata.domain === website.canonicalDomain &&
        metadata.publisherId === args.publisherId &&
        metadata.reason === DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON &&
        metadata.expiresAt === expectedExpiry,
    )
  })
}

async function lockWebsiteIdentity(tx: any, fixture: CatalogFixture) {
  await tx.$queryRaw`
    SELECT "id"
    FROM "Website"
    WHERE "url" = ${fixture.url}
       OR "domain" = ${fixture.canonicalDomain}
       OR "canonicalDomain" = ${fixture.canonicalDomain}
    FOR UPDATE
  `
}

async function findWebsiteIdentity(tx: any, fixture: CatalogFixture) {
  const matches = await tx.website.findMany({
    where: {
      OR: [
        { url: fixture.url },
        { domain: fixture.canonicalDomain },
        { canonicalDomain: fixture.canonicalDomain },
      ],
    },
  })
  if (matches.length > 1) {
    invariant(
      `Development seed website identity collision for ${fixture.canonicalDomain}`,
    )
  }
  return matches[0] ?? null
}

function assertWebsiteOwnership(
  website: any,
  fixture: CatalogFixture,
  args: DevelopmentSeedPublisherCatalogArgs,
): void {
  if (
    website.url !== fixture.url ||
    website.domain !== fixture.canonicalDomain ||
    (website.canonicalDomain !== null &&
      website.canonicalDomain !== fixture.canonicalDomain)
  ) {
    invariant(
      `Development seed website URL/domain collision for ${fixture.canonicalDomain}`,
    )
  }
  if (
    website.publisherId !== args.publisherId ||
    website.ownershipType !== "PUBLISHER"
  ) {
    invariant(
      `Development seed website ownership collision for ${fixture.canonicalDomain}`,
    )
  }
}

function websiteContentUpdate(website: any, fixture: CatalogFixture) {
  const desired = {
    canonicalDomain: fixture.canonicalDomain,
    name: fixture.name,
    category: fixture.websiteCategory,
    language: fixture.websiteLanguage,
    country: fixture.country,
    isActive: true,
    // Source-aware WebsiteMetric rows below are authoritative. Never restore
    // the former unversioned JSON metric blob or Google-derived summaries.
    metrics: null,
  }
  const changed = Object.entries(desired).some(
    ([key, value]) => website[key] !== value,
  )
  return changed ? desired : null
}

function overrideUpdate(args: DevelopmentSeedPublisherCatalogArgs, now: Date) {
  return {
    verificationStatus: "VERIFIED",
    verificationMethod: "SUPER_ADMIN_OVERRIDE",
    verificationToken: null,
    activeVerifiedToken: null,
    verifiedAt: now,
    lastVerificationCheckAt: now,
    lastSuccessfulVerificationAt: null,
    verificationOverrideExpiresAt: new Date(
      now.getTime() + OVERRIDE_MAX_DAYS * DAY_MS,
    ),
    verificationOverrideReason: DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON,
    verifiedByUserId: args.actorUserId,
    verificationFailureReason: null,
    consecutiveFailures: 0,
  }
}

async function ensureWebsite(
  tx: any,
  fixture: CatalogFixture,
  args: DevelopmentSeedPublisherCatalogArgs,
  now: Date,
  mutate: boolean,
): Promise<{
  website: any
  changed: boolean
  overrideAuditCreated: boolean
}> {
  assertFixtureIdentity(fixture)
  await lockWebsiteIdentity(tx, fixture)
  let website = await findWebsiteIdentity(tx, fixture)

  if (!website) {
    if (!mutate)
      invariant(
        `Development seed website ${fixture.canonicalDomain} is missing after a uniqueness race`,
      )
    const override = overrideUpdate(args, now)
    website = await tx.website.create({
      data: {
        url: fixture.url,
        domain: fixture.canonicalDomain,
        canonicalDomain: fixture.canonicalDomain,
        name: fixture.name,
        category: fixture.websiteCategory,
        language: fixture.websiteLanguage,
        country: fixture.country,
        metrics: null,
        publisherId: args.publisherId,
        ownershipType: "PUBLISHER",
        isActive: true,
        ...override,
        verificationVersion: 1,
      },
    })
    await createOverrideAudit(tx, website, args, override, null)
    return { website, changed: true, overrideAuditCreated: true }
  }

  assertWebsiteOwnership(website, fixture, args)
  const contentUpdate = websiteContentUpdate(website, fixture)
  const genuineDns = isGenuineDnsVerification(website)
  if (!genuineDns && hasDnsEvidenceFragment(website)) {
    invariant(
      `Development seed website ${fixture.canonicalDomain} has incomplete or revoked DNS evidence`,
    )
  }

  const exactOverride =
    !genuineDns && isExactUnexpiredSeedOverride(website, args, now)
  const exactOverrideAudit =
    exactOverride && (await hasExactSeedOverrideAudit(tx, website, args))
  const needsOverride = !genuineDns && (!exactOverride || !exactOverrideAudit)
  if ((contentUpdate || needsOverride) && !mutate) {
    invariant(
      `Development seed website ${fixture.canonicalDomain} is not an exact replay after a uniqueness race`,
    )
  }
  if (!contentUpdate && !needsOverride) {
    return { website, changed: false, overrideAuditCreated: false }
  }

  const override = needsOverride ? overrideUpdate(args, now) : null
  const priorVerification = {
    status: website.verificationStatus,
    method: website.verificationMethod,
  }
  website = await tx.website.update({
    where: { id: website.id },
    data: {
      ...(contentUpdate ?? {}),
      ...(override ?? {}),
      ...(override ? { verificationVersion: { increment: 1 } } : {}),
    },
  })
  if (override) {
    await createOverrideAudit(tx, website, args, override, priorVerification)
  }
  return {
    website,
    changed: true,
    overrideAuditCreated: Boolean(override),
  }
}

async function createOverrideAudit(
  tx: any,
  website: any,
  args: DevelopmentSeedPublisherCatalogArgs,
  override: ReturnType<typeof overrideUpdate>,
  prior: { status: unknown; method: unknown } | null,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE",
      entityType: "Website",
      entityId: website.id,
      userId: args.actorUserId,
      organizationId: args.organizationId,
      metadata: {
        source: "DEVELOPMENT_SEED",
        evidence: "NO_DNS_EVIDENCE",
        domain: website.canonicalDomain,
        publisherId: args.publisherId,
        reason: DEVELOPMENT_SEED_CATALOG_OVERRIDE_REASON,
        expiresAt: override.verificationOverrideExpiresAt.toISOString(),
        priorStatus: prior?.status ?? null,
        priorMethod: prior?.method ?? null,
      },
    },
  })
}

async function ensureCategories(
  tx: any,
  mutate: boolean,
): Promise<{ ids: Map<string, string>; changed: boolean }> {
  const ids = new Map<string, string>()
  let changed = false
  for (const category of CATEGORIES) {
    await tx.$queryRaw`
      SELECT "id"
      FROM "MarketplaceCategory"
      WHERE "slug" = ${category.slug}
      FOR UPDATE
    `
    let row = await tx.marketplaceCategory.findUnique({
      where: { slug: category.slug },
    })
    if (!row) {
      if (!mutate)
        invariant(
          `Development seed category ${category.slug} is missing after a uniqueness race`,
        )
      row = await tx.marketplaceCategory.create({ data: category })
      changed = true
    } else {
      if (row.name !== category.name) {
        invariant(
          `Development seed category slug collision for ${category.slug}`,
        )
      }
      const needsRepair =
        row.description !== category.description ||
        row.sortOrder !== category.sortOrder ||
        row.isActive !== true
      if (needsRepair) {
        if (!mutate)
          invariant(
            `Development seed category ${category.slug} is not an exact replay after a uniqueness race`,
          )
        row = await tx.marketplaceCategory.update({
          where: { id: row.id },
          data: {
            description: category.description,
            sortOrder: category.sortOrder,
            isActive: true,
          },
        })
        changed = true
      }
    }
    ids.set(category.slug, row.id)
  }
  return { ids, changed }
}

function metricFixtures(fixture: CatalogFixture) {
  return [
    {
      key: "AHREFS_DOMAIN_RATING",
      provider: "AHREFS",
      value: String(fixture.listing.domainRating),
    },
    {
      key: "AHREFS_ORGANIC_TRAFFIC",
      provider: "AHREFS",
      value: String(fixture.listing.organicTraffic),
    },
  ] as const
}

function exactCurrentSeedMetric(
  metric: any,
  desired: ReturnType<typeof metricFixtures>[number],
  actorUserId: string,
  now: Date,
): boolean {
  if (
    metric.provider !== desired.provider ||
    metric.source !== "STAFF_MANUAL" ||
    metric.status !== "CURRENT" ||
    metric.enteredByUserId !== actorUserId ||
    !decimalEquals(metric.value, desired.value) ||
    !validDate(metric.measuredAt) ||
    !validDate(metric.expiresAt)
  ) {
    return false
  }
  const lifetime = metric.expiresAt.getTime() - metric.measuredAt.getTime()
  return (
    metric.expiresAt.getTime() > now.getTime() &&
    lifetime > 0 &&
    lifetime <= OVERRIDE_MAX_DAYS * DAY_MS
  )
}

async function ensureMetrics(
  tx: any,
  websiteId: string,
  fixture: CatalogFixture,
  args: DevelopmentSeedPublisherCatalogArgs,
  now: Date,
  mutate: boolean,
): Promise<boolean> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "WebsiteMetric"
    WHERE "websiteId" = ${websiteId}
    FOR UPDATE
  `
  let changed = false
  const expiresAt = new Date(now.getTime() + OVERRIDE_MAX_DAYS * DAY_MS)
  for (const desired of metricFixtures(fixture)) {
    const metric = await tx.websiteMetric.findUnique({
      where: { websiteId_key: { websiteId, key: desired.key } },
    })
    if (
      metric &&
      exactCurrentSeedMetric(metric, desired, args.actorUserId, now)
    ) {
      continue
    }
    if (
      metric &&
      (metric.provider !== desired.provider ||
        metric.source !== "STAFF_MANUAL" ||
        metric.enteredByUserId !== args.actorUserId)
    ) {
      invariant(
        `Development seed metric evidence collision for ${fixture.canonicalDomain}/${desired.key}`,
      )
    }
    if (!mutate) {
      invariant(
        `Development seed metric ${fixture.canonicalDomain}/${desired.key} is not an exact replay after a uniqueness race`,
      )
    }

    const data = {
      provider: desired.provider,
      source: "STAFF_MANUAL",
      status: "CURRENT",
      value: desired.value,
      measuredAt: now,
      collectedAt: now,
      expiresAt,
      enteredByUserId: args.actorUserId,
      importBatchId: null,
    }
    if (!metric) {
      await tx.websiteMetric.create({
        data: { websiteId, key: desired.key, ...data },
      })
    } else {
      await tx.websiteMetricRevision.create({
        data: {
          metricId: metric.id,
          websiteId: metric.websiteId,
          key: metric.key,
          provider: metric.provider,
          source: metric.source,
          status: metric.status,
          value: metric.value,
          measuredAt: metric.measuredAt,
          collectedAt: metric.collectedAt,
          expiresAt: metric.expiresAt,
          enteredByUserId: metric.enteredByUserId,
          importBatchId: metric.importBatchId,
          metadata: {
            source: "DEVELOPMENT_SEED",
            reason: "Expired or incomplete synthetic catalog metric replaced",
          },
        },
      })
      await tx.websiteMetric.update({ where: { id: metric.id }, data })
    }
    changed = true
  }
  return changed
}

function desiredListingData(
  fixture: CatalogFixture,
  args: DevelopmentSeedPublisherCatalogArgs,
  websiteId: string,
) {
  return {
    title: fixture.listing.title,
    description: fixture.listing.description,
    shortDescription: fixture.listing.shortDescription,
    status: "APPROVED",
    fulfillmentType: "PUBLISHER",
    ownerType: "PUBLISHER",
    currency: "USD",
    priceType: "fixed",
    domainRating: fixture.listing.domainRating,
    // Public traffic comes only from WebsiteMetric. Keep the quarantined
    // legacy summary empty so it can never become accidental authority.
    traffic: null,
    country: fixture.country,
    language: fixture.listing.language,
    publisherId: args.publisherId,
    organizationId: args.organizationId,
    websiteId,
    sportsGamingAllowed: false,
    pharmacyAllowed: false,
    cryptoAllowed: false,
    backlinkCount: 1,
    linkType: "DOFOLLOW",
    linkValidity: "PERMANENT",
    googleNews: false,
    markedSponsored: false,
    foreignLanguageAllowed: false,
    metricsData: null,
    trafficData: null,
    semrushData: null,
  }
}

function listingNeedsUpdate(listing: any, desired: Record<string, unknown>) {
  return Object.entries(desired).some(([key, value]) => listing[key] !== value)
}

async function ensureListing(
  tx: any,
  fixture: CatalogFixture,
  websiteId: string,
  categoryId: string,
  args: DevelopmentSeedPublisherCatalogArgs,
  now: Date,
  mutate: boolean,
): Promise<{ changed: boolean }> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "MarketplaceListing"
    WHERE "slug" = ${fixture.listing.slug}
       OR "websiteId" = ${websiteId}
    FOR UPDATE
  `
  const matches = await tx.marketplaceListing.findMany({
    where: {
      OR: [{ slug: fixture.listing.slug }, { websiteId }],
    },
    include: {
      categories: { select: { categoryId: true } },
      services: true,
    },
  })
  if (matches.length > 1) {
    invariant(
      `Development seed listing identity collision for ${fixture.listing.slug}`,
    )
  }

  const desired = desiredListingData(fixture, args, websiteId)
  let listing = matches[0] ?? null
  let changed = false
  if (!listing) {
    if (!mutate)
      invariant(
        `Development seed listing ${fixture.listing.slug} is missing after a uniqueness race`,
      )
    listing = await tx.marketplaceListing.create({
      data: {
        slug: fixture.listing.slug,
        ...desired,
        publishedAt: now,
        categories: { create: [{ categoryId }] },
        services: {
          create: [
            {
              serviceType: "GUEST_POST",
              price: fixture.listing.price,
              currency: "USD",
              turnaroundDays: fixture.listing.turnaroundDays,
              revisionRounds: 2,
              availability: "AVAILABLE",
            },
          ],
        },
      },
      include: {
        categories: { select: { categoryId: true } },
        services: true,
      },
    })
    return { changed: true }
  }

  if (
    listing.slug !== fixture.listing.slug ||
    listing.websiteId !== websiteId ||
    listing.publisherId !== args.publisherId ||
    listing.ownerType !== "PUBLISHER" ||
    listing.fulfillmentType !== "PUBLISHER" ||
    (listing.organizationId !== null &&
      listing.organizationId !== args.organizationId)
  ) {
    invariant(
      `Development seed listing ownership collision for ${fixture.listing.slug}`,
    )
  }

  if (listingNeedsUpdate(listing, desired) || !validDate(listing.publishedAt)) {
    if (!mutate)
      invariant(
        `Development seed listing ${fixture.listing.slug} is not an exact replay after a uniqueness race`,
      )
    listing = await tx.marketplaceListing.update({
      where: { id: listing.id },
      data: {
        ...desired,
        ...(validDate(listing.publishedAt) ? {} : { publishedAt: now }),
      },
      include: {
        categories: { select: { categoryId: true } },
        services: true,
      },
    })
    changed = true
  }

  const existingCategoryIds = new Set(
    listing.categories.map((category: any) => category.categoryId),
  )
  const exactCategories =
    existingCategoryIds.size === 1 && existingCategoryIds.has(categoryId)
  if (!exactCategories) {
    const unexpectedCategoryIds = [...existingCategoryIds].filter(
      (existingCategoryId) => existingCategoryId !== categoryId,
    )
    if (unexpectedCategoryIds.length > 0) {
      invariant(
        `Development seed listing category collision for ${fixture.listing.slug}; refusing to delete unexpected category links`,
      )
    }
    if (!mutate)
      invariant(
        `Development seed listing ${fixture.listing.slug} has non-exact categories after a uniqueness race`,
      )
    if (!existingCategoryIds.has(categoryId)) {
      await tx.marketplaceListingCategory.create({
        data: { listingId: listing.id, categoryId },
      })
    }
    changed = true
  }

  const expectedServices = listing.services.filter(
    (candidate: any) => candidate.serviceType === "GUEST_POST",
  )
  const unexpectedServices = listing.services.filter(
    (candidate: any) => candidate.serviceType !== "GUEST_POST",
  )
  if (unexpectedServices.length > 0 || expectedServices.length > 1) {
    invariant(
      `Development seed listing service collision for ${fixture.listing.slug}; refusing to delete or rewrite unexpected service rows`,
    )
  }
  const service = expectedServices[0]
  if (!service) {
    if (!mutate)
      invariant(
        `Development seed service ${fixture.listing.slug}/GUEST_POST is missing after a uniqueness race`,
      )
    await tx.listingService.create({
      data: {
        listingId: listing.id,
        serviceType: "GUEST_POST",
        price: fixture.listing.price,
        currency: "USD",
        turnaroundDays: fixture.listing.turnaroundDays,
        revisionRounds: 2,
        availability: "AVAILABLE",
      },
    })
    changed = true
  } else {
    const serviceChanged =
      !decimalEquals(service.price, fixture.listing.price) ||
      service.currency !== "USD" ||
      service.turnaroundDays !== fixture.listing.turnaroundDays ||
      service.revisionRounds !== 2 ||
      service.availability !== "AVAILABLE"
    if (serviceChanged) {
      if (!mutate)
        invariant(
          `Development seed service ${fixture.listing.slug}/GUEST_POST is not an exact replay after a uniqueness race`,
        )
      await tx.listingService.update({
        where: { id: service.id },
        data: {
          price: fixture.listing.price,
          currency: "USD",
          turnaroundDays: fixture.listing.turnaroundDays,
          revisionRounds: 2,
          availability: "AVAILABLE",
          version: { increment: 1 },
        },
      })
      changed = true
    }
  }

  return { changed }
}

async function assertCatalogAuthority(
  tx: any,
  args: DevelopmentSeedPublisherCatalogArgs,
): Promise<void> {
  const [publisher, actor, staffMembership] = await Promise.all([
    tx.publisher.findUnique({ where: { id: args.publisherId } }),
    tx.user.findUnique({ where: { id: args.actorUserId } }),
    tx.staffMembership.findUnique({ where: { userId: args.actorUserId } }),
  ])
  if (!publisher || publisher.organizationId !== args.organizationId) {
    invariant(
      "Development seed publisher organization does not match the selected publisher",
    )
  }
  if (
    actor?.userType !== "STAFF" ||
    actor.banned === true ||
    staffMembership?.role !== "SUPER_ADMIN"
  ) {
    invariant(
      "Development seed catalog override requires an active Super Admin actor",
    )
  }
}

async function ensureCatalogInTransaction(
  tx: any,
  args: DevelopmentSeedPublisherCatalogArgs,
  now: Date,
  mutate: boolean,
): Promise<CatalogState> {
  await assertCatalogAuthority(tx, args)
  const categories = await ensureCategories(tx, mutate)
  const state: CatalogState = {
    websites: [],
    changed: categories.changed,
    overrideAuditsCreated: 0,
    categoryIds: categories.ids,
  }

  for (const fixture of DEVELOPMENT_SEED_PUBLISHER_CATALOG) {
    const categoryId = state.categoryIds.get(fixture.categorySlug)
    if (!categoryId)
      invariant(
        `Development seed category ${fixture.categorySlug} was not resolved`,
      )

    const websiteResult = await ensureWebsite(tx, fixture, args, now, mutate)
    const metricsChanged = await ensureMetrics(
      tx,
      websiteResult.website.id,
      fixture,
      args,
      now,
      mutate,
    )
    const listingResult = await ensureListing(
      tx,
      fixture,
      websiteResult.website.id,
      categoryId,
      args,
      now,
      mutate,
    )
    state.websites.push({
      id: websiteResult.website.id,
      name: fixture.name,
      listingTitle: fixture.listing.title,
    })
    state.changed ||=
      websiteResult.changed || metricsChanged || listingResult.changed
    if (websiteResult.overrideAuditCreated) state.overrideAuditsCreated += 1
  }
  return state
}

function assertArgs(args: DevelopmentSeedPublisherCatalogArgs): Date {
  if (!args.publisherId || !args.organizationId || !args.actorUserId) {
    invariant(
      "Development seed catalog requires publisher, organization, and actor identities",
    )
  }
  const now = args.now ?? new Date()
  if (!validDate(now))
    invariant("Development seed catalog received an invalid timestamp")
  return new Date(now)
}

/**
 * Converges the local publisher catalog without inventing ownership evidence.
 *
 * The caller must first pass the development database/API sentinel gates. All
 * catalog writes, temporary verification overrides, and their AuditLog rows
 * commit in one SERIALIZABLE transaction. A uniqueness race is accepted only
 * after a fresh locked read proves that the complete catalog is already exact.
 */
export async function ensureDevelopmentSeedPublisherCatalog(
  prisma: any,
  args: DevelopmentSeedPublisherCatalogArgs,
): Promise<DevelopmentSeedPublisherCatalogResult> {
  const now = assertArgs(args)
  try {
    const state = await runSerializableTransactionWithRetry(prisma, (tx) =>
      ensureCatalogInTransaction(tx, args, now, true),
    )
    return {
      websites: state.websites,
      changed: state.changed,
      overrideAuditsCreated: state.overrideAuditsCreated,
    }
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) throw error
    try {
      const state = await runSerializableTransactionWithRetry(prisma, (tx) =>
        ensureCatalogInTransaction(tx, args, now, false),
      )
      return {
        websites: state.websites,
        changed: false,
        overrideAuditsCreated: 0,
      }
    } catch {
      // Preserve the structured unique error that caused rollback. Callers and
      // operators should see the real collision, never a synthetic replay
      // success or a less-useful verification error.
      throw error
    }
  }
}
