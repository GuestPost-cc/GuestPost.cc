import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { IdentityService } from "../identity.service"

function createHarness(owner = true) {
  const prisma: any = {
    membership: {
      findFirst: jest.fn().mockResolvedValue(owner ? { id: "member-1" } : null),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        name: "Acme Ltd.",
        billingProfile: null,
      }),
    },
    billingProfile: {
      upsert: jest
        .fn()
        .mockImplementation(({ create }) =>
          Promise.resolve({ id: "profile-1", ...create }),
        ),
    },
  }
  prisma.$transaction = jest.fn((callback) => callback(prisma))
  const audit = { log: jest.fn().mockResolvedValue(undefined) }
  const service = new IdentityService(
    prisma,
    audit as any,
    {} as any,
    undefined,
  )
  return { prisma, audit, service }
}

const profile = {
  legalName: "Acme Content Ltd.",
  billingEmail: "Accounts@Acme.Example",
  addressLine1: "42 Editorial Road",
  addressLine2: null,
  city: "London",
  region: null,
  postalCode: "EC1A 1BB",
  countryCode: "gb",
  taxIdType: "VAT",
  taxId: "GB123456789",
}

describe("organization billing profiles", () => {
  it("returns a safe organization-name default before setup", async () => {
    const { service } = createHarness()
    await expect(service.getBillingProfile("org-1", "user-1")).resolves.toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        legalName: "Acme Ltd.",
        addressLine1: "",
      }),
    )
  })

  it("allows only active owners to read billing identity", async () => {
    const { service } = createHarness(false)
    await expect(
      service.getBillingProfile("org-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("normalizes fields and audits without copying sensitive values", async () => {
    const { service, prisma, audit } = createHarness()
    const result = await service.updateBillingProfile(
      "org-1",
      "user-1",
      profile as any,
    )
    expect(result.billingEmail).toBe("accounts@acme.example")
    expect(result.countryCode).toBe("GB")
    expect(prisma.billingProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
      }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          countryCode: "GB",
          hasBillingEmail: true,
          hasTaxId: true,
        },
      }),
      prisma,
    )
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain("GB123456789")
  })

  it("rejects a partial tax identity", async () => {
    const { service } = createHarness()
    await expect(
      service.updateBillingProfile("org-1", "user-1", {
        ...profile,
        taxId: null,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})
