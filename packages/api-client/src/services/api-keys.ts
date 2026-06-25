import type { HttpClient } from "../client"

export interface ApiKeyResponse {
  id: string
  name: string
  prefix: string
  permissions: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface ApiKeyCreatedResponse extends ApiKeyResponse {
  rawKey: string
}

export class ApiKeysService {
  constructor(private client: HttpClient) {}

  list() {
    return this.client.get<ApiKeyResponse[]>("/api-keys")
  }

  create(data: { name: string; permissions?: string; expiresAt?: string }) {
    return this.client.post<ApiKeyCreatedResponse>("/api-keys", {
      json: data as unknown as Record<string, unknown>,
    })
  }

  revoke(id: string) {
    return this.client.delete(`/api-keys/${id}`)
  }
}
