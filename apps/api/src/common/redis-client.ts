import IORedis, { type RedisOptions } from "ioredis"

let httpClient: IORedis | null = null
let queueClient: IORedis | null = null
let subscriberClient: IORedis | null = null

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
  return new IORedis(
    process.env.QUEUE_REDIS_URL?.trim() ||
      process.env.REDIS_URL?.trim() ||
      "redis://localhost:6379",
    {
      ...BASE_OPTS,
      // BullMQ manages its own retries — must be null per BullMQ docs.
      maxRetriesPerRequest: null,
    },
  )
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

// Dedicated pub/sub subscriber — must be a separate connection from the
// HTTP and queue clients because ioredis enters subscriber mode after
// subscribe()/psubscribe() and cannot run regular commands.
function createSubscriberClient(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    ...BASE_OPTS,
    // Subscriber must not have maxRetriesPerRequest limit — it needs to
    // stay connected indefinitely and reconnect on failure.
    maxRetriesPerRequest: null,
  })
}

export function getRedisSubscriber(): IORedis {
  if (!subscriberClient) {
    subscriberClient = createSubscriberClient()
  }
  return subscriberClient
}
