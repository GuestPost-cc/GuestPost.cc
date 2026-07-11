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
    // Phase 7.0 — request ID echoed back by the API (response header or
    // generated client-side if the API didn't echo it). Surface in toasts /
    // error reports so a customer can quote it to support.
    public requestId?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

// Phase 7.0 — generate an X-Request-ID per request. crypto.randomUUID() is
// available in every supported browser (Web Crypto) and Node 19+. If absent
// (older runtime), fall back to a Math.random-based UUIDv4 — observability
// does not require cryptographic randomness.
function generateRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  const hex = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`
}

const STORAGE_KEY = "gp:api-token"

let _token: string | null = null

function initToken() {
  if (typeof sessionStorage !== "undefined") {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY)
      if (stored) _token = stored
    } catch {
      /* noop */
    }
  }
}
initToken()

export function setToken(token: string) {
  _token = token
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.setItem(STORAGE_KEY, token)
    } catch {
      /* noop */
    }
  }
}
export function clearToken() {
  _token = null
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(STORAGE_KEY)
    } catch {
      /* noop */
    }
  }
}
export function getToken() {
  return _token
}

/**
 * Heuristic that excludes auth endpoints from the 401 handler. A 401 from
 * `/auth/sign-in/email` means "wrong password", not "session expired";
 * bouncing the user through a redirect would be confusing.
 */
export function isAuthEndpointPath(path: string): boolean {
  return (
    path.includes("/auth/sign-in") ||
    path.includes("/auth/sign-up") ||
    path.includes("/auth/sign-out") ||
    path.includes("/auth/magic-link") ||
    path.includes("/auth/reset-password") ||
    path.includes("/auth/verify-email") ||
    path.includes("/identity/me")
  )
}

export class HttpClient {
  private config: ApiClientConfig

  constructor(config: ApiClientConfig) {
    this.config = config
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(
      path.startsWith("http") ? path : `${this.config.baseUrl}${path}`,
    )
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const { params, body, json, ...rest } = opts
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (_token) headers.Authorization = `Bearer ${_token}`
    // Phase 7.0 — every request carries an X-Request-ID. The API echoes it in
    // the response (or replaces with its own if malformed). On failure we
    // attach it to the ApiError so toasts/error reports can surface it.
    const requestId = generateRequestId()
    headers["X-Request-ID"] = requestId
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

    // If the server rotated our session token, update the in-memory
    // store so subsequent state-changing requests don't lose the Bearer
    // header and trigger the CSRF guard.
    const rotatedToken = res.headers.get("X-Session-Token")
    if (rotatedToken) setToken(rotatedToken)

    const responseRequestId = res.headers.get("X-Request-ID") ?? requestId
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
      if (
        res.status === 401 &&
        this.config.onAuthError &&
        !isAuthEndpointPath(path)
      ) {
        this.config.onAuthError()
      }
      let err: { message?: string; code?: string } = {}
      try {
        err = await res.json()
      } catch {}
      throw new ApiError(
        res.status,
        err.code ?? "UNKNOWN",
        err.message ?? res.statusText,
        responseRequestId,
      )
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
