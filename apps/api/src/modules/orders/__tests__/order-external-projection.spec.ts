import {
  projectExternalCancellationRequest,
  projectExternalOrder,
} from "../order-visibility"
import { OrdersService } from "../orders.service"

describe("external order projection", () => {
  const internalOrder = {
    id: "order-1",
    customerId: "customer-1",
    organizationId: "organization-secret",
    assigneeId: "assignee-secret",
    verifiedBy: "verifier-secret",
    activeDeliveryVersionId: "delivery-secret",
    idempotencyKey: "idempotency-secret",
    requestFingerprint: "fingerprint-secret",
    settlementGateVersion: 7,
    version: 3,
    type: "GUEST_POST",
    status: "CUSTOMER_REVIEW",
    amount: "125.00",
    currency: "USD",
    paymentStatus: "PAID",
    title: "Guest post",
    instructions: "Follow the brief",
    targetUrl: "https://customer.example/landing",
    anchorText: "customer link",
    publishedUrl: "https://publisher.example/article",
    campaignId: "campaign-1",
    autoAcceptAt: new Date("2026-08-04T00:00:00.000Z"),
    verifyMethod: "HTTP",
    deliveryAcceptedMethod: null,
    turnaroundDays: 7,
    submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    acceptedAt: new Date("2026-08-01T01:00:00.000Z"),
    fulfillmentDueAt: new Date("2026-08-08T00:00:00.000Z"),
    warrantyEndsAt: new Date("2026-09-08T00:00:00.000Z"),
    briefData: { topic: "security" },
    fulfillmentChannel: "PUBLISHER",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    futureInternalColumn: "future-secret",
    reports: [{ id: "report-secret" }],
    campaign: {
      id: "campaign-1",
      name: "Launch",
      organizationId: "campaign-organization-secret",
    },
    website: {
      id: "website-1",
      name: "Publisher site",
      url: "https://publisher.example",
      domain: "publisher.example",
      publisherId: "publisher-secret",
      managedByUserId: "manager-secret",
      verificationToken: "verification-token-secret",
      activeVerifiedToken: "active-verification-token-secret",
      trustScore: 88,
      metrics: { private: true },
    },
    items: [
      {
        id: "item-1",
        orderId: "order-1",
        publisherId: "item-publisher-secret",
        websiteId: "website-1",
        targetUrl: "https://customer.example/landing",
        anchorText: "customer link",
        price: "125.00",
        status: "CUSTOMER_REVIEW",
        internalItemField: "item-secret",
        website: {
          id: "website-1",
          name: "Publisher site",
          url: "https://publisher.example",
          verificationToken: "nested-verification-secret",
          trustScore: 88,
        },
        publications: [
          {
            id: "publication-1",
            orderItemId: "item-1",
            publishedUrl: "https://publisher.example/article",
            targetUrl: "https://customer.example/landing",
            anchorText: "customer link",
            screenshotUrl: "https://cdn.example/screenshot.png",
            publicationDate: new Date("2026-08-02T00:00:00.000Z"),
            verificationStatus: "VERIFIED",
            verifiedBy: "publication-verifier-secret",
            verifiedAt: new Date("2026-08-02T01:00:00.000Z"),
          },
        ],
      },
    ],
    events: [
      {
        id: "event-1",
        eventType: "PAYMENT_CAPTURED",
        actorId: "event-actor-secret",
        message: "Internal provider response",
        metadata: {
          amount: "125.00",
          currency: "USD",
          providerRef: "provider-reference-secret",
        },
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ],
    contentOrder: {
      id: "content-1",
      orderId: "order-1",
      title: "Draft",
      brief: "Brief",
      deliverable: "Article",
      status: "DELIVERED",
      internalWorkflowState: "content-secret",
    },
    articleVersions: [
      {
        id: "article-1",
        orderId: "order-1",
        version: 1,
        source: "PUBLISHER",
        purpose: "FINAL_SUBMISSION",
        title: "Article",
        body: "Body",
        format: "MARKDOWN",
        checksum: "a".repeat(64),
        wordCount: 1,
        createdByUserId: "article-author-secret",
        supersedesId: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ],
    revisions: [
      {
        id: "revision-1",
        orderId: "order-1",
        notes: "Please revise",
        files: null,
        status: "REQUESTED",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T01:00:00.000Z"),
        internalRevisionField: "revision-secret",
      },
    ],
    dispute: {
      id: "dispute-1",
      orderId: "order-1",
      raisedBy: "dispute-raiser-secret",
      reason: "Delivery mismatch",
      status: "OPEN",
      previousStatus: "CUSTOMER_REVIEW",
      resolvedBy: "dispute-resolver-secret",
      resolvedAt: null,
      resolution: null,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    },
    cancellationRequests: [
      {
        id: "cancellation-1",
        orderId: "order-1",
        requestedByUserId: "cancellation-requester-secret",
        requesterType: "CUSTOMER",
        actorSnapshot: {
          userId: "snapshot-user-secret",
          customerRole: "OWNER",
        },
        reasonCode: "CUSTOMER_CHANGED_MIND",
        note: "Please cancel",
        status: "PENDING_FINANCE",
        previousOrderStatus: "CUSTOMER_REVIEW",
        fulfillmentChannel: "PUBLISHER",
        responsibility: "CUSTOMER",
        requestedResolution: "FULL_REFUND",
        responseDeadlineAt: new Date("2026-08-03T00:00:00.000Z"),
        respondedByUserId: "cancellation-responder-secret",
        responseNote: "Accepted",
        reviewedByUserId: "cancellation-reviewer-secret",
        financeApprovedByUserId: "finance-approver-secret",
        resolution: "FULL_REFUND",
        resolutionReason: "Internal finance rationale",
        refundTransactionId: "refund-transaction-secret",
        idempotencyKey: "cancellation-idempotency-secret",
        resolvedAt: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T01:00:00.000Z"),
      },
    ],
    settlements: [
      {
        id: "settlement-1",
        publisherId: "settlement-publisher-secret",
        status: "PENDING",
        grossAmount: "125.00",
        platformFee: "25.00",
        publisherAmount: "100.00",
        releasePolicy: "MANUAL",
        reviewEndsAt: null,
        releasedAt: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        approvals: [{ approvedBy: "settlement-approver-secret" }],
      },
    ],
  }

  it("uses an explicit customer allowlist at the root and every nested relation", () => {
    const projected = projectExternalOrder(internalOrder, "CUSTOMER", false)

    expect(projected.website).toEqual({
      id: "website-1",
      name: "Publisher site",
      url: null,
      access: {
        unlocked: false,
        reason: "FIRST_DEPOSIT_REQUIRED",
      },
    })
    expect(projected.items[0]).toEqual({
      id: "item-1",
      websiteId: "website-1",
      targetUrl: "https://customer.example/landing",
      anchorText: "customer link",
      price: "125.00",
      status: "CUSTOMER_REVIEW",
      website: {
        id: "website-1",
        name: "Publisher site",
        url: null,
        access: {
          unlocked: false,
          reason: "FIRST_DEPOSIT_REQUIRED",
        },
      },
      publications: [
        {
          id: "publication-1",
          publishedUrl: "https://publisher.example/article",
          targetUrl: "https://customer.example/landing",
          anchorText: "customer link",
          screenshotUrl: "https://cdn.example/screenshot.png",
          publicationDate: new Date("2026-08-02T00:00:00.000Z"),
          verificationStatus: "VERIFIED",
        },
      ],
    })
    expect(projected.articleVersions).toEqual([
      {
        id: "article-1",
        version: 1,
        source: "PUBLISHER",
        purpose: "FINAL_SUBMISSION",
        title: "Article",
        body: "Body",
        format: "MARKDOWN",
        checksum: "a".repeat(64),
        wordCount: 1,
        supersedesId: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ])
    expect(projected.dispute).toEqual({
      id: "dispute-1",
      reason: "Delivery mismatch",
      status: "OPEN",
      resolvedAt: null,
      resolution: null,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    })
    expect(projected.cancellationRequests).toEqual([
      {
        id: "cancellation-1",
        orderId: "order-1",
        requesterType: "CUSTOMER",
        reasonCode: "CUSTOMER_CHANGED_MIND",
        note: "Please cancel",
        status: "PENDING_FINANCE",
        responsibility: "CUSTOMER",
        responseDeadlineAt: new Date("2026-08-03T00:00:00.000Z"),
        responseNote: "Accepted",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ])
    expect(projected.settlements).toEqual([])

    const serialized = JSON.stringify(projected)
    for (const secret of [
      "organization-secret",
      "assignee-secret",
      "verifier-secret",
      "delivery-secret",
      "idempotency-secret",
      "fingerprint-secret",
      "future-secret",
      "report-secret",
      "verification-token-secret",
      "active-verification-token-secret",
      "manager-secret",
      "item-publisher-secret",
      "nested-verification-secret",
      "publication-verifier-secret",
      "event-actor-secret",
      "provider-reference-secret",
      "content-secret",
      "article-author-secret",
      "revision-secret",
      "dispute-raiser-secret",
      "dispute-resolver-secret",
      "snapshot-user-secret",
      "cancellation-requester-secret",
      "cancellation-responder-secret",
      "cancellation-reviewer-secret",
      "finance-approver-secret",
      "refund-transaction-secret",
      "cancellation-idempotency-secret",
      "settlement-publisher-secret",
      "settlement-approver-secret",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("applies the nested allowlist to the authenticated get-order path", async () => {
    const prisma = {
      order: { findFirst: jest.fn().mockResolvedValue(internalOrder) },
      depositAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
    }

    const projected = await new OrdersService(prisma as any).getOrder(
      "order-1",
      "organization-1",
      "CUSTOMER",
    )
    const serialized = JSON.stringify(projected)

    expect(projected.id).toBe("order-1")
    expect(projected.website.url).toBeNull()
    expect(serialized).not.toContain("verification-token-secret")
    expect(serialized).not.toContain("article-author-secret")
    expect(serialized).not.toContain("snapshot-user-secret")
    expect(serialized).not.toContain("refund-transaction-secret")
    expect(serialized).not.toContain("dispute-resolver-secret")
  })

  it("reveals only the contracted website and settlement fields to publishers", () => {
    const projected = projectExternalOrder(internalOrder, "PUBLISHER")

    expect(projected.website).toEqual({
      id: "website-1",
      name: "Publisher site",
      url: "https://publisher.example",
    })
    expect(projected.settlements).toEqual([
      {
        id: "settlement-1",
        status: "PENDING",
        grossAmount: "125.00",
        platformFee: "25.00",
        publisherAmount: "100.00",
        releasePolicy: "MANUAL",
        reviewEndsAt: null,
        releasedAt: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ])
    expect(JSON.stringify(projected)).not.toContain(
      "settlement-approver-secret",
    )
  })

  it("projects standalone cancellation responses to the public contract", () => {
    const projected = projectExternalCancellationRequest(
      internalOrder.cancellationRequests[0],
    )

    expect(projected).toEqual({
      id: "cancellation-1",
      orderId: "order-1",
      requesterType: "CUSTOMER",
      reasonCode: "CUSTOMER_CHANGED_MIND",
      note: "Please cancel",
      status: "PENDING_FINANCE",
      responsibility: "CUSTOMER",
      responseDeadlineAt: new Date("2026-08-03T00:00:00.000Z"),
      responseNote: "Accepted",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    })
  })
})
