import { ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ActorTypeGuard } from "../actor-type.guard"

describe("ActorTypeGuard", () => {
  let reflector: Reflector
  let authorities: { resolveRequest: jest.Mock }
  let guard: ActorTypeGuard

  const context = (user: unknown) => {
    const request = { user }
    return {
      request,
      executionContext: {
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => request }),
      } as any,
    }
  }

  beforeEach(() => {
    reflector = new Reflector()
    authorities = { resolveRequest: jest.fn() }
    guard = new ActorTypeGuard(reflector, authorities as any)
  })

  it("does not resolve authority when no actor type is declared", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined)
    const { executionContext } = context({ id: "user-1" })

    await expect(guard.canActivate(executionContext)).resolves.toBe(true)
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })

  it("uses durable actor type instead of a stale cached projection", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["STAFF"])
    authorities.resolveRequest.mockResolvedValue({ userType: "CUSTOMER" })
    const { executionContext, request } = context({
      id: "user-1",
      userType: "STAFF",
    })

    await expect(guard.canActivate(executionContext)).rejects.toThrow(
      ForbiddenException,
    )
    expect(authorities.resolveRequest).toHaveBeenCalledWith(request)
  })

  it("allows the freshly resolved actor type", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["CUSTOMER"])
    authorities.resolveRequest.mockResolvedValue({ userType: "CUSTOMER" })
    const { executionContext } = context({
      id: "user-1",
      userType: "PUBLISHER",
    })

    await expect(guard.canActivate(executionContext)).resolves.toBe(true)
  })

  it("rejects a missing authenticated projection before resolution", async () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["CUSTOMER"])
    const { executionContext } = context(undefined)

    await expect(guard.canActivate(executionContext)).rejects.toThrow(
      ForbiddenException,
    )
    expect(authorities.resolveRequest).not.toHaveBeenCalled()
  })
})
