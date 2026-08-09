import type { Request } from "express"
import rateLimit from "express-rate-limit"

export const WEBHOOK_INGRESS_RATE_LIMIT_CEILING = 10_000

export const SIGNED_WEBHOOK_INGRESS_PATHS = [
  "/api/v1/billing/webhook/stripe",
  "/api/v1/payout-webhooks/stripe_connect/platform",
  "/api/v1/payout-webhooks/stripe_connect/connected",
  "/api/v1/payout-webhooks/wise",
] as const

const signedWebhookIngressPathSet = new Set<string>(
  SIGNED_WEBHOOK_INGRESS_PATHS,
)

type WebhookIngressRequest = Pick<Request, "method" | "originalUrl">

/**
 * Classifies only canonical signed-provider POST endpoints.
 *
 * `originalUrl` is intentionally compared without URL decoding or path
 * normalization. That keeps mount-relative paths, lookalike prefixes, encoded
 * separators, trailing slashes, and the retired shared Stripe route on the
 * ordinary API limiter.
 */
export function isSignedWebhookIngressRequest(
  req: WebhookIngressRequest,
): boolean {
  if (req.method.toUpperCase() !== "POST") return false

  const queryIndex = req.originalUrl.indexOf("?")
  const rawPath =
    queryIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, queryIndex)

  return signedWebhookIngressPathSet.has(rawPath)
}

export function createWebhookIngressLimiter(max: number) {
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > WEBHOOK_INGRESS_RATE_LIMIT_CEILING
  ) {
    throw new RangeError(
      `Webhook ingress rate limit must be an integer between 1 and ${WEBHOOK_INGRESS_RATE_LIMIT_CEILING}`,
    )
  }

  return rateLimit({
    windowMs: 60 * 1000,
    max,
    // Signature verification happens in the controllers. Invalid signatures
    // still consume this finite per-IP budget so forged traffic is not free.
    skip: (req: Request) => !isSignedWebhookIngressRequest(req),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      statusCode: 429,
      message: "Too many webhook requests from this IP, try again later",
    },
  })
}
