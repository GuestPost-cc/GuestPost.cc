import { Redis } from "ioredis"
import { OAUTH_STATE_TTL_SECONDS, REDIS_KEYS } from "../constants"
import { InvalidStateError } from "../errors"
import type { OAuthStatePayload } from "../types"

export class OAuthStateService {
  constructor(private readonly redis: Redis) {}

  async createState(payload: OAuthStatePayload): Promise<string> {
    const key = `${REDIS_KEYS.OAUTH_STATE}${payload.nonce}`
    await this.redis.setex(
      key,
      OAUTH_STATE_TTL_SECONDS,
      JSON.stringify(payload),
    )
    return payload.nonce
  }

  async consumeState(nonce: string): Promise<OAuthStatePayload> {
    const key = `${REDIS_KEYS.OAUTH_STATE}${nonce}`
    const raw = await this.redis.get(key)
    if (!raw) {
      throw new InvalidStateError()
    }
    await this.redis.del(key)
    return JSON.parse(raw) as OAuthStatePayload
  }

  async exists(nonce: string): Promise<boolean> {
    const key = `${REDIS_KEYS.OAUTH_STATE}${nonce}`
    return (await this.redis.exists(key)) === 1
  }
}
