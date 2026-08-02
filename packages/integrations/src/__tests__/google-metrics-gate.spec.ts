jest.mock("@guestpost/database", () => ({
  createPrismaClient: () => ({}),
}))

import { GoogleMetricsDisabledError } from "../errors"
import { assertGoogleMetricsEnabled } from "../google-metrics-gate"
import { GoogleAnalyticsProvider } from "../providers/google-analytics.provider"
import { GoogleSearchConsoleProvider } from "../providers/google-search-console.provider"

describe("Google marketplace metrics quarantine", () => {
  it("uses a stable fail-closed integration error", () => {
    expect(() => assertGoogleMetricsEnabled()).toThrow(
      GoogleMetricsDisabledError,
    )
    try {
      assertGoogleMetricsEnabled()
    } catch (error) {
      expect(error).toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    }
  })

  it.each([
    ["GSC", new GoogleSearchConsoleProvider()],
    ["GA4", new GoogleAnalyticsProvider()],
  ])("blocks %s discovery before provider I/O", async (_name, provider) => {
    const fetchSpy = jest.spyOn(global, "fetch")

    await expect(
      provider.discoverResources("must-not-be-used"),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it.each([
    ["GSC", new GoogleSearchConsoleProvider(), "sc-domain:other.example"],
    ["GA4", new GoogleAnalyticsProvider(), "123456789"],
  ])("blocks stale %s sync jobs before provider or database work", async (_name, provider, resourceId) => {
    const fetchSpy = jest.spyOn(global, "fetch")

    await expect(
      provider.sync(
        "must-not-be-used",
        resourceId,
        undefined,
        undefined,
        "stale-link-id",
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_METRICS_DISABLED" })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
