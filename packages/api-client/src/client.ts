import { isAuthEndpointPath } from "./auth-redirect"

export interface ApiClientConfig {
  baseUrl: string
  /**
   * Invoked on a 401 from a NON-auth endpoint. The HttpClient skips this
   * callback for sign-in / sign-up / magic-link / sign-out / verify-email
   * paths where 401 is a happy-path response (wrong credentials, expired
   * link, etc.) and the caller handles the error inline.
   *
   * Apps should wire this via `buildAuthErrorHandler(...)` from
   * `./auth-redirect` to get idempotency + URL sanitization + same-page
   * debounce. See that file for the contract.
   */
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
      // Phase 6.8 — Audit finding #7 closure.
      // A 401 from an AUTH endpoint (sign-in / sign-up / magic-link / etc.)
      // is the happy-path "wrong password" response — bouncing the user
      // through a session-expired redirect there would be wrong. Skip the
      // onAuthError handler for those paths; the caller handles the error
      // inline (typically by surfacing "Invalid credentials").
      //
      // For every other 401, fire onAuthError. The handler is responsible
      // for idempotency + same-page debounce + URL sanitization — see
      // ./auth-redirect.ts buildAuthErrorHandler.
      if (res.status === 401 && this.config.onAuthError && !isAuthEndpointPath(path)) {
        this.config.onAuthError()
      }
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
