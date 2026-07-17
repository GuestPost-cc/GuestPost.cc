import { PermissionDeniedError } from "@guestpost/integrations"
import { OwnerResolver } from "../owner-resolver.service"

function requestWithUser(user: Record<string, unknown>) {
  return { user } as any
}

describe("OwnerResolver", () => {
  const prisma = {
    website: { findFirst: jest.fn() },
  }
  const resolver = new OwnerResolver(prisma as any)

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("resolves publisher integrations from the active publisher context", async () => {
    await expect(
      resolver.resolve(
        requestWithUser({
          id: "user-1",
          userType: "PUBLISHER",
          publisherId: "publisher-1",
        }),
      ),
    ).resolves.toEqual({ ownerType: "PUBLISHER", ownerId: "publisher-1" })
    expect(prisma.website.findFirst).not.toHaveBeenCalled()
  })

  it("resolves Super Admin to the selected platform website owner", async () => {
    prisma.website.findFirst.mockResolvedValue({ id: "site-1" })

    await expect(
      resolver.resolve(
        requestWithUser({
          id: "admin-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
        "site-1",
      ),
    ).resolves.toEqual({ ownerType: "PLATFORM", ownerId: "site-1" })
    expect(prisma.website.findFirst).toHaveBeenCalledWith({
      where: { id: "site-1", ownershipType: "PLATFORM" },
      select: { id: true },
    })
  })

  it("resolves Operations only for an assigned platform website", async () => {
    prisma.website.findFirst.mockResolvedValue({ id: "site-1" })

    await expect(
      resolver.resolve(
        requestWithUser({
          id: "ops-1",
          userType: "STAFF",
          staffRole: "OPERATIONS",
        }),
        "site-1",
      ),
    ).resolves.toEqual({ ownerType: "PLATFORM", ownerId: "site-1" })
    expect(prisma.website.findFirst).toHaveBeenCalledWith({
      where: {
        id: "site-1",
        ownershipType: "PLATFORM",
        managedByUserId: "ops-1",
      },
      select: { id: true },
    })
  })

  it("denies Operations for an unassigned platform website", async () => {
    prisma.website.findFirst.mockResolvedValue(null)

    await expect(
      resolver.resolve(
        requestWithUser({
          id: "ops-1",
          userType: "STAFF",
          staffRole: "OPERATIONS",
        }),
        "site-2",
      ),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it("requires staff callers to select a platform website", async () => {
    await expect(
      resolver.resolve(
        requestWithUser({
          id: "admin-1",
          userType: "STAFF",
          staffRole: "SUPER_ADMIN",
        }),
      ),
    ).rejects.toThrow(PermissionDeniedError)
    expect(prisma.website.findFirst).not.toHaveBeenCalled()
  })

  it("does not fall back to a user id when publisher context is absent", async () => {
    await expect(
      resolver.resolve(
        requestWithUser({ id: "user-1", userType: "PUBLISHER" }),
      ),
    ).rejects.toThrow("Publisher not found")
  })
})
