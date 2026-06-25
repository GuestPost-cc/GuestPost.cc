// Request correlation ID propagation via AsyncLocalStorage.
//
// Every inbound HTTP request to the API gets an X-Request-ID (generated if
// absent, validated + echoed if supplied). This ID is stored in ALS for the
// duration of the request so service-layer code, audit log writes, and
// enqueued worker jobs can all read it via getRequestId() without per-callsite
// plumbing.
//
// Worker side: the processor wrapper reads requestId from the signed job
// payload and re-enters the same ALS context, so audit logs the worker writes
// share the same correlation ID as the originating API request.

import { AsyncLocalStorage } from "node:async_hooks"

export interface RequestContext {
  requestId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

// X-Request-ID validation. Accepts UUIDv4, UUIDv7, ULIDs, and any short
// trusted ID composed of ASCII alphanumerics + `_` + `-`, length 1..128.
// Rejects control chars, newlines, non-ASCII, overlong values. Used by the
// API middleware to decide whether to honor a supplied header or generate a
// fresh ID.
//
// Rejection is silent — we never want a malformed header to fail an otherwise
// good request. The header is replaced with a fresh ID; the original is dropped.
const REQUEST_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_REGEX.test(value)
}

export function generateRequestId(): string {
  // crypto.randomUUID() is available in Node 19+ and every supported browser.
  // Observability does not require sortable IDs, so UUIDv4 is sufficient.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  // Last-resort fallback (older Node, exotic runtimes). Not cryptographically
  // ideal but correlation IDs do not need to be unguessable.
  const hex = "0123456789abcdef"
  let out = ""
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-${out.slice(16, 20)}-${out.slice(20, 32)}`
}

// Run `fn` inside an ALS frame carrying the given requestId. Used by:
//   - API middleware (wraps the rest of the request)
//   - Worker processor wrapper (wraps the processor body)
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn)
}

export function getRequestId(): string | null {
  return storage.getStore()?.requestId ?? null
}

export function requireRequestId(): string {
  const id = getRequestId()
  if (!id) {
    throw new Error(
      "[request-context] requireRequestId() called outside any runWithRequestId() frame",
    )
  }
  return id
}

// Reset the storage — exported only for tests. Not part of the runtime API.
export function __resetRequestContext(): void {
  storage.disable()
  storage.enterWith(undefined as unknown as RequestContext)
}
