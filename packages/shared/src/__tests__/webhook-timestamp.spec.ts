import {
  assertWebhookTimestampFresh,
  WebhookTimestampError,
} from "../webhook-timestamp"

describe("assertWebhookTimestampFresh", () => {
  const TOLERANCE = 300
  const FIXED_NOW = new Date("2026-07-06T12:00:00Z")

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("accepts a timestamp within tolerance (100s)", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() - 100_000).toISOString(),
        TOLERANCE,
      ),
    ).not.toThrow()
  })

  it("rejects a timestamp far outside tolerance (600s)", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() - 600_000).toISOString(),
        TOLERANCE,
      ),
    ).toThrow(WebhookTimestampError)
  })

  // ─── Boundary: just inside (299s) ──────────────────────────────

  it("accepts at 299s past", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() - 299_000).toISOString(),
        TOLERANCE,
      ),
    ).not.toThrow()
  })

  it("accepts at 299s future", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() + 299_000).toISOString(),
        TOLERANCE,
      ),
    ).not.toThrow()
  })

  // ─── Boundary: exactly at tolerance (300s) ─────────────────────

  it("accepts at exactly 300s past", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() - 300_000).toISOString(),
        TOLERANCE,
      ),
    ).not.toThrow()
  })

  it("accepts at exactly 300s future", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() + 300_000).toISOString(),
        TOLERANCE,
      ),
    ).not.toThrow()
  })

  // ─── Boundary: just outside (301s) ─────────────────────────────

  it("rejects at 301s past", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() - 301_000).toISOString(),
        TOLERANCE,
      ),
    ).toThrow(WebhookTimestampError)
  })

  it("rejects at 301s future", () => {
    expect(() =>
      assertWebhookTimestampFresh(
        new Date(Date.now() + 301_000).toISOString(),
        TOLERANCE,
      ),
    ).toThrow(WebhookTimestampError)
  })

  // ─── Input type: numeric epoch (Stripe format) ─────────────────

  it("accepts numeric epoch seconds (number)", () => {
    const epoch = Math.floor(Date.now() / 1000) - 100
    expect(() => assertWebhookTimestampFresh(epoch, TOLERANCE)).not.toThrow()
  })

  it("accepts numeric epoch string (Stripe header format)", () => {
    const epoch = String(Math.floor(Date.now() / 1000) - 100)
    expect(() => assertWebhookTimestampFresh(epoch, TOLERANCE)).not.toThrow()
  })

  it("accepts Date object", () => {
    expect(() =>
      assertWebhookTimestampFresh(new Date(Date.now() - 100_000), TOLERANCE),
    ).not.toThrow()
  })

  // ─── Edge inputs ───────────────────────────────────────────────

  it("rejects undefined", () => {
    expect(() => assertWebhookTimestampFresh(undefined, TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })

  it("rejects null", () => {
    expect(() => assertWebhookTimestampFresh(null, TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })

  it("rejects empty string", () => {
    expect(() => assertWebhookTimestampFresh("", TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })

  it("rejects non-numeric, non-date string", () => {
    expect(() => assertWebhookTimestampFresh("not-a-date", TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })

  it("rejects impossible date string", () => {
    expect(() =>
      assertWebhookTimestampFresh("2026-99-99T00:00:00Z", TOLERANCE),
    ).toThrow(WebhookTimestampError)
  })

  it("rejects NaN", () => {
    expect(() => assertWebhookTimestampFresh(NaN, TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })

  it("rejects negative epoch", () => {
    expect(() => assertWebhookTimestampFresh(-1000, TOLERANCE)).toThrow(
      WebhookTimestampError,
    )
  })
})
