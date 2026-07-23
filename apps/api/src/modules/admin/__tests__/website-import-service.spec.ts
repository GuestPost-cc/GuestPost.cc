import { ConflictException } from "@nestjs/common"
import {
  WEBSITE_IMPORT_HEADERS,
  type WebsiteImportCsvRow,
} from "../website-import/csv-parser"
import { WebsiteImportService } from "../website-import/website-import.service"

const committedRow = {
  id: "row-1",
  rowNumber: 2,
  status: "CREATED",
  websiteId: "website-1",
  normalizedData: {},
}

function batch(status: string, idempotencyKey = "idempotency-key-0001") {
  return {
    id: "batch-1",
    actorUserId: "admin-1",
    publisherId: "publisher-1",
    organizationId: "org-1",
    status,
    idempotencyKey,
    totalRows: 2,
    readyRows: 1,
    warningRows: 0,
    errorRows: 1,
    rows: [committedRow, { id: "row-2", status: "ERROR", websiteId: null }],
    publisher: { id: "publisher-1" },
  }
}

function importRow(
  overrides: Partial<Record<(typeof WEBSITE_IMPORT_HEADERS)[number], string>>,
): WebsiteImportCsvRow {
  const row = Object.fromEntries(
    WEBSITE_IMPORT_HEADERS.map((header) => [header, overrides[header] ?? ""]),
  ) as Record<(typeof WEBSITE_IMPORT_HEADERS)[number], string>
  return { ...row, rowNumber: 2 }
}

function createService() {
  return new WebsiteImportService({} as any, {} as any, {} as any)
}

function importCsv(rows: WebsiteImportCsvRow[]): Buffer {
  const body = rows
    .map((row) => WEBSITE_IMPORT_HEADERS.map((header) => row[header]).join(","))
    .join("\n")
  return Buffer.from(`${WEBSITE_IMPORT_HEADERS.join(",")}\n${body}`)
}

describe("WebsiteImportService row normalization", () => {
  it("skips invalid optional values without rejecting the website row", () => {
    const service = createService()
    const result = (service as any).normalizeRow(
      importRow({
        website_url: "https://example.com",
        website_name: "<b>Unsafe</b>",
        listing_title: "example.com",
        description: "too short",
        primary_language: "Klingon",
        category_slugs: "technology|missing-category|technology",
        sports_gaming_allowed: "yes",
        backlink_count: "4",
        link_type: "INVALID",
        ahrefs_organic_traffic: "1200",
        ahrefs_traffic_as_of: "not-a-date",
        moz_domain_authority: "101",
        moz_da_as_of: new Date().toISOString().slice(0, 10),
        service_type: "UNKNOWN_SERVICE",
        service_price: "100",
        currency: "USD",
        turnaround_days: "7",
      }),
      new Map([["technology", { id: "category-1", name: "Technology" }]]),
    )

    expect(result.errors).toEqual([])
    expect(result.normalized).toMatchObject({
      canonicalDomain: "example.com",
      websiteName: null,
      listingTitle: "Guest publishing on example.com",
      description: "",
      language: null,
      categoryIds: ["category-1"],
      sportsGamingAllowed: null,
      backlinkCount: null,
      linkType: null,
      ahrefsOrganicTraffic: null,
      ahrefsTrafficAsOf: null,
      mozDomainAuthority: null,
      mozDomainAuthorityAsOf: null,
      initialService: null,
    })
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("website_name was skipped"),
        expect.stringContaining(
          "Unknown or inactive category slug was skipped",
        ),
        expect.stringContaining("Ahrefs traffic was skipped"),
        expect.stringContaining("initial service was skipped"),
      ]),
    )
  })

  it("keeps a valid service while defaulting or skipping invalid optional service values", () => {
    const service = createService()
    const result = (service as any).normalizeRow(
      importRow({
        website_url: "https://service-example.com",
        service_type: "GUEST_POST",
        service_price: "125.50",
        currency: "USD",
        turnaround_days: "5",
        revision_rounds: "invalid",
        warranty_days: "5000",
      }),
      new Map(),
    )

    expect(result.errors).toEqual([])
    expect(result.normalized.initialService).toEqual({
      serviceType: "GUEST_POST",
      price: 125.5,
      currency: "USD",
      turnaroundDays: 5,
      revisionRounds: 2,
      warrantyDays: null,
    })
  })

  it("still rejects a row whose required website identity is invalid", () => {
    const service = createService()
    const result = (service as any).normalizeRow(
      importRow({ website_url: "https://example.com/not-a-root-path" }),
      new Map(),
    )

    expect(result.normalized).toBeNull()
    expect(result.errors).not.toHaveLength(0)
  })
})

describe("WebsiteImportService commit recovery", () => {
  it("previews an existing site as an error while retaining other importable rows", async () => {
    const storedRows: any[] = []
    const prisma = {
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          id: "publisher-1",
          organizationId: "org-1",
          publisherMemberships: [{ userId: "owner-1" }],
        }),
      },
      marketplaceCategory: { findMany: jest.fn().mockResolvedValue([]) },
      website: {
        findMany: jest.fn().mockResolvedValue([
          {
            canonicalDomain: "www.existing-example.com",
            domain: "www.existing-example.com",
          },
        ]),
      },
      websiteImportBatch: {
        create: jest.fn().mockImplementation(({ data }) => {
          storedRows.push(...data.rows.create)
          return Promise.resolve({
            id: "batch-1",
            status: "PREVIEWED",
            ...data,
            rows: data.rows.create,
          })
        }),
      },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service = new WebsiteImportService(
      prisma as any,
      audit as any,
      {} as any,
    )

    const result = await service.preview(
      {
        originalname: "mixed.csv",
        buffer: importCsv([
          importRow({ website_url: "https://existing-example.com" }),
          importRow({ website_url: "https://new-example.com" }),
        ]),
      },
      "publisher-1",
      { id: "admin-1" },
    )

    expect(result).toMatchObject({
      totalRows: 2,
      warningRows: 1,
      errorRows: 1,
    })
    expect(storedRows).toEqual([
      expect.objectContaining({
        canonicalDomain: "existing-example.com",
        status: "ERROR",
        normalizedData: undefined,
        errors: ["Domain existing-example.com is already registered"],
      }),
      expect.objectContaining({
        canonicalDomain: "new-example.com",
        status: "WARNING",
        normalizedData: expect.objectContaining({
          canonicalDomain: "new-example.com",
        }),
      }),
    ])
  })

  it("imports a valid row even when another preview row is rejected", async () => {
    const readyRow = {
      id: "row-ready",
      rowNumber: 3,
      status: "WARNING",
      websiteId: null,
      normalizedData: {
        url: "https://new-example.com",
        canonicalDomain: "new-example.com",
        websiteName: null,
        listingTitle: "Guest publishing on new-example.com",
        description: "",
        country: null,
        language: null,
        categoryIds: [],
        sportsGamingAllowed: null,
        pharmacyAllowed: null,
        cryptoAllowed: null,
        backlinkCount: null,
        linkType: null,
        linkValidity: null,
        googleNews: null,
        markedSponsored: null,
        foreignLanguageAllowed: null,
        ahrefsOrganicTraffic: null,
        ahrefsTrafficAsOf: null,
        mozDomainAuthority: null,
        mozDomainAuthorityAsOf: null,
        initialService: null,
      },
    }
    const started = {
      ...batch("PREVIEWED"),
      readyRows: 0,
      warningRows: 1,
      rows: [
        { id: "row-existing", status: "ERROR", websiteId: null },
        readyRow,
      ],
    }
    const finished = {
      ...started,
      status: "PARTIAL",
      createdRows: 1,
      skippedRows: 1,
      failedRows: 0,
      rows: [
        started.rows[0],
        { ...readyRow, status: "CREATED", websiteId: "website-new" },
      ],
    }
    const tx = {
      marketplaceCategory: { count: jest.fn() },
      website: {
        create: jest.fn().mockResolvedValue({ id: "website-new" }),
      },
      marketplaceListing: { create: jest.fn().mockResolvedValue({}) },
      websiteImportRow: { update: jest.fn().mockResolvedValue({}) },
    }
    const prisma = {
      websiteImportBatch: {
        findUnique: jest.fn().mockResolvedValue(started),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(finished),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          id: "publisher-1",
          organizationId: "org-1",
          publisherMemberships: [{ userId: "owner-1" }],
        }),
      },
      website: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((callback) => callback(tx)),
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const queue = { addJob: jest.fn().mockResolvedValue({}) }
    const service = new WebsiteImportService(
      prisma as any,
      audit as any,
      queue as any,
    )

    const result = await service.commit("batch-1", "idempotency-key-0001", {
      id: "admin-1",
    })

    expect(result.status).toBe("PARTIAL")
    expect(tx.website.create).toHaveBeenCalledTimes(1)
    expect(tx.website.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ canonicalDomain: "new-example.com" }),
      }),
    )
    expect(prisma.websiteImportBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          createdRows: 1,
          skippedRows: 1,
          failedRows: 0,
        }),
      }),
    )
  })

  it("resumes an interrupted COMMITTING batch with the same key", async () => {
    const started = batch("COMMITTING")
    const finished = {
      ...started,
      status: "PARTIAL",
      createdRows: 1,
      skippedRows: 1,
      failedRows: 0,
    }
    const prisma = {
      websiteImportBatch: {
        findUnique: jest.fn().mockResolvedValue(started),
        update: jest.fn().mockResolvedValue(finished),
        updateMany: jest.fn(),
      },
      publisher: {
        findUnique: jest.fn().mockResolvedValue({
          id: "publisher-1",
          organizationId: "org-1",
          publisherMemberships: [{ userId: "owner-1" }],
        }),
      },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const queue = { addJob: jest.fn().mockResolvedValue({}) }
    const service = new WebsiteImportService(
      prisma as any,
      audit as any,
      queue as any,
    )

    const result = await service.commit("batch-1", "idempotency-key-0001", {
      id: "admin-1",
    })

    expect(result.status).toBe("PARTIAL")
    expect(prisma.websiteImportBatch.updateMany).not.toHaveBeenCalled()
    expect(prisma.websiteImportBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdRows: 1,
          skippedRows: 1,
          failedRows: 0,
        }),
      }),
    )
    expect(queue.addJob).toHaveBeenCalledWith(
      "domain-metrics",
      "domain-metrics-sync",
      expect.objectContaining({ websiteIds: ["website-1"] }),
      expect.any(Object),
    )
  })

  it("does not replay a terminal batch under a different key", async () => {
    const prisma = {
      websiteImportBatch: {
        findUnique: jest.fn().mockResolvedValue(batch("COMPLETED")),
      },
    }
    const service = new WebsiteImportService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.commit("batch-1", "different-key-0002", { id: "admin-1" }),
    ).rejects.toBeInstanceOf(ConflictException)
  })
})
