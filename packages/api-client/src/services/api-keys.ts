import type { ApiKeyPermission } from "@guestpost/shared"
import type { HttpClient } from "../client"

export interface ApiKeyResponse {
  id: string
  name: string
  permissions: ApiKeyPermission[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface ApiKeyCreatedResponse {
  id: string
  name: string
  permissions: ApiKeyPermission[]
  expiresAt: string
  createdAt: string
  key: string
  message: string
}

export class ApiKeysService {
  constructor(private client: HttpClient) {}

  list() {
    return this.client.get<ApiKeyResponse[]>("/api-keys")
  }

  create(data: {
    name: string
    permissions?: ApiKeyPermission[]
    expiresAt?: string
  }) {
    return this.client.post<ApiKeyCreatedResponse>("/api-keys", {
      json: data as unknown as Record<string, unknown>,
    })
  }

  revoke(id: string) {
    return this.client.delete(`/api-keys/${id}`)
  }
}
