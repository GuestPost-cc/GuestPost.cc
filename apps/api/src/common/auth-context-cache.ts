// Per-instance TTL cache for the resolved auth context (user record +
// active org/publisher + roles). AuthGuard otherwise costs 3-5 DB queries on
// EVERY request — the hottest path in the API.
//
// Correctness: any mutation that changes what the guard would resolve
// (context switch, membership/role change, ban) must call invalidate(userId).
// The TTL is only a backstop for mutations we missed or that happened on
// another instance.
//
// Cross-pod invalidation (M-1): when invalidateAuthContext is called, it
// publishes a message to Redis. Every pod's subscriber receives it and evicts
// its local cache entry. Redis unavailability does not block mutations — the
// local cache is always invalidated immediately; cross-pod invalidation is
// delayed until Redis reconnects. Failures are logged but never thrown.

import { Logger } from "@nestjs/common"

import { getRedisSubscriber } from "./redis-client"

const logger = new Logger("AuthContextCache")
const CHANNEL = "auth-context:invalidate"
const TTL_MS = 30_000
const MAX_ENTRIES = 10_000

interface CacheEntry {
  value: Record<string, unknown>
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export function getCachedAuthContext(
  userId: string,
): Record<string, unknown> | null {
  const entry = cache.get(userId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(userId)
    return null
  }
  return entry.value
}

export function setCachedAuthContext(
  userId: string,
  value: Record<string, unknown>,
) {
  if (cache.size >= MAX_ENTRIES) {
    // Drop oldest entries (Map preserves insertion order)
    const excess = cache.size - MAX_ENTRIES + 1
    let dropped = 0
    for (const key of cache.keys()) {
      cache.delete(key)
      if (++dropped >= excess) break
    }
  }
  cache.set(userId, { value, expiresAt: Date.now() + TTL_MS })
}

export function invalidateAuthContext(userId: string) {
  cache.delete(userId)

  // Fire-and-forget Redis publish for cross-pod invalidation.
  // Do not await — the local cache delete is the synchronous guarantee.
  // If Redis is unavailable, the publish fails silently (logged below)
  // and other pods rely on the 30s TTL backstop.
  try {
    const sub = getRedisSubscriber()
    sub.publish(`${CHANNEL}:${userId}`, "").catch((err: unknown) => {
      logger.warn(
        { userId, error: err instanceof Error ? err.message : String(err) },
        "auth-context-cache: Redis publish failed (cross-pod invalidation degraded)",
      )
    })
  } catch (err) {
    logger.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      "auth-context-cache: Redis unavailable (cross-pod invalidation degraded)",
    )
  }
}

export function clearAuthContextCache() {
  cache.clear()
}

// Called once at app startup (main.ts). Subscribes to auth-context
// invalidation messages from other pods and evicts the local cache entry.
// Must be called after the Redis subscriber connection is established.
export function initAuthContextSubscriber() {
  const sub = getRedisSubscriber()

  sub.psubscribe(`${CHANNEL}:*`)

  sub.on("pmessage", (_pattern: string, channel: string, _message: string) => {
    if (channel.startsWith(CHANNEL)) {
      const userId = channel.slice(CHANNEL.length + 1) // after "auth-context:invalidate:"
      if (userId) {
        cache.delete(userId)
      }
    }
  })

  sub.on("error", (err: Error) => {
    logger.warn(
      { error: err.message },
      "auth-context-cache: Redis subscriber error (cross-pod invalidation degraded)",
    )
  })
}
