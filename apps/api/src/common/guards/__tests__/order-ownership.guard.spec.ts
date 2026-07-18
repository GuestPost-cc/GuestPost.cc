import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { OrderOwnershipGuard } from "../order-ownership.guard"

describe("OrderOwnershipGuard", () => {
  let reflector: Reflector
  let prisma: any
  let guard: OrderOwnershipGuard

  const order = {
    id: "order-1",
    organizationId: "org-1",
    fulfillmentChannel: "PUBLISHER",
    website: { publisherId: "publisher-1", ownershipType: "PUBLISHER" },
  }

  const context = (user: any, id: string | null = "order-1") =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user, params: id ? { id } : {} }),
      }),
    }) as any

  beforeEach(() => {
    reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true)
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      settlement: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    guard = new OrderOwnershipGuard(reflector, prisma)
  })

  it("allows a customer in the order organization", async () => {
    await expect(
      guard.canActivate(
        context({ userType: "CUSTOMER", organizationId: "org-1" }),
      ),
    ).resolves.toBe(true)
  })

  it("rejects a customer from another organization", async () => {
    await expect(
      guard.canActivate(
        context({ userType: "CUSTOMER", organizationId: "org-2" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("allows the assigned publisher on a publisher-channel order", async () => {
    await expect(
      guard.canActivate(
        context({ userType: "PUBLISHER", publisherId: "publisher-1" }),
      ),
    ).resolves.toBe(true)
  })

  it("rejects a publisher on a platform-channel order", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      fulfillmentChannel: "PLATFORM",
    })

    await expect(
      guard.canActivate(
        context({ userType: "PUBLISHER", publisherId: "publisher-1" }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it.each([
    "STAFF",
    "FUTURE_ACTOR",
  ])("fails closed for %s actors", async (userType) => {
    await expect(
      guard.canActivate(context({ userType, staffRole: "SUPER_ADMIN" })),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("fails closed when the required route id is missing", async () => {
    await expect(
      guard.canActivate(
        context({ userType: "CUSTOMER", organizationId: "org-1" }, null),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it("rejects a missing authenticated user", async () => {
    await expect(guard.canActivate(context(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("resolves settlement ids to their order and preserves not-found behavior", async () => {
    prisma.order.findUnique.mockResolvedValue(null)
    prisma.settlement.findUnique.mockResolvedValueOnce({ order })

    await expect(
      guard.canActivate(
        context({ userType: "CUSTOMER", organizationId: "org-1" }, "set-1"),
      ),
    ).resolves.toBe(true)

    prisma.settlement.findUnique.mockResolvedValueOnce(null)
    await expect(
      guard.canActivate(
        context({ userType: "CUSTOMER", organizationId: "org-1" }, "missing"),
      ),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
