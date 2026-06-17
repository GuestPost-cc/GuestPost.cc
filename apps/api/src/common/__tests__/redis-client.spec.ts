// Mock IORedis BEFORE importing redis-client so getRedisClient() never
// opens a real socket. Without this, the singleton's IORedis instance
// keeps the event loop alive after the test finishes — jest then waits
// for the handle to close and CI hangs (locally only --forceExit
// papers over it; CI does not).
jest.mock("ioredis", () => {
  const ctor = jest.fn().mockImplementation(() => ({
    // Minimum surface — getRedisClient only stores the instance, no
    // other methods are touched at construction time.
    quit: jest.fn(),
    disconnect: jest.fn(),
  }))
  return { __esModule: true, default: ctor }
})

import { getRedisClient } from "../redis-client"

describe("redis-client", () => {
  it("returns the same IORedis instance on every call (singleton)", () => {
    const a = getRedisClient()
    const b = getRedisClient()
    expect(a).toBe(b)
  })
})
