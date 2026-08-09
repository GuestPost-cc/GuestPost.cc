import {
  clearAuthContextCache,
  getCachedAuthContext,
  invalidateAuthContext,
  setCachedAuthContext,
} from "../auth-context-cache"

describe("auth-context-cache", () => {
  beforeEach(() => {
    clearAuthContextCache()
    jest.useRealTimers()
  })

  it("returns cached context within TTL", () => {
    setCachedAuthContext("u1", { id: "u1", organizationId: "org-1" })
    expect(getCachedAuthContext("u1")).toEqual({
      id: "u1",
      organizationId: "org-1",
    })
  })

  it("returns null for unknown users", () => {
    expect(getCachedAuthContext("nobody")).toBeNull()
  })

  it("isolates the canonical entry from mutations to the inserted object", () => {
    const source = {
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    }

    setCachedAuthContext("u1", source)

    source.organizationId = "attacker-org"
    source.authorization.permissions.push("billing:write")
    source.createdAt.setUTCFullYear(2030)

    expect(getCachedAuthContext("u1")).toEqual({
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    })
  })

  it("returns a deep request-local clone for every cache hit", () => {
    setCachedAuthContext("u1", {
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
    })

    const first = getCachedAuthContext("u1") as {
      organizationId: string
      authorization: { permissions: string[] }
    }
    const second = getCachedAuthContext("u1") as {
      organizationId: string
      authorization: { permissions: string[] }
    }

    expect(first).not.toBe(second)
    expect(first.authorization).not.toBe(second.authorization)

    first.organizationId = "attacker-org"
    first.authorization.permissions.push("billing:write")

    expect(second).toEqual({
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
    })
    expect(getCachedAuthContext("u1")).toEqual(second)
  })

  it("isolates mutations made by concurrent cache-hit requests", async () => {
    setCachedAuthContext("u1", {
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
    })

    const requestContexts = await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        await Promise.resolve()
        const requestContext = getCachedAuthContext("u1") as {
          organizationId: string
          authorization: { permissions: string[] }
        }
        requestContext.organizationId = `request-org-${index}`
        requestContext.authorization.permissions.push(`request:${index}`)
        return requestContext
      }),
    )

    for (const [index, requestContext] of requestContexts.entries()) {
      expect(requestContext.organizationId).toBe(`request-org-${index}`)
      expect(requestContext.authorization.permissions).toEqual([
        "billing:read",
        `request:${index}`,
      ])
    }
    expect(getCachedAuthContext("u1")).toEqual({
      id: "u1",
      organizationId: "org-1",
      authorization: { permissions: ["billing:read"] },
    })
  })

  it("expires entries after TTL", () => {
    jest.useFakeTimers()
    setCachedAuthContext("u1", { id: "u1" })
    jest.setSystemTime(Date.now() + 31_000)
    expect(getCachedAuthContext("u1")).toBeNull()
  })

  it("invalidate removes the entry immediately", () => {
    setCachedAuthContext("u1", { id: "u1" })
    invalidateAuthContext("u1")
    expect(getCachedAuthContext("u1")).toBeNull()
  })

  it("evicts oldest entries at capacity instead of growing unbounded", () => {
    for (let i = 0; i < 10_001; i++) {
      setCachedAuthContext(`u${i}`, { id: `u${i}` })
    }
    expect(getCachedAuthContext("u0")).toBeNull()
    expect(getCachedAuthContext("u10000")).toEqual({ id: "u10000" })
  })
})
