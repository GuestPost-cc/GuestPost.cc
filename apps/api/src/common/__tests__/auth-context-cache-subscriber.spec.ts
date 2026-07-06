jest.mock("ioredis", () => {
  const { EventEmitter } = require("events")
  const mockRedis = new EventEmitter()
  mockRedis.psubscribe = jest.fn()
  mockRedis.publish = jest.fn().mockResolvedValue(1)
  mockRedis.quit = jest.fn()
  mockRedis.disconnect = jest.fn()
  const ctor = jest.fn(() => mockRedis)
  return { __esModule: true, default: ctor }
})

import { Logger } from "@nestjs/common"
import {
  clearAuthContextCache,
  getCachedAuthContext,
  initAuthContextSubscriber,
  invalidateAuthContext,
  setCachedAuthContext,
} from "../auth-context-cache"
import { getRedisSubscriber } from "../redis-client"

describe("auth-context-cache M-1 — Redis cross-pod invalidation", () => {
  let mockSub: any

  beforeEach(() => {
    clearAuthContextCache()
    jest.clearAllMocks()
    mockSub = getRedisSubscriber()
    mockSub.removeAllListeners()
  })

  it("publishes invalidation on auth-context:invalidate:{userId} channel", () => {
    invalidateAuthContext("user-1")

    expect(mockSub.publish).toHaveBeenCalledWith(
      "auth-context:invalidate:user-1",
      "",
    )
  })

  it("local cache is evicted before publish attempt", () => {
    setCachedAuthContext("user-1", { id: "user-1" })

    invalidateAuthContext("user-1")

    expect(getCachedAuthContext("user-1")).toBeNull()
    expect(mockSub.publish).toHaveBeenCalled()
  })

  it("subscriber pmessage evicts the targeted cache entry", () => {
    initAuthContextSubscriber()
    setCachedAuthContext("user-2", { id: "user-2" })

    mockSub.emit(
      "pmessage",
      "auth-context:invalidate:*",
      "auth-context:invalidate:user-2",
      "",
    )

    expect(getCachedAuthContext("user-2")).toBeNull()
  })

  it("subscriber pmessage does not evict unrelated entries", () => {
    initAuthContextSubscriber()
    setCachedAuthContext("user-2", { id: "user-2" })
    setCachedAuthContext("user-3", { id: "user-3" })

    mockSub.emit(
      "pmessage",
      "auth-context:invalidate:*",
      "auth-context:invalidate:user-2",
      "",
    )

    expect(getCachedAuthContext("user-2")).toBeNull()
    expect(getCachedAuthContext("user-3")).toEqual({ id: "user-3" })
  })

  it("survives Redis publish failure: local eviction + warn log, no throw", async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {})
    mockSub.publish.mockRejectedValue(new Error("Redis down"))

    setCachedAuthContext("user-1", { id: "user-1" })

    expect(() => invalidateAuthContext("user-1")).not.toThrow()

    // Flush microtasks so the .catch() handler on the rejected publish
    // promise executes before we check the warning.
    await Promise.resolve()

    expect(getCachedAuthContext("user-1")).toBeNull()
    expect(mockSub.publish).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
  })
})
