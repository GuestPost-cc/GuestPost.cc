import IORedis, { type RedisOptions } from "ioredis"

let httpClient: IORedis | null = null
let queueClient: IORedis | null = null

const BASE_OPTS: RedisOptions = {
  connectTimeout: 10_000,
  retryStrategy(times: number) {
    // Exponential backoff: 200ms, 400ms, 800ms, ... capped at 30s.
    const delay = Math.min(200 * 2 ** (times - 1), 30_000)
    // Give up after 15 attempts (~3.5 min total).
    if (times > 15) return null
    return delay
  },
  lazyConnect: false,
}

function createHttpClient(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    ...BASE_OPTS,
    // Finite retries — HTTP requests must not hang indefinitely.
    maxRetriesPerRequest: 5,
  })
}

function createQueueClient(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    ...BASE_OPTS,
    // BullMQ manages its own retries — must be null per BullMQ docs.
    maxRetriesPerRequest: null,
  })
}

// HTTP context — auth rate limiting, caches, ephemeral lookups.
// Finite maxRetriesPerRequest so a Redis outage doesn't cascade into
// hung HTTP connections.
export function getRedisClient(): IORedis {
  if (!httpClient) {
    httpClient = createHttpClient()
  }
  return httpClient
}

// BullMQ producer context — queue.service.ts creates Queue instances
// from this connection. maxRetriesPerRequest: null is required by BullMQ.
export function getQueueConnection(): IORedis {
  if (!queueClient) {
    queueClient = createQueueClient()
  }
  return queueClient
}
