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
