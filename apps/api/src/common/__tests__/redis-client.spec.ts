// Mock IORedis BEFORE importing redis-client so getRedisClient() never
// opens a real socket. Without this, the singleton's IORedis instance
// keeps the event loop alive after the test finishes — jest then waits
// for the handle to close and CI hangs (locally only --forceExit
// papers over it; CI does not).
jest.mock("ioredis", () => {
  const ctor = jest.fn().mockImplementation(() => ({
    quit: jest.fn(),
    disconnect: jest.fn(),
  }))
  return { __esModule: true, default: ctor }
})

import IORedis from "ioredis"
import { getQueueConnection, getRedisClient } from "../redis-client"

const IORedisMock = IORedis as unknown as jest.Mock

// IORedisMock.mock.calls array is populated in registration order:
//   calls[0] = first IORedis constructor call (HTTP client)
//   calls[1] = second IORedis constructor call (queue client)
// The singleton pattern means each constructor fires exactly once.

describe("redis-client", () => {
  describe("getRedisClient (HTTP context)", () => {
    it("creates the HTTP client with connectTimeout, retryStrategy, and finite maxRetriesPerRequest", () => {
      IORedisMock.mockClear()
      // First call to getRedisClient fires the IORedis constructor
      getRedisClient()
      const opts = IORedisMock.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined
      expect(opts).toBeDefined()
      expect(opts!.connectTimeout).toBe(10_000)
      expect(opts!.maxRetriesPerRequest).toBe(5)
      expect(typeof opts!.retryStrategy).toBe("function")
    })

    it("returns the same IORedis instance on every call (singleton)", () => {
      const a = getRedisClient()
      const b = getRedisClient()
      expect(a).toBe(b)
    })

    it("retryStrategy returns null after 15 attempts and delay for early ones", () => {
      const opts = IORedisMock.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined
      expect(opts).toBeDefined()
      const fn = opts!.retryStrategy as (n: number) => number | null
      expect(fn(16)).toBeNull()
      expect(fn(1)).toBeGreaterThan(0)
    })
  })

  describe("getQueueConnection (BullMQ context)", () => {
    it("creates the queue client with connectTimeout, retryStrategy, and maxRetriesPerRequest: null", () => {
      getQueueConnection()
      const opts = IORedisMock.mock.calls[1]?.[1] as
        | Record<string, unknown>
        | undefined
      expect(opts).toBeDefined()
      expect(opts!.connectTimeout).toBe(10_000)
      expect(opts!.maxRetriesPerRequest).toBeNull()
      expect(typeof opts!.retryStrategy).toBe("function")
    })

    it("returns the same IORedis instance on every call (singleton)", () => {
      const a = getQueueConnection()
      const b = getQueueConnection()
      expect(a).toBe(b)
    })
  })

  describe("separate connections", () => {
    it("creates two separate IORedis instances for HTTP and queue", () => {
      const http = getRedisClient()
      const queue = getQueueConnection()
      expect(http).not.toBe(queue)
      // call[0] is HTTP, call[1] is queue
      expect(IORedisMock.mock.calls).toHaveLength(2)
    })
  })
})
