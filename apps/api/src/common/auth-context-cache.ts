// Per-instance TTL cache for the resolved auth context (user record +
// active org/publisher + roles). AuthGuard otherwise costs 3-5 DB queries on
// EVERY request — the hottest path in the API.
//
// Correctness: any mutation that changes what the guard would resolve
// (context switch, membership/role change, ban) must call invalidate(userId).
// The TTL is only a backstop for mutations we missed or that happened on
// another instance.

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
}

export function clearAuthContextCache() {
  cache.clear()
}
