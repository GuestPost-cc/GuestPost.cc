import {
  IntegrationProvider,
  IntegrationSyncStatus,
  IntegrationSyncTrigger,
} from "../../types"
import {
  connectCallbackRequestSchema,
  connectRequestSchema,
  getSyncHistoryRequestSchema,
  linkPropertyRequestSchema,
  listIntegrationsRequestSchema,
  triggerSyncRequestSchema,
} from "../integration.schemas"

describe("connectRequestSchema", () => {
  it("parses valid provider and returnUrl", () => {
    const result = connectRequestSchema.parse({
      provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
      returnUrl: "/dashboard",
    })
    expect(result.provider).toBe(IntegrationProvider.GOOGLE_SEARCH_CONSOLE)
    expect(result.returnUrl).toBe("/dashboard")
  })

  it("uses default returnUrl when not provided", () => {
    const result = connectRequestSchema.parse({
      provider: IntegrationProvider.GOOGLE_ANALYTICS,
    })
    expect(result.returnUrl).toBe("/dashboard")
  })

  it("rejects invalid provider", () => {
    expect(() =>
      connectRequestSchema.parse({ provider: "INVALID_PROVIDER" }),
    ).toThrow()
  })

  it("accepts arbitrary returnUrl strings (relative or absolute)", () => {
    const result = connectRequestSchema.parse({
      provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
      returnUrl: "not-a-url",
    })
    expect(result.returnUrl).toBe("not-a-url")
  })
})

describe("connectCallbackRequestSchema", () => {
  it("parses valid code and state", () => {
    const result = connectCallbackRequestSchema.parse({
      code: "auth-code-123",
      state: "state-nonce",
    })
    expect(result.code).toBe("auth-code-123")
    expect(result.state).toBe("state-nonce")
    expect(result.error).toBeUndefined()
  })

  it("parses error when present", () => {
    const result = connectCallbackRequestSchema.parse({
      code: "auth-code",
      state: "state",
      error: "access_denied",
    })
    expect(result.error).toBe("access_denied")
  })

  it("rejects missing code", () => {
    expect(() =>
      connectCallbackRequestSchema.parse({ state: "nonce" }),
    ).toThrow()
  })

  it("rejects empty code", () => {
    expect(() =>
      connectCallbackRequestSchema.parse({ code: "", state: "nonce" }),
    ).toThrow()
  })
})

describe("linkPropertyRequestSchema", () => {
  it("parses valid externalId and websiteId", () => {
    const result = linkPropertyRequestSchema.parse({
      externalResourceId: "sc-domain:example.com",
      websiteId: "clx123abc",
    })
    expect(result.externalResourceId).toBe("sc-domain:example.com")
    expect(result.websiteId).toBe("clx123abc")
  })

  it("rejects missing externalResourceId", () => {
    expect(() =>
      linkPropertyRequestSchema.parse({
        websiteId: "clx123",
      }),
    ).toThrow()
  })
})

describe("listIntegrationsRequestSchema", () => {
  it("uses defaults when nothing provided", () => {
    const result = listIntegrationsRequestSchema.parse({})
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(20)
    expect(result.status).toBeUndefined()
    expect(result.provider).toBeUndefined()
  })

  it("coerces string numbers", () => {
    const result = listIntegrationsRequestSchema.parse({
      page: "3",
      pageSize: "50",
    })
    expect(result.page).toBe(3)
    expect(result.pageSize).toBe(50)
  })

  it("rejects page less than 1", () => {
    expect(() => listIntegrationsRequestSchema.parse({ page: 0 })).toThrow()
  })

  it("rejects pageSize greater than 100", () => {
    expect(() =>
      listIntegrationsRequestSchema.parse({ pageSize: 101 }),
    ).toThrow()
  })
})

describe("triggerSyncRequestSchema", () => {
  it("uses default trigger when not provided", () => {
    const result = triggerSyncRequestSchema.parse({})
    expect(result.trigger).toBe(IntegrationSyncTrigger.MANUAL)
  })

  it("parses all trigger types", () => {
    for (const trigger of Object.values(IntegrationSyncTrigger)) {
      const result = triggerSyncRequestSchema.parse({ trigger })
      expect(result.trigger).toBe(trigger)
    }
  })

  it("parses optional dates", () => {
    const result = triggerSyncRequestSchema.parse({
      startDate: "2026-07-01T00:00:00Z",
      endDate: "2026-07-07T00:00:00Z",
    })
    expect(result.startDate).toBe("2026-07-01T00:00:00Z")
    expect(result.endDate).toBe("2026-07-07T00:00:00Z")
  })
})

describe("getSyncHistoryRequestSchema", () => {
  it("uses defaults when nothing provided", () => {
    const result = getSyncHistoryRequestSchema.parse({})
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(20)
  })

  it("parses all filter options", () => {
    const result = getSyncHistoryRequestSchema.parse({
      page: "2",
      pageSize: "50",
      status: IntegrationSyncStatus.COMPLETED,
      trigger: IntegrationSyncTrigger.MANUAL,
      dateFrom: "2026-07-01T00:00:00Z",
      dateTo: "2026-07-07T00:00:00Z",
    })
    expect(result.page).toBe(2)
    expect(result.pageSize).toBe(50)
    expect(result.status).toBe(IntegrationSyncStatus.COMPLETED)
    expect(result.trigger).toBe(IntegrationSyncTrigger.MANUAL)
    expect(result.dateFrom).toBe("2026-07-01T00:00:00Z")
    expect(result.dateTo).toBe("2026-07-07T00:00:00Z")
  })
})
