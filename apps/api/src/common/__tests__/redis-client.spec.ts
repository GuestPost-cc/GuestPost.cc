import { getRedisClient } from "../redis-client"

describe("redis-client", () => {
  it("returns the same IORedis instance on every call (singleton)", () => {
    const a = getRedisClient()
    const b = getRedisClient()
    expect(a).toBe(b)
  })
})
