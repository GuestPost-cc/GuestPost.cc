import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CurrentAuthorityGuard } from "../current-authority.guard"

describe("CurrentAuthorityGuard", () => {
  const context = (request: any) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    }) as any

  it("overwrites every cached grant with fresh authority", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false)
    const authorities = {
      resolveRequest: jest.fn().mockResolvedValue({
        id: "user-1",
        userType: "CUSTOMER",
        role: "SEO_SPECIALIST",
        emailVerified: true,
        organizationId: null,
        publisherId: null,
        publisherOrganizationId: null,
        customerRole: null,
        memberRole: null,
        publisherRole: null,
        staffRole: null,
        staffPermissions: [],
      }),
    }
    const request: Record<string, any> = {
      method: "GET",
      authenticatedUserId: "user-1",
      user: {
        id: "user-1",
        organizationId: "stale-org",
        customerRole: "OWNER",
        staffRole: "SUPER_ADMIN",
      },
    }

    await expect(
      new CurrentAuthorityGuard(reflector, authorities as any).canActivate(
        context(request),
      ),
    ).resolves.toBe(true)
    expect(request.user).toMatchObject({
      organizationId: null,
      customerRole: null,
      staffRole: null,
      staffPermissions: [],
    })
    expect(request.currentAuthority).toBeDefined()
  })

  it("skips durable resolution on public routes", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true)
    const authorities = { resolveRequest: jest.fn() }
    const guard = new CurrentAuthorityGuard(reflector, authorities as any)

    await expect(guard.canActivate(context({ user: undefined }))).resolves.toBe(
      true,
    )
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it("fails closed if global guard ordering omits session authentication", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false)
    const authorities = { resolveRequest: jest.fn() }
    const guard = new CurrentAuthorityGuard(reflector, authorities as any)

    await expect(
      guard.canActivate(context({ method: "GET", user: { id: "user-1" } })),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it("keeps non-authoritative presentation fields while replacing grants", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false)
    const authorities = {
      resolveRequest: jest.fn().mockResolvedValue({
        id: "user-1",
        userType: "CUSTOMER",
        role: "SEO_SPECIALIST",
        emailVerified: true,
        organizationId: "fresh-org",
        publisherId: null,
        publisherOrganizationId: null,
        customerRole: "MEMBER",
        memberRole: "MEMBER",
        publisherRole: null,
        staffRole: null,
        staffPermissions: [],
      }),
    }
    const request = {
      method: "GET",
      authenticatedUserId: "user-1",
      user: {
        id: "user-1",
        name: "Presentation Name",
        image: "https://cdn.example/avatar.png",
        organizationId: "stale-org",
        customerRole: "OWNER",
      },
    }

    await new CurrentAuthorityGuard(reflector, authorities as any).canActivate(
      context(request),
    )

    expect(request.user).toMatchObject({
      name: "Presentation Name",
      image: "https://cdn.example/avatar.png",
      organizationId: "fresh-org",
      customerRole: "MEMBER",
    })
  })

  it("retains the email-verification gate on fresh authority", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false)
    const authorities = {
      resolveRequest: jest.fn().mockResolvedValue({
        emailVerified: false,
      }),
    }
    const guard = new CurrentAuthorityGuard(reflector, authorities as any)

    await expect(
      guard.canActivate(
        context({
          method: "POST",
          originalUrl: "/orders",
          path: "/orders",
          authenticatedUserId: "user-1",
          user: { id: "user-1" },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })
})
