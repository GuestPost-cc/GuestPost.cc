import Redis from "ioredis"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

// Phase A2 — added connectTimeout + retryStrategy so a Redis outage surfaces
// at startup (connectTimeout) and the worker doesn't retry forever silently.
// maxRetriesPerRequest must be null for BullMQ.
export const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 10_000,
  retryStrategy(times: number) {
    // Exponential backoff: 200ms, 400ms, 800ms, ... capped at 30s.
    const delay = Math.min(200 * 2 ** (times - 1), 30_000)
    // Give up after 15 attempts (~3.5 min total).
    if (times > 15) return null
    return delay
  },
}) as any
