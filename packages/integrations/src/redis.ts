import IORedis, { type RedisOptions } from "ioredis"

const BASE_REDIS_OPTIONS: RedisOptions = {
  connectTimeout: 10_000,
  maxRetriesPerRequest: null,
  retryStrategy(times: number) {
    const delay = Math.min(200 * 2 ** (times - 1), 30_000)
    if (times > 15) return null
    return delay
  },
}

function parseRedisPort(value: string | undefined): number {
  const port = Number(value ?? 6379)
  return Number.isInteger(port) && port > 0 ? port : 6379
}

export function resolveIntegrationRedisConnection(): string | RedisOptions {
  const redisUrl =
    process.env.QUEUE_REDIS_URL?.trim() ?? process.env.REDIS_URL?.trim()
  if (redisUrl) return redisUrl

  return {
    host: process.env.REDIS_HOST?.trim() || "localhost",
    port: parseRedisPort(process.env.REDIS_PORT),
  }
}

export function createIntegrationQueueConnection(): IORedis {
  const connection = resolveIntegrationRedisConnection()
  if (typeof connection === "string") {
    return new IORedis(connection, BASE_REDIS_OPTIONS)
  }

  return new IORedis({
    ...connection,
    ...BASE_REDIS_OPTIONS,
  })
}
