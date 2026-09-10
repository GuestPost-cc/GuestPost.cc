import type { ApiKeyPermission } from "@guestpost/shared"
import { SetMetadata } from "@nestjs/common"

export const API_KEY_PERMISSIONS_KEY = "apiKeyPermissions"

/**
 * Explicitly opts a route into API-key authentication. Session-authenticated
 * requests are unaffected. API keys fail closed on every route without it.
 */
export const ApiKeyPermissions = (...permissions: ApiKeyPermission[]) =>
  SetMetadata(API_KEY_PERMISSIONS_KEY, permissions)
