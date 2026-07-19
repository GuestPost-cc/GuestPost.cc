import { resolveIntegrationRedisConnection } from "../../redis"

const ORIGINAL_ENV = process.env

describe("integration Redis connection", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.QUEUE_REDIS_URL
    delete process.env.REDIS_URL
    delete process.env.REDIS_HOST
    delete process.env.REDIS_PORT
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it("uses REDIS_URL when present", () => {
    process.env.REDIS_URL = "rediss://default:secret@example.upstash.io:6379"
    process.env.REDIS_HOST = "localhost"
    process.env.REDIS_PORT = "6379"

    expect(resolveIntegrationRedisConnection()).toBe(process.env.REDIS_URL)
  })

  it("prefers the dedicated QUEUE_REDIS_URL", () => {
    process.env.REDIS_URL = "redis://api-cache.internal:6379"
    process.env.QUEUE_REDIS_URL = "rediss://queue.internal:6379"

    expect(resolveIntegrationRedisConnection()).toBe(
      process.env.QUEUE_REDIS_URL,
    )
  })

  it("falls back to REDIS_HOST and REDIS_PORT", () => {
    process.env.REDIS_HOST = "redis.internal"
    process.env.REDIS_PORT = "6380"

    expect(resolveIntegrationRedisConnection()).toEqual({
      host: "redis.internal",
      port: 6380,
    })
  })

  it("keeps the local Redis fallback for development", () => {
    expect(resolveIntegrationRedisConnection()).toEqual({
      host: "localhost",
      port: 6379,
    })
  })
})
