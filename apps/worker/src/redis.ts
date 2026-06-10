import Redis from "ioredis"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

// Config mirrors the API producer (queue.service.ts) — maxRetriesPerRequest
// must be null for BullMQ. Ready check stays on so a bad connection surfaces
// at startup instead of at first job execution.
export const connection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
}) as any
