import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { OrderOwnershipGuard } from "../order-ownership.guard"

const authority = (overrides: Record<string, unknown> = {}) => ({
  id: "user-1",
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
  ...overrides,
})

describe("OrderOwnershipGuard", () => {
  let reflector: Reflector
  let prisma: any
  let authorities: { resolveRequest: jest.Mock }
  let guard: OrderOwnershipGuard

  const order = {
    id: "order-1",
    organizationId: "org-1",
    fulfillmentChannel: "PUBLISHER",
    website: { publisherId: "publisher-1", ownershipType: "PUBLISHER" },
  }

  const context = (user: any, id: string | null = "order-1") => {
    const request = { user, params: id ? { id } : {} }
    return {
      request,
      context: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any,
    }
  }

  beforeEach(() => {
    reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true)
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      settlement: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    authorities = { resolveRequest: jest.fn() }
    guard = new OrderOwnershipGuard(reflector, prisma, authorities as any)
  })

  it("allows a current customer member in the order organization", async () => {
    authorities.resolveRequest.mockResolvedValue(authority())
    const { context: executionContext, request } = context({
      userType: "CUSTOMER",
      organizationId: "stale-org",
    })

    await expect(guard.canActivate(executionContext)).resolves.toBe(true)
    expect(authorities.resolveRequest).toHaveBeenCalledWith(request)
  })

  it("rejects a customer after context switch or membership deletion", async () => {
    authorities.resolveRequest.mockResolvedValue(
      authority({ organizationId: null, customerRole: null, memberRole: null }),
    )
    const { context: executionContext } = context({
      userType: "CUSTOMER",
      organizationId: "org-1",
      customerRole: "OWNER",
    })

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("rejects a customer whose current organization differs", async () => {
    authorities.resolveRequest.mockResolvedValue(
      authority({ organizationId: "org-2" }),
    )
    const { context: executionContext } = context({ userType: "CUSTOMER" })

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("allows the currently assigned publisher on a publisher-channel order", async () => {
    authorities.resolveRequest.mockResolvedValue(
      authority({
        userType: "PUBLISHER",
        organizationId: null,
        customerRole: null,
        memberRole: null,
        publisherId: "publisher-1",
        publisherRole: "PUBLISHER_OWNER",
      }),
    )
    const { context: executionContext } = context({
      userType: "PUBLISHER",
      publisherId: "stale-publisher",
    })

    await expect(guard.canActivate(executionContext)).resolves.toBe(true)
  })

  it("rejects a publisher after durable membership deletion", async () => {
    authorities.resolveRequest.mockResolvedValue(
      authority({
        userType: "PUBLISHER",
        organizationId: null,
        customerRole: null,
        memberRole: null,
        publisherId: null,
        publisherRole: null,
      }),
    )
    const { context: executionContext } = context({
      userType: "PUBLISHER",
      publisherId: "publisher-1",
      publisherRole: "PUBLISHER_OWNER",
    })

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("rejects a publisher on a platform-channel order", async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      fulfillmentChannel: "PLATFORM",
    })
    authorities.resolveRequest.mockResolvedValue(
      authority({
        userType: "PUBLISHER",
        organizationId: null,
        customerRole: null,
        memberRole: null,
        publisherId: "publisher-1",
        publisherRole: "PUBLISHER_OWNER",
      }),
    )
    const { context: executionContext } = context({ userType: "PUBLISHER" })

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it.each([
    "STAFF",
    "FUTURE_ACTOR",
  ])("fails closed for %s actors", async (userType) => {
    authorities.resolveRequest.mockResolvedValue(
      authority({
        userType,
        organizationId: null,
        customerRole: null,
        memberRole: null,
        staffRole: "SUPER_ADMIN",
      }),
    )
    const { context: executionContext } = context({ userType })

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it("fails closed when the required route id is missing", async () => {
    authorities.resolveRequest.mockResolvedValue(authority())
    const { context: executionContext } = context(
      { userType: "CUSTOMER" },
      null,
    )

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it("rejects a missing authenticated user before resolving authority", async () => {
    const { context: executionContext } = context(undefined)

    await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it("resolves settlement ids to their order and preserves not-found behavior", async () => {
    authorities.resolveRequest.mockResolvedValue(authority())
    prisma.order.findUnique.mockResolvedValue(null)
    prisma.settlement.findUnique.mockResolvedValueOnce({ order })
    const first = context({ userType: "CUSTOMER" }, "set-1")

    await expect(guard.canActivate(first.context)).resolves.toBe(true)

    prisma.settlement.findUnique.mockResolvedValueOnce(null)
    const second = context({ userType: "CUSTOMER" }, "missing")
    await expect(guard.canActivate(second.context)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})
