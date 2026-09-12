import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { API_KEY_PERMISSIONS_KEY } from "../../../common/decorators/api-key-permissions.decorator"
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator"
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

  it("fails closed for API keys on routes without an explicit permission", async () => {
    const reflector = new Reflector()
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockImplementation((key) => (key === IS_PUBLIC_KEY ? false : undefined))
    const authority = {
      id: "owner-1",
      userType: "CUSTOMER",
      emailVerified: true,
      organizationId: "org-1",
      customerRole: "OWNER",
      staffPermissions: [],
    }
    const authorities = {
      resolveRequest: jest.fn().mockResolvedValue(authority),
    }

    await expect(
      new CurrentAuthorityGuard(reflector, authorities as any).canActivate(
        context({
          authenticatedUserId: "owner-1",
          currentAuthority: authority,
          apiKey: { permissions: ["orders:read"] },
        }),
      ),
    ).rejects.toThrow("API key is not allowed on this route")
  })

  it("requires every declared API-key permission", async () => {
    const reflector = new Reflector()
    jest.spyOn(reflector, "getAllAndOverride").mockImplementation((key) => {
      if (key === IS_PUBLIC_KEY) return false
      if (key === API_KEY_PERMISSIONS_KEY)
        return ["orders:read", "reports:read"]
      return undefined
    })
    const authority = {
      id: "owner-1",
      userType: "CUSTOMER",
      emailVerified: true,
      organizationId: "org-1",
      customerRole: "OWNER",
      staffPermissions: [],
    }
    const guard = new CurrentAuthorityGuard(reflector, {
      resolveRequest: jest.fn().mockResolvedValue(authority),
    } as any)

    await expect(
      guard.canActivate(
        context({
          authenticatedUserId: "owner-1",
          currentAuthority: authority,
          apiKey: { permissions: ["orders:read"] },
        }),
      ),
    ).rejects.toThrow("API key permission denied")

    await expect(
      guard.canActivate(
        context({
          method: "GET",
          authenticatedUserId: "owner-1",
          currentAuthority: authority,
          apiKey: { permissions: ["reports:read", "orders:read"] },
        }),
      ),
    ).resolves.toBe(true)
  })
})
