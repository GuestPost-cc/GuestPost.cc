import type { Redis } from "ioredis"
import { InvalidStateError } from "../../errors"
import type { OAuthStatePayload } from "../../types"
import { IntegrationOwnerType, IntegrationProvider } from "../../types"
import { OAuthStateService } from "../oauth-state.service"

function createMockRedis(): {
  redis: Record<string, jest.Mock>
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  const redis = {
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value)
      return "OK"
    }),
    get: jest.fn(async (key: string) => {
      return store.get(key) ?? null
    }),
    del: jest.fn(async (key: string): Promise<number> => {
      const existed = store.has(key)
      store.delete(key)
      return existed ? 1 : 0
    }),
    exists: jest.fn(async (key: string): Promise<number> => {
      return store.has(key) ? 1 : 0
    }),
  }
  return { redis, store }
}

describe("OAuthStateService", () => {
  let service: OAuthStateService
  let mockRedis: ReturnType<typeof createMockRedis>

  beforeEach(() => {
    mockRedis = createMockRedis()
    service = new OAuthStateService(mockRedis.redis as unknown as Redis)
  })

  describe("createState", () => {
    it("stores state in Redis with TTL", async () => {
      const payload: OAuthStatePayload = {
        ownerType: IntegrationOwnerType.PUBLISHER,
        ownerId: "pub_123",
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        nonce: "abc123nonce",
        returnUrl: "/dashboard",
        createdAt: "2026-07-07T10:00:00Z",
      }
      const nonce = await service.createState(payload)
      expect(nonce).toBe("abc123nonce")
      expect(mockRedis.redis.setex).toHaveBeenCalledWith(
        "gp:oauth:state:abc123nonce",
        600,
        JSON.stringify(payload),
      )
    })

    it("uses OAUTH_STATE_TTL_SECONDS from constants", async () => {
      const payload: OAuthStatePayload = {
        ownerType: IntegrationOwnerType.PUBLISHER,
        ownerId: "pub_456",
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        nonce: "nonce789",
        returnUrl: "/settings",
        createdAt: "2026-07-07T10:00:00Z",
      }
      await service.createState(payload)
      expect(mockRedis.redis.setex).toHaveBeenCalledWith(
        expect.any(String),
        600,
        expect.any(String),
      )
    })
  })

  describe("consumeState", () => {
    it("retrieves and deletes state atomically", async () => {
      const payload: OAuthStatePayload = {
        ownerType: IntegrationOwnerType.PUBLISHER,
        ownerId: "pub_123",
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        nonce: "state-nonce",
        returnUrl: "/dashboard",
        createdAt: "2026-07-07T10:00:00Z",
      }
      mockRedis.store.set("gp:oauth:state:state-nonce", JSON.stringify(payload))

      const result = await service.consumeState("state-nonce")
      expect(result).toEqual(payload)
      expect(mockRedis.redis.del).toHaveBeenCalledWith(
        "gp:oauth:state:state-nonce",
      )
    })

    it("throws InvalidStateError when state not found", async () => {
      await expect(service.consumeState("nonexistent-nonce")).rejects.toThrow(
        InvalidStateError,
      )
    })

    it("deletes state even if returned", async () => {
      const payload: OAuthStatePayload = {
        ownerType: IntegrationOwnerType.PUBLISHER,
        ownerId: "pub_123",
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        nonce: "to-be-deleted",
        returnUrl: "/",
        createdAt: "2026-07-07T10:00:00Z",
      }
      mockRedis.store.set(
        "gp:oauth:state:to-be-deleted",
        JSON.stringify(payload),
      )

      await service.consumeState("to-be-deleted")
      expect(mockRedis.store.has("gp:oauth:state:to-be-deleted")).toBe(false)
    })
  })

  describe("exists", () => {
    it("returns true when state exists", async () => {
      mockRedis.store.set("gp:oauth:state:existing", JSON.stringify({}))
      const result = await service.exists("existing")
      expect(result).toBe(true)
    })

    it("returns false when state does not exist", async () => {
      const result = await service.exists("nonexistent")
      expect(result).toBe(false)
    })
  })
})
