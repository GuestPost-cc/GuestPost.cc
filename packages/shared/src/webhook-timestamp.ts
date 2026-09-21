export class WebhookTimestampError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookTimestampError"
  }
}

const MAX_FUTURE_TIMESTAMP_SKEW_SECONDS = 60

export function assertWebhookTimestampFresh(
  timestamp: string | number | Date | undefined | null,
  toleranceSeconds: number,
): void {
  if (timestamp == null) {
    throw new WebhookTimestampError("Missing webhook timestamp")
  }

  let epochSeconds: number
  if (typeof timestamp === "number") {
    epochSeconds = timestamp
  } else if (typeof timestamp === "string") {
    // Try numeric epoch string first (e.g. Stripe "1749128789"), then ISO 8601
    const asNumber = Number(timestamp)
    if (Number.isFinite(asNumber)) {
      epochSeconds = asNumber
    } else {
      const d = new Date(timestamp)
      epochSeconds = d.getTime() / 1000
    }
  } else {
    epochSeconds = timestamp.getTime() / 1000
  }

  if (!Number.isFinite(epochSeconds)) {
    throw new WebhookTimestampError("Invalid webhook timestamp")
  }

  const ageSeconds = Date.now() / 1000 - epochSeconds
  if (ageSeconds > toleranceSeconds) {
    throw new WebhookTimestampError(
      `Webhook timestamp outside tolerance (${Math.round(ageSeconds)}s > ${toleranceSeconds}s)`,
    )
  }
  if (ageSeconds < -MAX_FUTURE_TIMESTAMP_SKEW_SECONDS) {
    throw new WebhookTimestampError(
      `Webhook timestamp is too far in the future (${Math.round(-ageSeconds)}s > ${MAX_FUTURE_TIMESTAMP_SKEW_SECONDS}s)`,
    )
  }
}
