import {
  buildEmailActionUrl,
  COMMUNICATION_EVENT_POLICIES,
  COMMUNICATION_EVENT_TYPES,
  communicationEventInputSchema,
  isRequiredCommunicationChannel,
  notificationPreferenceDefaults,
  renderCommunicationEmail,
  repairCommunicationOutboxProjections,
  shouldDeliverCommunicationChannel,
} from "../index"

describe("communication contracts", () => {
  it("has an explicit policy for every event type", () => {
    expect(Object.keys(COMMUNICATION_EVENT_POLICIES).sort()).toEqual(
      [...COMMUNICATION_EVENT_TYPES].sort(),
    )
  })

  it("rejects external action URLs and unsafe dedup keys", () => {
    const base = {
      type: "ORDER_ACCEPTED" as const,
      aggregateType: "Order",
      aggregateId: "order-1",
      title: "Accepted",
      message: "Work started",
      recipientUserIds: ["user-1"],
    }
    expect(() =>
      communicationEventInputSchema.parse({
        ...base,
        actionPath: "https://evil.example/steal",
        dedupKey: "safe-key",
      }),
    ).toThrow()
    expect(() =>
      communicationEventInputSchema.parse({
        ...base,
        actionPath: "/dashboard/orders/order-1",
        dedupKey: "unsafe key with spaces",
      }),
    ).toThrow()
  })

  it("keeps mandatory financial deliveries required", () => {
    expect(
      isRequiredCommunicationChannel("ORDER_PAYMENT_CAPTURED", "EMAIL"),
    ).toBe(true)
    expect(
      isRequiredCommunicationChannel("SETTLEMENT_RELEASED", "IN_APP"),
    ).toBe(true)
    expect(
      notificationPreferenceDefaults().find(
        (preference) => preference.category === "SECURITY",
      )?.mutable,
    ).toBe(false)
    expect(
      COMMUNICATION_EVENT_POLICIES.ORDER_PAYMENT_CAPTURED.actorRecipientPolicy,
    ).toBe("INCLUDE_IF_LISTED")
    expect(
      COMMUNICATION_EVENT_POLICIES.ORDER_REFUNDED.actorRecipientPolicy,
    ).toBe("INCLUDE_IF_LISTED")
    expect(
      isRequiredCommunicationChannel("ORDER_SECURITY_REVIEW_DECIDED", "IN_APP"),
    ).toBe(true)
    expect(
      isRequiredCommunicationChannel("PUBLISHER_COMPENSATION_DECIDED", "EMAIL"),
    ).toBe(true)
    expect(
      COMMUNICATION_EVENT_POLICIES.PUBLISHER_COMPENSATION_DECIDED
        .actorRecipientPolicy,
    ).toBe("INCLUDE_IF_LISTED")
  })

  it("rechecks optional opt-outs while preserving required deliveries", () => {
    expect(
      shouldDeliverCommunicationChannel("ORDER_ACCEPTED", "EMAIL", false),
    ).toBe(false)
    expect(
      shouldDeliverCommunicationChannel(
        "ORDER_PAYMENT_CAPTURED",
        "EMAIL",
        false,
      ),
    ).toBe(true)
  })
})

describe("transactional email rendering", () => {
  it("builds only trusted application URLs", () => {
    expect(
      buildEmailActionUrl(
        "https://app.guestpost.cc",
        "/dashboard/orders/order-1",
      ),
    ).toBe("https://app.guestpost.cc/dashboard/orders/order-1")
    expect(() =>
      buildEmailActionUrl("https://app.guestpost.cc", "//evil.example"),
    ).toThrow(/unsafe/i)
    expect(() =>
      buildEmailActionUrl("http://app.guestpost.cc", "/dashboard"),
    ).toThrow(/https/i)
  })

  it("escapes untrusted content and emits HTML plus plain text", () => {
    const rendered = renderCommunicationEmail({
      eventType: "SUPPORT_PUBLIC_REPLY",
      recipientName: "<Admin>",
      title: "Reply\r\nBcc: attacker@example.com",
      message: '<script>alert("x")</script>',
      severity: "WARNING",
      actionUrl: "https://app.guestpost.cc/dashboard/support/ticket-1",
    })
    expect(rendered.subject).not.toContain("\n")
    expect(rendered.html).not.toContain("<script>")
    expect(rendered.html).toContain("&lt;script&gt;")
    expect(rendered.html).toContain("&lt;Admin&gt;")
    expect(rendered.text).toContain("dashboard/support/ticket-1")
  })
})

describe("validated historical projection repair", () => {
  it("repairs the listed financial actor without replacing the immutable event", async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "legacy-event" }]),
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "customer-1",
            email: "customer@example.com",
            emailVerified: true,
            banned: false,
            notificationPreferences: [{ channel: "EMAIL", enabled: false }],
            emailSuppressions: [],
          },
        ]),
      },
      notification: { upsert: jest.fn().mockResolvedValue({}) },
      communicationDelivery: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: "delivery-1", status: "PENDING" }),
        count: jest.fn().mockResolvedValue(1),
      },
      communicationEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    }

    const result = await repairCommunicationOutboxProjections(
      db,
      {
        id: "legacy-event",
        type: "ORDER_REFUNDED",
        category: "BILLING",
        severity: "WARNING",
        organizationId: "org-1",
        title: "Order refund completed",
        message: "100.00 USD was returned to your wallet.",
        actionPath: "/dashboard/orders/order-1",
      },
      ["customer-1"],
      "customer-1",
    )

    expect(result).toEqual({
      eventId: "legacy-event",
      deliveryIds: ["delivery-1"],
    })
    expect(db.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: "customer-1" }),
      }),
    )
    expect(db.communicationDelivery.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "customer-1",
          status: "PENDING",
        }),
      }),
    )
  })
})
