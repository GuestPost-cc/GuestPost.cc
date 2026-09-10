import crypto from "node:crypto"
import { withOrganizationOwnerRlsContext } from "@guestpost/database"
import { BadRequestException, ForbiddenException } from "@nestjs/common"
import { ApiKeysService } from "./api-keys.service"

jest.mock("@guestpost/database", () => ({
  ...jest.requireActual("@guestpost/database"),
  withOrganizationOwnerRlsContext: jest.fn(
    async (prisma: any, _context: unknown, operation: (tx: any) => unknown) =>
      operation(prisma),
  ),
}))

const OWNER = {
  id: "owner-1",
  userType: "CUSTOMER",
  role: "SEO_SPECIALIST",
  emailVerified: true,
  organizationId: "org-1",
  publisherId: null,
  publisherOrganizationId: null,
  customerRole: "OWNER",
  memberRole: "OWNER",
  publisherRole: null,
  staffRole: null,
  staffPermissions: [],
} as const

describe("ApiKeysService", () => {
  beforeEach(() => jest.clearAllMocks())

  it("creates a one-time key bound to its owner with a bounded default expiry", async () => {
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({
        id: "key-1",
        name: data.name,
        permissions: data.permissions,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
      }),
    )
    const prisma = { apiKey: { create } }
    const audit = { log: jest.fn().mockResolvedValue({}) }
    const before = Date.now()

    const result = await new ApiKeysService(
      prisma as any,
      audit as any,
    ).createKey(OWNER as any, "Automation", ["orders:read"])

    expect(result.key).toMatch(/^gp_[a-f0-9]{64}$/)
    const data = create.mock.calls[0][0].data
    expect(data).toMatchObject({
      organizationId: "org-1",
      createdByUserId: "owner-1",
      name: "Automation",
      permissions: ["orders:read"],
    })
    expect(data.keyHash).toBe(
      crypto.createHash("sha256").update(result.key).digest("hex"),
    )
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 90 * 24 * 60 * 60 * 1000,
    )
    expect(data.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 90 * 24 * 60 * 60 * 1000,
    )
    expect(withOrganizationOwnerRlsContext).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorId: "owner-1",
        organizationId: "org-1",
      }),
      expect.any(Function),
    )
  })

  it("rejects expired and overlong requested lifetimes before writing", async () => {
    const prisma = { apiKey: { create: jest.fn() } }
    const service = new ApiKeysService(prisma as any, {} as any)
    const tooLate = new Date(
      Date.now() + 366 * 24 * 60 * 60 * 1000,
    ).toISOString()

    await expect(
      service.createKey(OWNER as any, "Expired", [], "2000-01-01T00:00:00Z"),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      service.createKey(OWNER as any, "Too late", [], tooLate),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.apiKey.create).not.toHaveBeenCalled()
  })

  it("does not let non-owners manage organization keys", async () => {
    const service = new ApiKeysService({} as any, {} as any)
    await expect(
      service.listKeys({ ...OWNER, customerRole: "MEMBER" } as any),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(withOrganizationOwnerRlsContext).not.toHaveBeenCalled()
  })
})
