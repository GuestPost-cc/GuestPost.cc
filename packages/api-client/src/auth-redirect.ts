// Phase 6.8 — Audit finding #7 closure.
//
// Shared 401-handling for the three dashboard apps (portal / publisher /
// admin). Each app calls `buildAuthErrorHandler(...)` and passes the result
// into `createApiClient({ onAuthError })`. The HttpClient invokes it on a 401
// from a NON-auth endpoint, after clearing the in-memory token.
//
// Why a shared factory: every app needs the same security-sensitive logic
// (sanitize returnTo, idempotency dedup, skip when already on sign-in,
// best-effort clear of any client cache). Three copies would drift; one
// drift = one open-redirect vuln or one infinite redirect loop.

import { clearToken } from "./client"

export interface AuthErrorHandlerConfig {
  /**
   * Where the app's sign-in page lives. `/` for portal/publisher/admin (their
   * sign-in IS the root). Used both for the redirect target and for the
   * same-page debounce — if `window.location.pathname` already matches,
   * the redirect is skipped to prevent loops.
   */
  signInPath: string

  /**
   * Optional callback fired before redirect. Apps use this to clear their
   * TanStack QueryClient cache so a back-button after re-auth doesn't flash
   * the previous user's data. Errors are swallowed — cleanup must not block
   * the redirect.
   */
  onBeforeRedirect?: () => void

  /**
   * Reason banner text. The sign-in page can read this from
   * `sessionStorage.getItem("guestpost:auth-redirect-reason")` and surface a
   * one-line explanation ("Your session expired — sign in to continue.")
   * rather than leaving the user to guess why they bounced.
   *
   * Defaults to the standard expired-session copy.
   */
  reason?: string
}

// Module-level guard. Multiple in-flight 401s (common: a dashboard page
// firing 5 parallel queries) would otherwise each call `onAuthError` and
// each navigate — visible as a flicker or a stuck loading state. The flag
// is reset on next page load (the redirect kills the runtime).
let redirecting = false

// Reset hook exposed for tests only. Production code never calls this.
export function __resetAuthRedirectGuard() {
  redirecting = false
}

/**
 * Sanitize a candidate returnTo path so we never honor an attacker-controlled
 * cross-origin redirect. The rules:
 *   - Must be a relative path (begins with `/` but not `//`).
 *   - Protocol-relative (`//evil.com`), absolute (`http://...`), and
 *     scheme handlers (`javascript:`, `data:`, `mailto:`) are rejected.
 *   - Path component is preserved with its search string + hash; nothing
 *     beyond the origin slips through.
 *
 * Returns a safe path. If the input is unsafe, returns `null` so the caller
 * can decide whether to fall back to the dashboard root or omit returnTo.
 */
export function sanitizeReturnTo(
  candidate: string | null | undefined,
): string | null {
  if (!candidate || typeof candidate !== "string") return null
  // Cheap rejects: protocol-relative + absolute + obvious scheme handlers.
  // `URL` parsing below would catch most of these but explicit checks beat
  // relying on parser quirks (e.g., Chrome vs Firefox URL constructor edge
  // cases historically differed on backslashes).
  if (candidate.startsWith("//")) return null
  if (candidate.startsWith("\\")) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null
  if (!candidate.startsWith("/")) return null

  try {
    // Use a placeholder origin so we can extract just the path. If the input
    // somehow expanded to a different origin, we reject.
    const placeholder = "https://__guestpost_placeholder.invalid"
    const url = new URL(candidate, placeholder)
    if (url.origin !== placeholder) return null
    return url.pathname + url.search + url.hash
  } catch {
    return null
  }
}

/**
 * Heuristic: which API paths should NOT trigger the 401 handler?
 *
 * The auth endpoints themselves return 401 in the happy path of "user
 * typed the wrong password" — bouncing them through the redirect would
 * be confusing. The session-introspection endpoint `/identity/me` also
 * returns 401 on first load when the user genuinely IS signed out, and
 * the AuthProvider catches that to render the sign-in page anyway.
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

/**
 * Build the `onAuthError` callback that `HttpClient` will invoke on a 401
 * from a non-auth endpoint. The callback:
 *
 *   1. Acquires the module-level redirect guard (no-op if already running).
 *   2. Clears the in-memory bearer token (clientside).
 *   3. Runs the optional app-provided cleanup hook (typically
 *      `queryClient.clear()`).
 *   4. Persists the reason banner to `sessionStorage` so the sign-in page
 *      can surface it.
 *   5. If the user is already on the sign-in page, no-ops (debounce).
 *   6. Builds a sanitized `returnTo` query param and navigates via
 *      `window.location.assign`. Full-page nav (not `router.push`) so any
 *      lingering React state / Service Worker / in-memory cache is
 *      flushed by the page reload.
 */
export function buildAuthErrorHandler(
  config: AuthErrorHandlerConfig,
): () => void {
  const {
    signInPath,
    onBeforeRedirect,
    reason = "Your session expired. Sign in to continue.",
  } = config

  return () => {
    if (redirecting) return
    redirecting = true

    // (1) Clear token IMMEDIATELY so any concurrent in-flight fetch from this
    // tick stops sending the stale Authorization header.
    try {
      clearToken()
    } catch {
      /* swallow — never block redirect on cleanup */
    }

    // SSR guard. Server components should never trigger this path, but if a
    // misconfigured server fetch slips through, exit silently.
    if (typeof window === "undefined") return

    // (2) App cleanup hook (cache clear).
    try {
      onBeforeRedirect?.()
    } catch {
      /* swallow */
    }

    // (3) Stash reason so the sign-in page can render a banner.
    try {
      sessionStorage.setItem("guestpost:auth-redirect-reason", reason)
    } catch {
      /* private mode */
    }

    // (4) Same-page debounce — never push the user back onto the sign-in
    // page if they're already there. Trim trailing slash for safety.
    const here = window.location.pathname.replace(/\/$/, "") || "/"
    const target = signInPath.replace(/\/$/, "") || "/"
    if (here === target) {
      redirecting = false
      return
    }

    // (5) Compose returnTo from the current path + search (NEVER the hash —
    // hashes can carry tokens from OAuth flows that we shouldn't echo back).
    const current = window.location.pathname + window.location.search
    const safe = sanitizeReturnTo(current)
    const query =
      safe && safe !== signInPath ? `?returnTo=${encodeURIComponent(safe)}` : ""

    // (6) Full page nav, NOT router.push. Ensures React state, in-memory
    // caches, and any inadvertent module-level singletons are wiped.
    window.location.assign(`${signInPath}${query}`)
  }
}
