// Per-instance TTL cache for the resolved auth context (user record +
// active org/publisher + roles). AuthGuard otherwise costs 3-5 DB queries on
// EVERY request — the hottest path in the API.
//
// Projection freshness: any mutation that changes what the guard would resolve
// (context switch, membership/role change, ban) must call invalidate(userId).
// CurrentAuthorityGuard resolves user type, active tenant, memberships, roles
// and permissions from PostgreSQL on every protected request. This cache is a
// presentation projection only and is never authorization authority.
//
// Cross-pod invalidation (M-1): when invalidateAuthContext is called, it
// publishes a message to Redis. Every pod's subscriber receives it and evicts
// its local cache entry. Redis unavailability does not block mutations — the
// local cache is always invalidated immediately; cross-pod invalidation is
// delayed until Redis reconnects. Failures are logged but never thrown.

import { Logger } from "@nestjs/common"

import { getRedisClient, getRedisSubscriber } from "./redis-client"

const logger = new Logger("AuthContextCache")
const CHANNEL = "auth-context:invalidate"
const TTL_MS = 30_000
const MAX_ENTRIES = 10_000

interface CacheEntry {
  value: Record<string, unknown>
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

// Cache entries are process-global while request.user is request-local and may
// be decorated by downstream guards/interceptors. Clone at both boundaries so
// neither the object originally inserted nor any cache-hit consumer can mutate
// the canonical value observed by another concurrent request. structuredClone
// preserves the Date fields returned by Prisma, unlike JSON serialization.
function cloneAuthContext(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone(value)
}

export function getCachedAuthContext(
  userId: string,
): Record<string, unknown> | null {
  const entry = cache.get(userId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(userId)
    return null
  }
  return cloneAuthContext(entry.value)
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
  cache.set(userId, {
    value: cloneAuthContext(value),
    expiresAt: Date.now() + TTL_MS,
  })
}

export function invalidateAuthContext(userId: string) {
  cache.delete(userId)

  // Fire-and-forget Redis publish for cross-pod invalidation.
  // Do not await — the local cache delete is the synchronous guarantee.
  // If Redis is unavailable, the publish fails silently (logged below)
  // and other pods rely on the 30s TTL backstop.
  try {
    const publisher = getRedisClient()
    publisher.publish(`${CHANNEL}:${userId}`, "").catch((err: unknown) => {
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
export async function initAuthContextSubscriber(): Promise<void> {
  const sub = getRedisSubscriber()

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

  try {
    await sub.psubscribe(`${CHANNEL}:*`)
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "auth-context-cache: Redis subscription failed during startup",
    )
    throw err
  }
}
