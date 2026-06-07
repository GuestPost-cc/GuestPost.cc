export interface ApiClientConfig {
  baseUrl: string
  onAuthError?: () => void
}

export type RequestOptions = Omit<RequestInit, "body" | "headers"> & {
  params?: Record<string, string | number | boolean | undefined>
} & (
    | { body?: Record<string, unknown> | FormData; json?: never }
    | { body?: never; json?: Record<string, unknown> }
  )

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

let _token: string | null = null

export function setToken(token: string) { _token = token }
export function clearToken() { _token = null }
export function getToken() { return _token }

export class HttpClient {
  private config: ApiClientConfig

  constructor(config: ApiClientConfig) {
    this.config = config
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path.startsWith("http") ? path : `${this.config.baseUrl}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { params, body, json, ...rest } = opts
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (_token) headers["Authorization"] = `Bearer ${_token}`
    const init: RequestInit = {
      ...rest,
      method,
      credentials: "include",
      headers,
    }
    if (body instanceof FormData) {
      init.body = body
      const h = init.headers as Record<string, string>
      delete h["Content-Type"]
    } else if (json) {
      init.body = JSON.stringify(json)
    } else if (body) {
      init.body = JSON.stringify(body)
    }

    const res = await fetch(this.buildUrl(path, params), init)
    if (!res.ok) {
      if (res.status === 401 && this.config.onAuthError) this.config.onAuthError()
      let err: { message?: string; code?: string } = {}
      try { err = await res.json() } catch { }
      throw new ApiError(res.status, err.code ?? "UNKNOWN", err.message ?? res.statusText)
    }
    if (res.status === 204) return undefined as T
    return res.json()
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts)
  }

  post<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("POST", path, opts)
  }

  patch<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("PATCH", path, opts)
  }

  put<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("PUT", path, opts)
  }

  delete<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("DELETE", path, opts)
  }
}
