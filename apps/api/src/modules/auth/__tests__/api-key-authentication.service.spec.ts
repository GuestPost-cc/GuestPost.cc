import {
  setRlsRequestContext,
  withApiKeyValidationRlsContext,
} from "@guestpost/database"
import { UnauthorizedException } from "@nestjs/common"
import { ApiKeyAuthenticationService } from "../api-key-authentication.service"

jest.mock("@guestpost/database", () => ({
  ...jest.requireActual("@guestpost/database"),
  setRlsRequestContext: jest.fn(),
  withApiKeyValidationRlsContext: jest.fn(
    async (prisma: any, _context: unknown, operation: (tx: any) => unknown) =>
      operation(prisma),
  ),
}))

const VALID_KEY = `gp_${"a".repeat(64)}`

describe("ApiKeyAuthenticationService", () => {
  beforeEach(() => jest.clearAllMocks())

  it("rejects malformed keys before any database lookup", async () => {
    const prisma = { apiKey: { findUnique: jest.fn(), update: jest.fn() } }
    const service = new ApiKeyAuthenticationService(prisma as any, {} as any)

    await expect(service.authenticate("gp_short")).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    expect(withApiKeyValidationRlsContext).not.toHaveBeenCalled()
  })

  it("binds a live owner to the key's exact organization and records use", async () => {
    const keyRow = {
      id: "key-1",
      organizationId: "org-1",
      createdByUserId: "owner-1",
      permissions: ["orders:read", 42, null],
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }
    const prisma = {
      apiKey: {
        findUnique: jest.fn().mockResolvedValue(keyRow),
        update: jest.fn().mockResolvedValue({}),
      },
    }
    const authority = {
      id: "owner-1",
      userType: "CUSTOMER",
      organizationId: "org-1",
      customerRole: "OWNER",
    }
    const authorities = {
      resolveApiKeyOwner: jest.fn().mockResolvedValue(authority),
    }
    const service = new ApiKeyAuthenticationService(
      prisma as any,
      authorities as any,
    )

    await expect(service.authenticate(VALID_KEY)).resolves.toEqual({
      keyId: "key-1",
      permissions: ["orders:read"],
      authority,
    })
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { lastUsedAt: expect.any(Date) },
    })
    expect(authorities.resolveApiKeyOwner).toHaveBeenCalledWith(
      "owner-1",
      "org-1",
    )
    expect(setRlsRequestContext).toHaveBeenCalledWith({
      workload: "AUTH_BOOTSTRAP",
      actorId: "owner-1",
      actorKind: "CUSTOMER",
    })
  })

  it.each([
    ["legacy key", null, new Date("2099-01-01T00:00:00.000Z")],
    ["expired key", "owner-1", new Date("2000-01-01T00:00:00.000Z")],
  ])("rejects a %s", async (_label, createdByUserId, expiresAt) => {
    const prisma = {
      apiKey: {
        findUnique: jest.fn().mockResolvedValue({
          id: "key-1",
          organizationId: "org-1",
          createdByUserId,
          permissions: ["orders:read"],
          expiresAt,
        }),
        update: jest.fn(),
      },
    }
    const authorities = { resolveApiKeyOwner: jest.fn() }

    await expect(
      new ApiKeyAuthenticationService(
        prisma as any,
        authorities as any,
      ).authenticate(VALID_KEY),
    ).rejects.toBeInstanceOf(UnauthorizedException)
    expect(prisma.apiKey.update).not.toHaveBeenCalled()
    expect(authorities.resolveApiKeyOwner).not.toHaveBeenCalled()
  })
})
