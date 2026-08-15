/**
 * Delivery intervention — manual approve/reject/override permissions + reason
 * enforcement + status guards + revision request. Pure service unit tests with
 * mocked prisma/audit/queue.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from "@nestjs/common"
import { DeliveryInterventionService } from "../services/delivery-intervention.service"

describe("DeliveryInterventionService", () => {
  let svc: DeliveryInterventionService
  let prisma: any
  let audit: any
  let queue: any
  let communications: any

  const order = {
    id: "o1",
    organizationId: "org1",
    customerId: "c1",
    status: "PUBLISHED",
    websiteId: "w1",
    website: { publisherId: "pub1", ownershipType: "PUBLISHER" },
    version: 1,
    activeDeliveryVersionId: "v1",
    publishedUrl: "https://x.com/p",
  }

  function versionWith(status: string) {
    return {
      id: "v1",
      orderId: "o1",
      publishedUrl: "https://x.com/p",
      verificationStatus: status,
      verificationVersion: 0,
      supersededByVersion: null,
    }
  }

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    queue = { addJob: jest.fn().mockResolvedValue(undefined) }
    communications = {
      customerOrderRecipients: jest.fn().mockResolvedValue(["c1"]),
      publisherRecipients: jest.fn().mockResolvedValue(["pub-user"]),
      staffRecipients: jest.fn().mockResolvedValue(["finance-1", "admin-1"]),
      record: jest.fn().mockResolvedValue({ eventId: "event-1" }),
      dispatchManyByDedupKeyBestEffort: jest.fn(),
    }
    prisma = {
      orderDeliveryVersion: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        findFirst: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publisherMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "pub-user" }]),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
      deliveryFraudFlagResolution: {
        create: jest.fn().mockResolvedValue({ id: "fraud-resolution-1" }),
      },
      deliveryFraudFinding: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: "fraud-finding-1",
          ...data,
        })),
      },
      orderCancellationRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: "cancellation-1",
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
          ...data,
        })),
      },
      deliveryFraudHold: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      staffMembership: {
        findUnique: jest.fn().mockResolvedValue({
          role: "OPERATIONS",
          user: { userType: "STAFF", banned: false },
        }),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      revision: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "o1" }]),
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(prisma)),
    }
    svc = new DeliveryInterventionService(
      prisma as any,
      audit as any,
      queue as any,
      communications as any,
    )
  })

  const reason = "this is a sufficiently long reason"
  const confirmationIdempotencyKey = "123e4567-e89b-42d3-a456-426614174000"

  describe("manualApprove", () => {
    it("approves a FAILED delivery with a valid reason + audits", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      const r = await svc.manualApprove("v1", "u1", "OPERATIONS", reason)
      expect(r.status).toBe("VERIFIED")
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ interventionStatus: "APPROVED" }),
        }),
      )
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_DELIVERY_MANUAL_APPROVED" }),
        prisma,
      )
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.orderDeliveryVersion.updateMany.mock.invocationCallOrder[0],
      )
    })
    it("rejects a short reason", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      await expect(
        svc.manualApprove("v1", "u1", "OPERATIONS", "too short"),
      ).rejects.toThrow(BadRequestException)
    })
    it("refuses to approve a VERIFIED delivery", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("VERIFIED"),
      )
      await expect(
        svc.manualApprove("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(BadRequestException)
    })

    it("blocks approval until fraud holds are explicitly adjudicated", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.deliveryFraudHold.findMany.mockResolvedValue([
        {
          fraudFlagId: "flag-1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
        },
      ])

      await expect(
        svc.manualApprove("v1", "u1", "OPERATIONS", reason),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_REVIEW_REQUIRED",
        }),
      })

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })
  })

  describe("confirmFraudFlag", () => {
    const confirmation = {
      reason: "Operations confirmed the delivery integrity violation.",
      expectedOrderVersion: 1,
      expectedVerificationVersion: 0,
      idempotencyKey: confirmationIdempotencyKey,
    }

    function unresolvedFlag(extra: Record<string, unknown> = {}) {
      return {
        id: "flag-1",
        orderId: "o1",
        deliveryVersionId: "v1",
        type: "URL_REUSED",
        finding: null,
        resolution: null,
        hold: {
          fraudFlagId: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
        },
        ...extra,
      }
    }

    function prepareConfirmation(flag = unresolvedFlag()) {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce(flag)
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("MANUAL_REVIEW"),
      )
    }

    it("records one confirmed finding and durable audience-safe communications", async () => {
      prepareConfirmation()

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).resolves.toEqual({
        status: "CONFIRMED",
        replayed: false,
        fraudFlagId: "flag-1",
        findingId: "fraud-finding-1",
        cancellationRequestId: "cancellation-1",
      })

      expect(prisma.orderCancellationRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: "o1",
          requesterType: "STAFF",
          reasonCode: "LEGAL_OR_SECURITY_EMERGENCY",
          status: "ESCALATED",
          previousOrderStatus: "PUBLISHED",
          fulfillmentChannel: "PUBLISHER",
          responsibility: "UNDETERMINED",
          requestedResolution: "FULL_REFUND",
          idempotencyKey: "delivery-fraud-confirmation:flag-1",
        }),
      })

      expect(prisma.deliveryFraudFinding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fraudFlagId: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          cancellationRequestId: "cancellation-1",
          outcome: "CONFIRMED_FRAUD",
          internalReason: confirmation.reason,
          decidedByUserId: "u1",
          decidedByRole: "OPERATIONS",
          expectedOrderVersion: 1,
          expectedVerificationVersion: 0,
          idempotencyKey: confirmationIdempotencyKey,
          requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      })
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
      expect(
        prisma.orderCancellationRequest.create.mock.invocationCallOrder[0],
      ).toBeLessThan(
        prisma.deliveryFraudFinding.create.mock.invocationCallOrder[0],
      )
      expect(
        prisma.deliveryFraudFinding.create.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.order.updateMany.mock.invocationCallOrder[0])
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "o1", version: 1, status: "PUBLISHED" },
        data: { version: { increment: 1 } },
      })
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_DELIVERY_FRAUD_CONFIRMED" }),
        prisma,
      )
      expect(communications.record).toHaveBeenCalledTimes(3)
      const externalInputs = communications.record.mock.calls
        .map((call: any[]) => call[0])
        .filter((event: any) => event.type === "ORDER_SECURITY_REVIEW_DECIDED")
      expect(externalInputs).toHaveLength(2)
      for (const event of externalInputs) {
        const serialized = JSON.stringify({
          title: event.title,
          message: event.message,
          payload: event.payload,
        })
        expect(serialized).not.toContain(confirmation.reason)
        expect(serialized).not.toContain("URL_REUSED")
        expect(serialized).not.toContain("flag-1")
      }
      expect(
        communications.dispatchManyByDedupKeyBestEffort,
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          "order:o1:fraud:flag-1:confirmed:customer",
          "order:o1:fraud:flag-1:confirmed:publisher",
          "staff:order:o1:fraud:flag-1:confirmed",
        ]),
      )
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.deliveryFraudFinding.create.mock.invocationCallOrder[0],
      )
    })

    it.each([
      ["REQUESTED", "ESCALATED", true],
      ["UNDER_REVIEW", "ESCALATED", true],
      ["ESCALATED", "ESCALATED", false],
      ["PENDING_FINANCE", "PENDING_FINANCE", false],
    ])("reuses a %s cancellation case without bypassing its review stage", async (existingStatus, linkedStatus, shouldEscalate) => {
      prepareConfirmation()
      prisma.orderCancellationRequest.findFirst.mockResolvedValue({
        id: "existing-cancellation",
        orderId: "o1",
        status: existingStatus,
        ...(existingStatus === "PENDING_FINANCE" && {
          resolution: "FULL_REFUND",
          responsibility: "PLATFORM",
          reviewedByUserId: "operations-1",
          resolutionReason:
            "Operations completed the full-refund recommendation review.",
        }),
        createdAt: new Date("2026-08-14T00:00:00.000Z"),
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).resolves.toMatchObject({
        cancellationRequestId: "existing-cancellation",
      })

      expect(prisma.orderCancellationRequest.create).not.toHaveBeenCalled()
      expect(prisma.orderCancellationRequest.updateMany).toHaveBeenCalledTimes(
        shouldEscalate ? 1 : 0,
      )
      if (shouldEscalate) {
        expect(prisma.orderCancellationRequest.updateMany).toHaveBeenCalledWith(
          {
            where: {
              id: "existing-cancellation",
              orderId: "o1",
              status: existingStatus,
            },
            data: { status: "ESCALATED" },
          },
        )
      }
      expect(prisma.deliveryFraudFinding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cancellationRequestId: "existing-cancellation",
        }),
      })
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            cancellationRequestId: "existing-cancellation",
            cancellationRequestStatus: linkedStatus,
            cancellationRequestCreated: false,
            cancellationRequestEscalated: shouldEscalate,
          }),
        }),
        prisma,
      )
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    })

    it("rejects an incomplete pre-existing Finance review before creating a finding", async () => {
      prepareConfirmation()
      prisma.orderCancellationRequest.findFirst.mockResolvedValue({
        id: "incomplete-finance-case",
        orderId: "o1",
        status: "PENDING_FINANCE",
        resolution: "CONTINUE_ORDER",
        responsibility: "UNDETERMINED",
        reviewedByUserId: null,
        resolutionReason: null,
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_HANDOFF_INCONSISTENT",
        }),
      })

      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(communications.record).not.toHaveBeenCalled()
    })

    it("never reopens or overwrites a terminal stable-key cancellation case", async () => {
      prepareConfirmation()
      prisma.orderCancellationRequest.findUnique.mockResolvedValue({
        id: "terminal-cancellation",
        orderId: "o1",
        status: "REJECTED",
        idempotencyKey: "delivery-fraud-confirmation:flag-1",
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_HANDOFF_INCONSISTENT",
        }),
      })
      expect(prisma.orderCancellationRequest.create).not.toHaveBeenCalled()
      expect(prisma.orderCancellationRequest.updateMany).not.toHaveBeenCalled()
      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(prisma.order.updateMany).not.toHaveBeenCalled()
    })

    it("returns only an exact actor, UUID, and intent replay", async () => {
      prepareConfirmation()
      await svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation)
      const createdIntent =
        prisma.deliveryFraudFinding.create.mock.calls[0][0].data
      prisma.deliveryFraudFlag.findUnique.mockReset()
      prepareConfirmation(
        unresolvedFlag({
          finding: { id: "fraud-finding-1", ...createdIntent },
        }),
      )
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        status: "COMPLETED",
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).resolves.toEqual({
        status: "CONFIRMED",
        replayed: true,
        fraudFlagId: "flag-1",
        findingId: "fraud-finding-1",
        cancellationRequestId: "cancellation-1",
      })
      expect(prisma.deliveryFraudFinding.create).toHaveBeenCalledTimes(1)
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
      expect(communications.record).toHaveBeenCalledTimes(6)
    })

    it.each([
      "CANCELLED",
      "REFUNDED",
      "COMPLETED",
    ])("rejects a new finding after the order reached %s", async (status) => {
      prepareConfirmation()
      prisma.order.findUnique.mockResolvedValue({ ...order, status })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_ORDER_TERMINAL",
        }),
      })
      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(communications.record).not.toHaveBeenCalled()
    })

    it("rejects a changed actor or intent instead of treating it as a replay", async () => {
      prepareConfirmation()
      await svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation)
      const createdIntent =
        prisma.deliveryFraudFinding.create.mock.calls[0][0].data
      prisma.deliveryFraudFlag.findUnique.mockReset()
      prepareConfirmation(
        unresolvedFlag({
          finding: { id: "fraud-finding-1", ...createdIntent },
        }),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "another-user", "SUPER_ADMIN", {
          ...confirmation,
          reason: "A different operator submitted a different fraud decision.",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_DECISION_CONFLICT",
        }),
      })
      expect(prisma.deliveryFraudFinding.create).toHaveBeenCalledTimes(1)
      expect(communications.record).toHaveBeenCalledTimes(3)
    })

    it("reloads an exact concurrent unique winner in a fresh transaction", async () => {
      prepareConfirmation()
      prisma.deliveryFraudFinding.create.mockImplementationOnce(
        async ({ data }: any) => {
          prisma.deliveryFraudFlag.findUnique.mockResolvedValueOnce(
            unresolvedFlag({
              finding: { id: "fraud-finding-winner", ...data },
            }),
          )
          throw { code: "P2002" }
        },
      )

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).resolves.toEqual({
        status: "CONFIRMED",
        replayed: true,
        fraudFlagId: "flag-1",
        findingId: "fraud-finding-winner",
        cancellationRequestId: "cancellation-1",
      })
      expect(prisma.$transaction).toHaveBeenCalledTimes(2)
      expect(communications.record).toHaveBeenCalledTimes(3)
    })

    it("confirms an exact hold for a historical superseded delivery", async () => {
      prepareConfirmation()
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        activeDeliveryVersionId: "v2",
      })
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
        ...versionWith("MANUAL_REVIEW"),
        supersededByVersion: 2,
      })

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).resolves.toEqual(
        expect.objectContaining({ status: "CONFIRMED", replayed: false }),
      )
      expect(prisma.deliveryFraudFinding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deliveryVersionId: "v1" }),
      })
    })

    it("rejects a competing clearance before any finding or outbox write", async () => {
      prepareConfirmation(
        unresolvedFlag({ resolution: { id: "resolution-existing" } }),
      )

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).rejects.toBeInstanceOf(ConflictException)
      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(communications.record).not.toHaveBeenCalled()
    })

    it("rejects stale order and delivery decisions under the order lock", async () => {
      prepareConfirmation()

      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", {
          ...confirmation,
          expectedOrderVersion: 0,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "ORDER_VERSION_CONFLICT" }),
      })
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(communications.record).not.toHaveBeenCalled()
    })

    it("rejects Finance and a reused UUID owned by another decision", async () => {
      await expect(
        svc.confirmFraudFlag("flag-1", "finance-1", "FINANCE", confirmation),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.deliveryFraudFlag.findUnique).not.toHaveBeenCalled()

      prepareConfirmation()
      prisma.deliveryFraudFinding.findUnique.mockResolvedValue({
        id: "other-finding",
      })
      await expect(
        svc.confirmFraudFlag("flag-1", "u1", "OPERATIONS", confirmation),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_IDEMPOTENCY_CONFLICT",
        }),
      })
      expect(prisma.deliveryFraudFinding.create).not.toHaveBeenCalled()
      expect(communications.record).not.toHaveBeenCalled()
    })
  })

  describe("resolveFraudFlag", () => {
    it.each([
      "VERIFIED",
      "DELIVERED",
    ])("resolves one hold on a %s order without changing lifecycle state", async (status) => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })
      prisma.order.findUnique.mockResolvedValue({ ...order, status })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).resolves.toEqual({
        status: "RESOLVED",
        fraudFlagId: "flag-1",
        resolutionId: "fraud-resolution-1",
      })

      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fraudFlagId: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          resolvedByUserId: "u1",
          resolvedByRole: "OPERATIONS",
          evidence: expect.objectContaining({
            disposition: "FALSE_POSITIVE",
          }),
        }),
      })
      expect(communications.record).toHaveBeenCalledTimes(2)
      for (const [event] of communications.record.mock.calls) {
        const serialized = JSON.stringify({
          title: event.title,
          message: event.message,
          payload: event.payload,
        })
        expect(serialized).not.toContain(reason)
        expect(serialized).not.toContain("FALSE_POSITIVE")
        expect(serialized).not.toContain("URL_REUSED")
        expect(serialized).not.toContain("flag-1")
      }
      expect(
        communications.dispatchManyByDedupKeyBestEffort,
      ).toHaveBeenCalledWith(
        expect.arrayContaining([
          "order:o1:fraud:flag-1:cleared:customer",
          "order:o1:fraud:flag-1:cleared:publisher",
        ]),
      )
    })

    it("fails closed when token role no longer matches current staff authority", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("does not announce workflow resumption while another fraud hold remains", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          finding: null,
          resolution: null,
        })
      prisma.deliveryFraudHold.count.mockResolvedValue(1)

      await svc.resolveFraudFlag(
        "flag-1",
        "u1",
        "OPERATIONS",
        reason,
        "FALSE_POSITIVE",
      )

      expect(communications.record).toHaveBeenCalledTimes(2)
      for (const [event] of communications.record.mock.calls) {
        expect(event.message).toContain("Another security review remains open")
        expect(event.payload).toEqual({
          decision: "REVIEW_PARTIALLY_CLEARED",
          nextStep: "SECURITY_REVIEW_CONTINUES",
        })
      }
      expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          evidence: expect.objectContaining({ blockedAfterDecision: true }),
        }),
      })
    })

    it("replays the immutable partial-clear outcome after later holds are cleared", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          finding: null,
          resolution: {
            id: "resolution-existing",
            kind: "STAFF_CLEARED",
            resolvedByUserId: "u1",
            reason,
            evidence: {
              disposition: "FALSE_POSITIVE",
              evidenceReference: null,
              blockedAfterDecision: true,
            },
          },
        })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).resolves.toEqual({
        status: "ALREADY_RESOLVED",
        fraudFlagId: "flag-1",
        resolutionId: "resolution-existing",
      })
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
      expect(communications.record).toHaveBeenCalledTimes(2)
      for (const [event] of communications.record.mock.calls) {
        expect(event.payload).toEqual({
          decision: "REVIEW_PARTIALLY_CLEARED",
          nextStep: "SECURITY_REVIEW_CONTINUES",
        })
      }
      expect(
        communications.dispatchManyByDedupKeyBestEffort,
      ).toHaveBeenCalledWith([
        "order:o1:fraud:flag-1:cleared:customer",
        "order:o1:fraud:flag-1:cleared:publisher",
      ])
    })

    it("reloads and repairs an exact concurrent clearance winner", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          finding: null,
          resolution: null,
        })
      prisma.deliveryFraudFlagResolution.create.mockImplementationOnce(
        async ({ data }: any) => {
          prisma.deliveryFraudFlag.findUnique.mockResolvedValueOnce({
            id: "flag-1",
            orderId: "o1",
            deliveryVersionId: "v1",
            type: "URL_REUSED",
            finding: null,
            resolution: {
              id: "resolution-winner",
              ...data,
            },
          })
          throw { code: "P2002" }
        },
      )

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).resolves.toEqual({
        status: "ALREADY_RESOLVED",
        fraudFlagId: "flag-1",
        resolutionId: "resolution-winner",
      })
      expect(prisma.$transaction).toHaveBeenCalledTimes(2)
      expect(communications.record).toHaveBeenCalledTimes(2)
    })

    it("rejects a blind replay with different clearance intent", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          finding: null,
          resolution: {
            id: "resolution-existing",
            kind: "STAFF_CLEARED",
            resolvedByUserId: "another-user",
            reason,
            evidence: {
              disposition: "FALSE_POSITIVE",
              evidenceReference: null,
            },
          },
        })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_DECISION_CONFLICT",
        }),
      })
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("rejects clearance after a confirmed finding won", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          finding: { id: "finding-existing" },
          resolution: null,
        })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "FALSE_POSITIVE",
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_DECISION_CONFLICT",
        }),
      })
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("rejects overlong resolution evidence before persistence", async () => {
      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          "x".repeat(1001),
          "FALSE_POSITIVE",
        ),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.deliveryFraudFlag.findUnique).not.toHaveBeenCalled()
    })

    it("requires Finance or Super Admin to accept a known risk", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "u1",
          "OPERATIONS",
          reason,
          "RISK_ACCEPTED",
          "CASE-1024",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("does not authorize reuse for a different fraud signal", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "DOMAIN_MISMATCH",
          resolution: null,
        })
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "finance-1",
          "FINANCE",
          reason,
          "AUTHORIZED_REUSE",
          "CASE-1024",
        ),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })

    it("records a Finance-authorized risk with its evidence reference", async () => {
      prisma.deliveryFraudFlag.findUnique
        .mockResolvedValueOnce({ orderId: "o1" })
        .mockResolvedValueOnce({
          id: "flag-1",
          orderId: "o1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
          resolution: null,
        })
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.resolveFraudFlag(
          "flag-1",
          "finance-1",
          "FINANCE",
          reason,
          "AUTHORIZED_REUSE",
          "CASE-1024",
        ),
      ).resolves.toEqual(expect.objectContaining({ status: "RESOLVED" }))
      expect(prisma.deliveryFraudFlagResolution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resolvedByRole: "FINANCE",
          evidence: expect.objectContaining({
            disposition: "AUTHORIZED_REUSE",
            evidenceReference: "CASE-1024",
          }),
        }),
      })
    })
  })

  describe("override", () => {
    it("allows SUPER_ADMIN to flip FAILED->VERIFIED", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        user: { userType: "STAFF", banned: false },
      })
      const r = await svc.override(
        "v1",
        "admin",
        "SUPER_ADMIN",
        "VERIFIED",
        reason,
      )
      expect(r.status).toBe("VERIFIED")
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "ORDER_DELIVERY_OVERRIDDEN" }),
        prisma,
      )
    })
    it("blocks a positive override while a fraud hold remains", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "SUPER_ADMIN",
        user: { userType: "STAFF", banned: false },
      })
      prisma.deliveryFraudHold.findMany.mockResolvedValue([
        {
          fraudFlagId: "flag-1",
          deliveryVersionId: "v1",
          type: "URL_REUSED",
        },
      ])

      await expect(
        svc.override("v1", "admin", "SUPER_ADMIN", "VERIFIED", reason),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "DELIVERY_FRAUD_REVIEW_REQUIRED",
        }),
      })

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(prisma.order.updateMany).not.toHaveBeenCalled()
      expect(prisma.deliveryFraudFlagResolution.create).not.toHaveBeenCalled()
    })
    it("forbids non-SUPER_ADMIN", async () => {
      await expect(
        svc.override("v1", "u1", "OPERATIONS", "VERIFIED", reason),
      ).rejects.toThrow(ForbiddenException)
    })
    it("fails closed when SUPER_ADMIN authority was demoted", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "OPERATIONS",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.override("v1", "admin", "SUPER_ADMIN", "VERIFIED", reason),
      ).rejects.toBeInstanceOf(ForbiddenException)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
    })
    it("rejects invalid target status", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      await expect(
        svc.override("v1", "admin", "SUPER_ADMIN", "PENDING" as any, reason),
      ).rejects.toThrow(BadRequestException)
    })
  })

  describe("manualReject", () => {
    it("rejects only the active, current delivery version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).resolves.toEqual({ status: "REJECTED" })

      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "v1",
            orderId: "o1",
            supersededByVersion: null,
            verificationVersion: 0,
          },
        }),
      )
    })

    it("refuses to reject a superseded delivery version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
        ...versionWith("FAILED"),
        supersededByVersion: 2,
      })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(/no longer the active version/i)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })

    it("fails closed when staff authority was demoted", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue({
        role: "FINANCE",
        user: { userType: "STAFF", banned: false },
      })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toBeInstanceOf(ForbiddenException)

      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })

    it("requires the override path to retract an already verified delivery", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("VERIFIED"),
      )
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        status: "VERIFIED",
      })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(/awaiting verification/i)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
    })

    it.each([
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
      "REFUNDED",
    ])("keeps delivery evidence immutable for %s orders", async (status) => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.order.findUnique
        .mockResolvedValueOnce(order)
        .mockResolvedValue({ ...order, status })

      await expect(
        svc.manualReject("v1", "u1", "OPERATIONS", reason),
      ).rejects.toThrow(/financially final/i)

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(prisma.notification.create).not.toHaveBeenCalled()
    })
  })

  describe("reverify", () => {
    it("revalidates current staff authority after taking the order lock", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.staffMembership.findUnique.mockResolvedValue(null)

      await expect(svc.reverify("v1", "u1", "OPERATIONS")).rejects.toThrow(
        ForbiddenException,
      )

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(queue.addJob).not.toHaveBeenCalled()
    })

    it("resets to PENDING + enqueues a signed verify job", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      const r = await svc.reverify("v1", "u1", "OPERATIONS")
      expect(r.status).toBe("PENDING")
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verificationStatus: "PENDING",
            interventionStatus: "NONE",
            verificationFailureReason: null,
            adminVerifiedById: null,
            adminOverrideReason: null,
            adminVerifiedNotes: null,
          }),
        }),
      )
      expect(queue.addJob).toHaveBeenCalledWith(
        "delivery-verification",
        "delivery-verify",
        expect.objectContaining({
          deliveryVersionId: "v1",
          verificationVersion: 1,
        }),
        expect.objectContaining({
          attempts: 3,
          jobId: "delivery-verify-v1-v1",
        }),
      )
    })

    it("surfaces a recoverable error after the database commit when enqueue fails", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      queue.addJob.mockRejectedValue(new Error("redis unavailable"))
      const logger = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined)

      const error = await svc
        .reverify("v1", "u1", "OPERATIONS")
        .catch((value) => value)

      expect(error.getStatus()).toBe(503)
      expect(error.getResponse()).toEqual(
        expect.objectContaining({
          code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
          deliveryVersionId: "v1",
        }),
      )
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ verificationStatus: "PENDING" }),
        }),
      )
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ORDER_DELIVERY_VERIFICATION_STARTED",
        }),
        prisma,
      )
      logger.mockRestore()
    })
    it("refuses to re-verify a superseded version", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue({
        ...versionWith("FAILED"),
        supersededByVersion: 2,
      })
      await expect(svc.reverify("v1", "u1", "OPERATIONS")).rejects.toThrow(
        BadRequestException,
      )
    })
    it("does not create a pending delivery on an already verified order", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("VERIFIED"),
      )
      prisma.order.findUnique.mockResolvedValue({
        ...order,
        status: "VERIFIED",
      })

      await expect(svc.reverify("v1", "u1", "OPERATIONS")).rejects.toThrow(
        /awaiting verification/i,
      )
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(queue.addJob).not.toHaveBeenCalled()
    })
    it("does not enqueue when a concurrent intervention wins", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.orderDeliveryVersion.updateMany.mockResolvedValue({ count: 0 })

      await expect(svc.reverify("v1", "u1", "OPERATIONS")).rejects.toThrow(
        /modified by another request/i,
      )
      expect(queue.addJob).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
    })

    it("retries rollback-safe DB work without enqueuing twice", async () => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      let attempt = 0
      prisma.$transaction.mockImplementation(async (callback: any) => {
        const result = await callback(prisma)
        attempt++
        if (attempt === 1) throw { code: "P2034" }
        return result
      })

      await svc.reverify("v1", "u1", "OPERATIONS")

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2)
      expect(prisma.orderDeliveryVersion.updateMany).toHaveBeenCalledTimes(2)
      expect(queue.addJob).toHaveBeenCalledTimes(1)
    })

    it.each([
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
      "REFUNDED",
    ])("does not re-verify financially final %s orders", async (status) => {
      prisma.orderDeliveryVersion.findUnique.mockResolvedValue(
        versionWith("FAILED"),
      )
      prisma.order.findUnique
        .mockResolvedValueOnce(order)
        .mockResolvedValueOnce({ ...order, status })

      await expect(svc.reverify("v1", "u1", "OPERATIONS")).rejects.toThrow(
        /financially final/i,
      )

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
      expect(prisma.orderDeliveryVersion.updateMany).not.toHaveBeenCalled()
      expect(audit.log).not.toHaveBeenCalled()
      expect(queue.addJob).not.toHaveBeenCalled()
    })
  })
})
