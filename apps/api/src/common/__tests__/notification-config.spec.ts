import { notificationFlag, notificationThreshold } from "../notification-config"

describe("notification configuration", () => {
  const key = "TEST_NOTIFICATION_THRESHOLD"
  const flagKey = "TEST_NOTIFICATION_FLAG"

  afterEach(() => {
    delete process.env[key]
    delete process.env[flagKey]
  })

  it("falls back instead of silently disabling alerts on invalid values", () => {
    process.env[key] = "not-a-number"
    process.env[flagKey] = "maybe"
    expect(notificationThreshold(key, 500)).toBe(500)
    expect(notificationFlag(flagKey, true)).toBe(true)
  })

  it("accepts bounded thresholds and explicit booleans", () => {
    process.env[key] = "250.50"
    process.env[flagKey] = "false"
    expect(notificationThreshold(key, 500)).toBe(250.5)
    expect(notificationFlag(flagKey, true)).toBe(false)
  })
})
