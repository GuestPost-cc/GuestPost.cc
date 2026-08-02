import type { FetchResult } from "@guestpost/shared/dist/delivery-verification-core"
import { createLogger } from "@guestpost/shared/dist/observability/structured-logger"
import {
  isSafePublicUrl,
  readBodyWithCap,
  SafeFetchError,
  safeFetch,
} from "@guestpost/shared/dist/safe-fetch"

const logger = createLogger("worker.delivery-verification")

// Typical guest-post pages are about 200KB. Five MB is intentionally generous
// for legitimate pages while bounding each verification worker's memory use.
const MAX_HTML_BYTES = 5 * 1024 * 1024

// Resolve redirects manually so every hop receives the same SSRF and
// DNS-rebinding checks. The injectable fetch function keeps this network
// boundary directly testable without weakening the production default.
export async function fetchWithChain(
  startUrl: string,
  fetchUrl: typeof safeFetch = safeFetch,
): Promise<FetchResult> {
  const redirectChain: string[] = []
  let current = startUrl
  let lastStatus = 0
  let lastHeaders: Record<string, string> = {}

  for (let hop = 0; hop < 6; hop++) {
    if (!isSafePublicUrl(current)) {
      return {
        finalUrl: current,
        status: 0,
        headers: {},
        html: "",
        redirectChain,
        error: "unsafe (non-public) URL",
      }
    }

    let response: Response
    try {
      response = await fetchUrl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "GuestPost-DeliveryVerification/1.0" },
      })
    } catch (error: any) {
      const reason =
        error instanceof SafeFetchError
          ? `${error.code}: ${error.message}`
          : (error?.message ?? "fetch failed")
      return {
        finalUrl: current,
        status: 0,
        headers: lastHeaders,
        html: "",
        redirectChain,
        error: reason,
      }
    }

    lastStatus = response.status
    lastHeaders = Object.fromEntries(response.headers.entries())

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) break
      try {
        const next = new URL(location, current).toString()
        redirectChain.push(current)
        current = next
        continue
      } catch {
        break
      }
    }

    const contentLengthHeader = response.headers.get("content-length")
    const parsedLength =
      contentLengthHeader != null ? Number(contentLengthHeader) : undefined
    const contentLength =
      parsedLength !== undefined && Number.isFinite(parsedLength)
        ? parsedLength
        : undefined

    let bodyReadError: string | undefined
    const html = await readBodyWithCap(response, MAX_HTML_BYTES).catch(
      (error: any) => {
        const code =
          error instanceof SafeFetchError ? error.code : "BODY_READ_FAILED"
        bodyReadError = `${code}: ${error?.message ?? "response body read failed"}`
        if (
          error instanceof SafeFetchError &&
          error.code === "BODY_TOO_LARGE"
        ) {
          logger.warn("response body cap exceeded", {
            reason: "body_size_exceeded",
            url: current,
            maxBodySize: MAX_HTML_BYTES,
            contentLength,
          })
        }
        return ""
      },
    )

    return {
      finalUrl: current,
      status: response.status,
      headers: lastHeaders,
      html,
      redirectChain,
      error: bodyReadError,
    }
  }

  return {
    finalUrl: current,
    status: lastStatus || 508,
    headers: lastHeaders,
    html: "",
    redirectChain,
    error: "too many redirects",
  }
}
