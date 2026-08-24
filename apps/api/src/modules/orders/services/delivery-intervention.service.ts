import { createHash } from "node:crypto"
import {
  computeFraudHandoffDeadline,
  deliveryVerificationJobId,
  isUniqueViolation,
  notificationDedupKey,
  orderEventMetadata,
  QUEUE_JOBS,
  QUEUES,
  resolveOrderCancellationConfig,
  runLockedOrderSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import { presignGet } from "@guestpost/shared/dist/object-storage"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { CommunicationsService } from "../../communications/communications.service"
import { QueueService } from "../../queues/queue.service"
import {
  type ConfirmDeliveryFraudFlagDto,
  DELIVERY_FRAUD_DISPOSITIONS,
  type DeliveryFraudDisposition,
} from "../dto/delivery-intervention.dto"
import { assertNoUnresolvedDeliveryFraudHolds } from "./delivery-fraud-guard"
import { assertCurrentStaffAuthority } from "./staff-authority"

const MIN_REASON = 20
const FRAUD_RESOLVER_ROLES = new Set(["SUPER_ADMIN", "OPERATIONS", "FINANCE"])
const FRAUD_CONFIRMATION_ROLES = ["SUPER_ADMIN", "OPERATIONS"] as const
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FINANCIALLY_TERMINAL_ORDER_STATUSES = new Set([
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REFUNDED",
])
const FRAUD_CONFIRMATION_TERMINAL_ORDER_STATUSES = new Set([
  "CANCELLED",
  "REFUNDED",
  "COMPLETED",
])
const ACTIVE_CANCELLATION_REVIEW_STATUSES = [
  "REQUESTED",
  "UNDER_REVIEW",
  "PENDING_FINANCE",
  "ESCALATED",
] as const
const FRAUD_CANCELLATION_NOTE =
  "A platform delivery integrity review confirmed an issue. Financial and remediation decisions remain pending authorized staff review."

// Manual intervention + evidence retrieval for deliveries. All transitions are
// optimistic-lock guarded, require a substantive reason, and are audited +
// notified. Override is SUPER_ADMIN-only.
@Injectable()
export class DeliveryInterventionService {
  private readonly logger = new Logger(DeliveryInterventionService.name)
  private readonly decision = new WorkflowDecisionService()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly communications: CommunicationsService,
  ) {}

  private requireReason(reason: string | undefined) {
    if (!reason || reason.trim().length < MIN_REASON) {
      throw new BadRequestException(
        `A reason of at least ${MIN_REASON} characters is required`,
      )
    }
    if (reason.trim().length > 1000) {
      throw new BadRequestException("Reason must be 1,000 characters or fewer")
    }
    return reason.trim()
  }

  private async assertDeliveryEvidenceMutable(
    tx: any,
    orderId: string,
    action: string,
  ) {
    const currentOrder = await tx.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    })
    if (!currentOrder) throw new NotFoundException("Order not found")
    if (FINANCIALLY_TERMINAL_ORDER_STATUSES.has(currentOrder.status)) {
      throw new BadRequestException(
        `Cannot ${action} delivery evidence after the order is financially final`,
      )
    }
    return currentOrder
  }

  private async loadVersionWithOrder(deliveryVersionId: string) {
    const version = await this.prisma.orderDeliveryVersion.findUnique({
      where: { id: deliveryVersionId },
    })
    if (!version) throw new NotFoundException("Delivery version not found")
    const order = await this.prisma.order.findUnique({
      where: { id: version.orderId },
      include: { website: { select: { publisherId: true } } },
    })
    if (!order) throw new NotFoundException("Order not found")
    return { version, order }
  }

  private async loadActiveVersionUnderLock(
    tx: any,
    orderId: string,
    deliveryVersionId: string,
    expectedVerificationVersion: number,
  ) {
    const [currentOrder, currentVersion] = await Promise.all([
      tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          version: true,
          activeDeliveryVersionId: true,
        },
      }),
      tx.orderDeliveryVersion.findUnique({
        where: { id: deliveryVersionId },
        select: {
          id: true,
          orderId: true,
          verificationStatus: true,
          verificationVersion: true,
          supersededByVersion: true,
        },
      }),
    ])
    if (!currentOrder || !currentVersion) {
      throw new NotFoundException("Order or delivery version not found")
    }
    if (
      currentOrder.activeDeliveryVersionId !== deliveryVersionId ||
      currentVersion.orderId !== orderId ||
      currentVersion.supersededByVersion != null
    ) {
      throw new ConflictException(
        "Delivery is no longer the active version. Refresh before intervening.",
      )
    }
    if (currentVersion.verificationVersion !== expectedVerificationVersion) {
      throw new ConflictException(
        "Delivery was modified by another request. Refresh and retry.",
      )
    }
    return { currentOrder, currentVersion }
  }

  private requireExpectedVersion(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException(`${label} must be a non-negative integer`)
    }
    return value
  }

  private requireIdempotencyKey(value: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new BadRequestException("idempotencyKey must be a valid UUID")
    }
    return value.toLowerCase()
  }

  private fraudConfirmationFingerprint(input: {
    fraudFlagId: string
    actorUserId: string
    role: string
    reason: string
    expectedOrderVersion: number
    expectedVerificationVersion: number
    idempotencyKey: string
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          fraudFlagId: input.fraudFlagId,
          actorUserId: input.actorUserId,
          role: input.role,
          reason: input.reason,
          expectedOrderVersion: input.expectedOrderVersion,
          expectedVerificationVersion: input.expectedVerificationVersion,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest("hex")
  }

  private exactFraudFindingReplay(
    finding: any,
    expected: {
      fraudFlagId: string
      orderId: string
      deliveryVersionId: string
      actorUserId: string
      role: string
      reason: string
      expectedOrderVersion: number
      expectedVerificationVersion: number
      idempotencyKey: string
      requestFingerprint: string
    },
  ): boolean {
    return (
      finding.fraudFlagId === expected.fraudFlagId &&
      finding.orderId === expected.orderId &&
      finding.deliveryVersionId === expected.deliveryVersionId &&
      finding.outcome === "CONFIRMED_FRAUD" &&
      finding.internalReason === expected.reason &&
      finding.decidedByUserId === expected.actorUserId &&
      finding.decidedByRole === expected.role &&
      finding.expectedOrderVersion === expected.expectedOrderVersion &&
      finding.expectedVerificationVersion ===
        expected.expectedVerificationVersion &&
      finding.idempotencyKey.toLowerCase() === expected.idempotencyKey &&
      finding.requestFingerprint === expected.requestFingerprint
    )
  }

  private fraudCancellationIdempotencyKey(fraudFlagId: string): string {
    return `delivery-fraud-confirmation:${fraudFlagId}`
  }

  /**
   * Preserve the lifecycle state that existed before an open dispute. Finance
   * compensation policy is based on whether fulfilment had already happened,
   * not on the temporary DISPUTED wrapper state.
   */
  private cancellationPreviousOrderStatus(order: {
    status: string
    dispute?: { previousStatus?: string | null } | null
  }): string {
    if (order.status !== "DISPUTED") return order.status
    if (order.dispute?.previousStatus) return order.dispute.previousStatus
    throw new ConflictException({
      code: "DELIVERY_FRAUD_DISPUTE_STATE_INCONSISTENT",
      message:
        "The disputed order has no recoverable pre-dispute status and requires reconciliation before fraud can be confirmed.",
    })
  }

  /**
   * Enter a confirmed operational finding into the existing cancellation
   * review workflow without making a financial decision. The enclosing Order
   * lock serializes this with customer/publisher cancellation writers, while
   * the database partial unique index remains the direct-SQL backstop.
   */
  private async ensureFraudCancellationHandoff(
    tx: any,
    input: {
      order: any
      fraudFlagId: string
      actorUserId: string
      role: string
    },
  ): Promise<{ request: any; created: boolean; escalated: boolean }> {
    const { order, fraudFlagId, actorUserId, role } = input
    const active = await tx.orderCancellationRequest.findFirst({
      where: {
        orderId: order.id,
        status: { in: [...ACTIVE_CANCELLATION_REVIEW_STATUSES] },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })

    if (active) {
      if (active.status === "REQUESTED" || active.status === "UNDER_REVIEW") {
        const escalated = await tx.orderCancellationRequest.updateMany({
          where: { id: active.id, orderId: order.id, status: active.status },
          data: { status: "ESCALATED" },
        })
        if (escalated.count !== 1) {
          throw new ConflictException({
            code: "DELIVERY_FRAUD_CANCELLATION_CONFLICT",
            message:
              "The cancellation review changed while fraud was confirmed. Refresh and retry.",
          })
        }
        return {
          request: { ...active, status: "ESCALATED" },
          created: false,
          escalated: true,
        }
      }
      if (
        active.status === "PENDING_FINANCE" &&
        (active.resolution !== "FULL_REFUND" ||
          active.responsibility === "UNDETERMINED" ||
          !active.reviewedByUserId ||
          typeof active.resolutionReason !== "string" ||
          active.resolutionReason !== active.resolutionReason.trim() ||
          active.resolutionReason.length < 20 ||
          active.resolutionReason.length > 2000)
      ) {
        throw new ConflictException({
          code: "DELIVERY_FRAUD_HANDOFF_INCONSISTENT",
          message:
            "The existing Finance review is incomplete and requires reconciliation before fraud can be confirmed.",
        })
      }
      return { request: active, created: false, escalated: false }
    }

    const stableIdempotencyKey =
      this.fraudCancellationIdempotencyKey(fraudFlagId)
    const priorStableCase = await tx.orderCancellationRequest.findUnique({
      where: {
        orderId_idempotencyKey: {
          orderId: order.id,
          idempotencyKey: stableIdempotencyKey,
        },
      },
    })
    if (priorStableCase) {
      throw new ConflictException({
        code: "DELIVERY_FRAUD_HANDOFF_INCONSISTENT",
        message:
          "The fraud review case is already terminal without a matching finding and requires reconciliation.",
      })
    }

    const fulfillmentChannel =
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    const { fraudReviewWindowHours } = resolveOrderCancellationConfig(
      process.env,
    )
    const request = await tx.orderCancellationRequest.create({
      data: {
        orderId: order.id,
        requestedByUserId: actorUserId,
        requesterType: "STAFF",
        actorSnapshot: {
          userId: actorUserId,
          kind: "STAFF",
          staffRole: role,
          source: "DELIVERY_FRAUD_CONFIRMATION",
        },
        reasonCode: "LEGAL_OR_SECURITY_EMERGENCY",
        note: FRAUD_CANCELLATION_NOTE,
        status: "ESCALATED",
        previousOrderStatus: this.cancellationPreviousOrderStatus(order),
        fulfillmentChannel,
        responsibility: "UNDETERMINED",
        requestedResolution: "FULL_REFUND",
        responseDeadlineAt: computeFraudHandoffDeadline(
          new Date(),
          fraudReviewWindowHours,
        ),
        idempotencyKey: stableIdempotencyKey,
      },
    })
    return { request, created: true, escalated: false }
  }

  private async recordConfirmedFraudCommunications(
    tx: any,
    input: {
      order: any
      flag: any
      finding: any
      actorUserId: string
    },
  ): Promise<string[]> {
    const { order, flag, finding, actorUserId } = input
    const [customerRecipients, publisherRecipients, staffRecipients] =
      await Promise.all([
        this.communications.customerOrderRecipients(order.id, tx),
        this.communications.publisherRecipients(
          order.website?.publisherId,
          false,
          tx,
        ),
        this.communications.staffRecipients(
          ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
          tx,
        ),
      ])
    const prefix = `order:${order.id}:fraud:${flag.id}:confirmed`
    const dedupKeys: string[] = []

    const customerDedupKey = `${prefix}:customer`
    await this.communications.record(
      {
        type: "ORDER_SECURITY_REVIEW_DECIDED",
        aggregateType: "DeliveryFraudFinding",
        aggregateId: finding.id,
        organizationId: order.organizationId,
        title: "Delivery integrity review completed",
        message: `A delivery integrity issue was confirmed for order ${order.id}. The order remains on hold while the platform reviews the next steps.`,
        actionPath: `/dashboard/orders/${order.id}`,
        payload: {
          decision: "INTEGRITY_ISSUE_CONFIRMED",
          nextStep: "PLATFORM_ACTION_PENDING",
        },
        dedupKey: customerDedupKey,
        recipientUserIds: customerRecipients,
        actorUserId,
      },
      tx,
    )
    dedupKeys.push(customerDedupKey)

    if (order.website?.publisherId) {
      const publisherDedupKey = `${prefix}:publisher`
      await this.communications.record(
        {
          type: "ORDER_SECURITY_REVIEW_DECIDED",
          aggregateType: "DeliveryFraudFinding",
          aggregateId: finding.id,
          organizationId: null,
          title: "Delivery integrity review completed",
          message: `A delivery integrity issue was confirmed for order ${order.id}. The order remains on hold while remediation or other next steps are reviewed.`,
          actionPath: `/dashboard/orders/${order.id}`,
          payload: {
            decision: "INTEGRITY_ISSUE_CONFIRMED",
            nextStep: "PLATFORM_ACTION_PENDING",
          },
          dedupKey: publisherDedupKey,
          recipientUserIds: publisherRecipients,
          actorUserId,
        },
        tx,
      )
      dedupKeys.push(publisherDedupKey)
    }

    const staffDedupKey = `staff:${prefix}`
    await this.communications.record(
      {
        type: "STAFF_FRAUD_ALERT",
        aggregateType: "DeliveryFraudFinding",
        aggregateId: finding.id,
        organizationId: null,
        title: "Confirmed delivery integrity issue requires action",
        message: `Order ${order.id} has a confirmed delivery integrity finding linked to cancellation review ${finding.cancellationRequestId}.`,
        actionPath: `/dashboard/cancellations?requestId=${finding.cancellationRequestId}`,
        payload: {
          fraudFindingId: finding.id,
          fraudFlagId: flag.id,
          deliveryVersionId: flag.deliveryVersionId,
          fraudType: flag.type,
          cancellationRequestId: finding.cancellationRequestId,
        },
        dedupKey: staffDedupKey,
        recipientUserIds: staffRecipients,
        actorUserId,
      },
      tx,
    )
    dedupKeys.push(staffDedupKey)
    return dedupKeys
  }

  private async recordClearedFraudCommunications(
    tx: any,
    input: {
      order: any
      flag: any
      resolution: any
      actorUserId: string
    },
  ): Promise<string[]> {
    const { order, flag, resolution, actorUserId } = input
    const [customerRecipients, publisherRecipients] = await Promise.all([
      this.communications.customerOrderRecipients(order.id, tx),
      this.communications.publisherRecipients(
        order.website?.publisherId,
        false,
        tx,
      ),
    ])
    const resolutionEvidence =
      resolution.evidence &&
      typeof resolution.evidence === "object" &&
      !Array.isArray(resolution.evidence)
        ? (resolution.evidence as Record<string, unknown>)
        : null
    // New decisions persist this aggregate snapshot before the resolution
    // trigger deletes the selected hold. Exact replays must reuse it: deriving
    // content from today's aggregate could conflict with the immutable outbox
    // event after another flag is later cleared.
    const reviewContinues =
      typeof resolutionEvidence?.blockedAfterDecision === "boolean"
        ? resolutionEvidence.blockedAfterDecision
        : (await tx.deliveryFraudHold.count({
            where: { orderId: order.id },
          })) > 0
    const publicMessage = reviewContinues
      ? `One delivery integrity signal for order ${order.id} was cleared. Another security review remains open, so acceptance and payment release are still paused.`
      : `The delivery integrity review for order ${order.id} was completed. No security holds remain, and the order may continue through its normal checks.`
    const decision = reviewContinues
      ? "REVIEW_PARTIALLY_CLEARED"
      : "REVIEW_HOLD_CLEARED"
    const nextStep = reviewContinues
      ? "SECURITY_REVIEW_CONTINUES"
      : "ORDER_WORKFLOW_RESUMED"
    const prefix = `order:${order.id}:fraud:${flag.id}:cleared`
    const dedupKeys: string[] = []

    const customerDedupKey = `${prefix}:customer`
    await this.communications.record(
      {
        type: "ORDER_SECURITY_REVIEW_DECIDED",
        aggregateType: "DeliveryFraudFlagResolution",
        aggregateId: resolution.id,
        organizationId: order.organizationId,
        title: "Delivery integrity review completed",
        message: publicMessage,
        actionPath: `/dashboard/orders/${order.id}`,
        payload: {
          decision,
          nextStep,
        },
        dedupKey: customerDedupKey,
        recipientUserIds: customerRecipients,
        actorUserId,
      },
      tx,
    )
    dedupKeys.push(customerDedupKey)

    if (order.website?.publisherId) {
      const publisherDedupKey = `${prefix}:publisher`
      await this.communications.record(
        {
          type: "ORDER_SECURITY_REVIEW_DECIDED",
          aggregateType: "DeliveryFraudFlagResolution",
          aggregateId: resolution.id,
          organizationId: null,
          title: "Delivery integrity review completed",
          message: publicMessage,
          actionPath: `/dashboard/orders/${order.id}`,
          payload: {
            decision,
            nextStep,
          },
          dedupKey: publisherDedupKey,
          recipientUserIds: publisherRecipients,
          actorUserId,
        },
        tx,
      )
      dedupKeys.push(publisherDedupKey)
    }
    return dedupKeys
  }

  /**
   * Confirm an immutable fraud signal without clearing its settlement hold or
   * moving money. Operational and financial enforcement remain separate
   * commands; this finding is their durable, order-serialized prerequisite.
   */
  async confirmFraudFlag(
    fraudFlagId: string,
    userId: string,
    role: string,
    input: ConfirmDeliveryFraudFlagDto,
  ) {
    if (!(FRAUD_CONFIRMATION_ROLES as readonly string[]).includes(role)) {
      throw new ForbiddenException(
        "Only Operations or Super Admin may confirm delivery fraud",
      )
    }
    const reason = this.requireReason(input.reason)
    const expectedOrderVersion = this.requireExpectedVersion(
      input.expectedOrderVersion,
      "expectedOrderVersion",
    )
    const expectedVerificationVersion = this.requireExpectedVersion(
      input.expectedVerificationVersion,
      "expectedVerificationVersion",
    )
    const idempotencyKey = this.requireIdempotencyKey(input.idempotencyKey)
    const requestFingerprint = this.fraudConfirmationFingerprint({
      fraudFlagId,
      actorUserId: userId,
      role,
      reason,
      expectedOrderVersion,
      expectedVerificationVersion,
      idempotencyKey,
    })
    const candidate = await this.prisma.deliveryFraudFlag.findUnique({
      where: { id: fraudFlagId },
      select: { orderId: true },
    })
    if (!candidate) throw new NotFoundException("Fraud flag not found")

    let committed: {
      status: "CONFIRMED"
      replayed: boolean
      fraudFlagId: string
      findingId: string
      cancellationRequestId: string
      communicationDedupKeys: string[]
    }
    const runConfirmation = () =>
      runLockedOrderSerializableTransaction(
        this.prisma,
        candidate.orderId,
        async (tx: any) => {
          const [flag, order] = await Promise.all([
            tx.deliveryFraudFlag.findUnique({
              where: { id: fraudFlagId },
              include: { finding: true, resolution: true, hold: true },
            }),
            tx.order.findUnique({
              where: { id: candidate.orderId },
              select: {
                id: true,
                organizationId: true,
                customerId: true,
                status: true,
                version: true,
                fulfillmentChannel: true,
                activeDeliveryVersionId: true,
                dispute: {
                  select: { previousStatus: true },
                },
                website: {
                  select: { publisherId: true, ownershipType: true },
                },
              },
            }),
          ])
          if (!flag || flag.orderId !== candidate.orderId) {
            throw new NotFoundException("Fraud flag not found")
          }
          if (!order) throw new NotFoundException("Order not found")
          const [currentRole, delivery] = await Promise.all([
            assertCurrentStaffAuthority(
              tx,
              userId,
              role,
              FRAUD_CONFIRMATION_ROLES,
            ),
            tx.orderDeliveryVersion.findUnique({
              where: { id: flag.deliveryVersionId },
              select: {
                id: true,
                orderId: true,
                verificationVersion: true,
                supersededByVersion: true,
              },
            }),
          ])
          const expectedFinding = {
            fraudFlagId,
            orderId: order.id,
            deliveryVersionId: flag.deliveryVersionId,
            actorUserId: userId,
            role: currentRole,
            reason,
            expectedOrderVersion,
            expectedVerificationVersion,
            idempotencyKey,
            requestFingerprint,
          }

          if (flag.finding && flag.resolution) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_STATE_INCONSISTENT",
              message:
                "Fraud evidence has conflicting decisions and requires reconciliation.",
            })
          }
          if (flag.finding) {
            if (!this.exactFraudFindingReplay(flag.finding, expectedFinding)) {
              throw new ConflictException({
                code: "DELIVERY_FRAUD_DECISION_CONFLICT",
                message:
                  "This fraud flag already has a different confirmed decision.",
              })
            }
            const communicationDedupKeys =
              await this.recordConfirmedFraudCommunications(tx, {
                order,
                flag,
                finding: flag.finding,
                actorUserId: userId,
              })
            return {
              status: "CONFIRMED" as const,
              replayed: true,
              fraudFlagId,
              findingId: flag.finding.id,
              cancellationRequestId: flag.finding.cancellationRequestId,
              communicationDedupKeys,
            }
          }
          if (flag.resolution) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_DECISION_CONFLICT",
              message:
                "This fraud flag was already cleared by a competing decision.",
            })
          }
          if (FRAUD_CONFIRMATION_TERMINAL_ORDER_STATUSES.has(order.status)) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_ORDER_TERMINAL",
              message:
                "A new fraud finding cannot be created after the order reached a terminal outcome.",
            })
          }

          const idempotencyWinner = await tx.deliveryFraudFinding.findUnique({
            where: {
              decidedByUserId_idempotencyKey: {
                decidedByUserId: userId,
                idempotencyKey,
              },
            },
          })
          if (idempotencyWinner) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_IDEMPOTENCY_CONFLICT",
              message:
                "This idempotency key belongs to a different fraud decision.",
            })
          }
          if (
            !flag.hold ||
            flag.hold.orderId !== order.id ||
            flag.hold.deliveryVersionId !== flag.deliveryVersionId ||
            flag.hold.type !== flag.type
          ) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_HOLD_MISSING",
              message:
                "The fraud hold changed or is inconsistent. Refresh before deciding.",
            })
          }
          if (order.version !== expectedOrderVersion) {
            throw new ConflictException({
              code: "ORDER_VERSION_CONFLICT",
              message: "Order changed. Refresh before confirming fraud.",
            })
          }
          if (!delivery || delivery.orderId !== order.id) {
            throw new ConflictException({
              code: "DELIVERY_VERSION_CONFLICT",
              message:
                "Fraud evidence no longer belongs to this order. Refresh before confirming fraud.",
            })
          }
          if (delivery.verificationVersion !== expectedVerificationVersion) {
            throw new ConflictException({
              code: "DELIVERY_VERIFICATION_VERSION_CONFLICT",
              message:
                "Delivery verification changed. Refresh before confirming fraud.",
            })
          }

          const handoff = await this.ensureFraudCancellationHandoff(tx, {
            order,
            fraudFlagId,
            actorUserId: userId,
            role: currentRole,
          })

          const finding = await tx.deliveryFraudFinding.create({
            data: {
              fraudFlagId,
              orderId: order.id,
              deliveryVersionId: delivery.id,
              cancellationRequestId: handoff.request.id,
              outcome: "CONFIRMED_FRAUD",
              internalReason: reason,
              decidedByUserId: userId,
              decidedByRole: currentRole,
              expectedOrderVersion,
              expectedVerificationVersion,
              idempotencyKey,
              requestFingerprint,
            },
          })
          const versionClaim = await tx.order.updateMany({
            where: {
              id: order.id,
              version: expectedOrderVersion,
              status: order.status,
            },
            data: { version: { increment: 1 } },
          })
          if (versionClaim.count !== 1) {
            throw new ConflictException({
              code: "ORDER_VERSION_CONFLICT",
              message: "Order changed. Refresh before confirming fraud.",
            })
          }
          await this.audit.log(
            {
              action: "ORDER_DELIVERY_FRAUD_CONFIRMED",
              entityType: "DeliveryFraudFinding",
              entityId: finding.id,
              metadata: {
                ...orderEventMetadata(order),
                fraudFindingId: finding.id,
                fraudFlagId,
                cancellationRequestId: handoff.request.id,
                cancellationRequestStatus: handoff.request.status,
                cancellationRequestCreated: handoff.created,
                cancellationRequestEscalated: handoff.escalated,
                fraudDeliveryVersionId: delivery.id,
                fraudType: flag.type,
                internalReason: reason,
                roleAtTime: currentRole,
                expectedOrderVersion,
                expectedVerificationVersion,
              },
              userId,
              organizationId: order.organizationId,
            },
            tx,
          )
          const communicationDedupKeys =
            await this.recordConfirmedFraudCommunications(tx, {
              order,
              flag,
              finding,
              actorUserId: userId,
            })
          return {
            status: "CONFIRMED" as const,
            replayed: false,
            fraudFlagId,
            findingId: finding.id,
            cancellationRequestId: handoff.request.id,
            communicationDedupKeys,
          }
        },
      )

    try {
      committed = await runConfirmation()
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      // A concurrent exact request can lose the unique insert even though it
      // has the same immutable intent. Re-enter once with a fresh SERIALIZABLE
      // snapshot so the normal exact-replay branch can return/repair the
      // committed winner. The retry is deliberately bounded: a second unique
      // failure is inconsistent state or a genuinely different decision.
      try {
        committed = await runConfirmation()
      } catch (replayError) {
        if (!isUniqueViolation(replayError)) throw replayError
        throw new ConflictException({
          code: "DELIVERY_FRAUD_DECISION_CONFLICT",
          message:
            "Another fraud decision won concurrently. Refresh before retrying.",
        })
      }
    }

    this.communications.dispatchManyByDedupKeyBestEffort(
      committed.communicationDedupKeys,
    )
    const { communicationDedupKeys: _communicationDedupKeys, ...result } =
      committed
    return result
  }

  /**
   * Adjudicate one immutable fraud flag without changing Order or delivery
   * lifecycle state. The database independently revalidates role-at-time and
   * deletes only the matching current-hold projection.
   */
  async resolveFraudFlag(
    fraudFlagId: string,
    userId: string,
    role: string,
    reason: string,
    disposition: DeliveryFraudDisposition,
    evidenceReference?: string,
  ) {
    const r = this.requireReason(reason)
    if (!DELIVERY_FRAUD_DISPOSITIONS.includes(disposition)) {
      throw new BadRequestException("Invalid delivery fraud disposition")
    }
    const normalizedEvidenceReference = evidenceReference?.trim() || null
    if (
      normalizedEvidenceReference &&
      normalizedEvidenceReference.length > 200
    ) {
      throw new BadRequestException(
        "Evidence reference must be 200 characters or fewer",
      )
    }
    if (disposition !== "FALSE_POSITIVE" && !normalizedEvidenceReference) {
      throw new BadRequestException(
        "An evidence or case reference is required when authorizing or accepting delivery risk",
      )
    }
    if (!FRAUD_RESOLVER_ROLES.has(role)) {
      throw new ForbiddenException(
        "Only authorized staff may resolve delivery fraud holds",
      )
    }

    const candidate = await this.prisma.deliveryFraudFlag.findUnique({
      where: { id: fraudFlagId },
      select: { orderId: true },
    })
    if (!candidate) throw new NotFoundException("Fraud flag not found")

    let committed: {
      status: "RESOLVED" | "ALREADY_RESOLVED"
      fraudFlagId: string
      resolutionId: string
      communicationDedupKeys: string[]
    }
    const runResolution = () =>
      runLockedOrderSerializableTransaction(
        this.prisma,
        candidate.orderId,
        async (tx: any) => {
          const [flag, order] = await Promise.all([
            tx.deliveryFraudFlag.findUnique({
              where: { id: fraudFlagId },
              include: { finding: true, resolution: true },
            }),
            tx.order.findUnique({
              where: { id: candidate.orderId },
              include: { website: { select: { publisherId: true } } },
            }),
          ])
          if (!flag || flag.orderId !== candidate.orderId) {
            throw new NotFoundException("Fraud flag not found")
          }
          if (!order) throw new NotFoundException("Order not found")
          const currentRole = await assertCurrentStaffAuthority(
            tx,
            userId,
            role,
            [...FRAUD_RESOLVER_ROLES],
          )
          if (flag.finding) {
            throw new ConflictException({
              code: "DELIVERY_FRAUD_DECISION_CONFLICT",
              message:
                "This fraud flag was already confirmed and can no longer be cleared.",
            })
          }
          if (flag.resolution) {
            const evidence =
              flag.resolution.evidence &&
              typeof flag.resolution.evidence === "object" &&
              !Array.isArray(flag.resolution.evidence)
                ? (flag.resolution.evidence as Record<string, unknown>)
                : null
            const storedEvidenceReference =
              typeof evidence?.evidenceReference === "string"
                ? evidence.evidenceReference.trim() || null
                : null
            const exactReplay =
              flag.resolution.kind === "STAFF_CLEARED" &&
              flag.resolution.resolvedByUserId === userId &&
              flag.resolution.reason === r &&
              evidence?.disposition === disposition &&
              storedEvidenceReference === normalizedEvidenceReference
            if (!exactReplay) {
              throw new ConflictException({
                code: "DELIVERY_FRAUD_DECISION_CONFLICT",
                message:
                  "This fraud flag already has a different clearance decision.",
              })
            }
            const communicationDedupKeys =
              await this.recordClearedFraudCommunications(tx, {
                order,
                flag,
                resolution: flag.resolution,
                actorUserId: userId,
              })
            return {
              status: "ALREADY_RESOLVED" as const,
              fraudFlagId,
              resolutionId: flag.resolution.id,
              communicationDedupKeys,
            }
          }
          if (
            disposition !== "FALSE_POSITIVE" &&
            currentRole !== "SUPER_ADMIN" &&
            currentRole !== "FINANCE"
          ) {
            throw new ForbiddenException(
              "Only Finance or Super Admin may accept or authorize a known delivery risk",
            )
          }
          if (
            disposition === "AUTHORIZED_REUSE" &&
            flag.type !== "URL_REUSED"
          ) {
            throw new BadRequestException(
              "AUTHORIZED_REUSE applies only to a URL_REUSED fraud signal",
            )
          }

          const remainingHoldCount = await tx.deliveryFraudHold.count({
            where: {
              orderId: order.id,
              fraudFlagId: { not: fraudFlagId },
            },
          })

          const resolution = await tx.deliveryFraudFlagResolution.create({
            data: {
              fraudFlagId,
              orderId: flag.orderId,
              deliveryVersionId: flag.deliveryVersionId,
              kind: "STAFF_CLEARED",
              reason: r,
              resolvedByUserId: userId,
              resolvedByRole: currentRole,
              evidence: {
                activeDeliveryVersionId: order.activeDeliveryVersionId,
                adjudicatedDeliveryVersionId: flag.deliveryVersionId,
                fraudType: flag.type,
                disposition,
                evidenceReference: normalizedEvidenceReference,
                orderStatusAtResolution: order.status,
                roleAtTime: currentRole,
                blockedAfterDecision: remainingHoldCount > 0,
              },
            },
          })
          await this.audit.log(
            {
              action: "ORDER_DELIVERY_FRAUD_RESOLVED",
              entityType: "DeliveryFraudFlag",
              entityId: fraudFlagId,
              metadata: {
                ...orderEventMetadata(order),
                fraudFlagId,
                fraudDeliveryVersionId: flag.deliveryVersionId,
                fraudType: flag.type,
                resolutionId: resolution.id,
                resolutionKind: "STAFF_CLEARED",
                disposition,
                evidenceReference: normalizedEvidenceReference,
                reason: r,
                roleAtTime: currentRole,
              },
              userId,
              organizationId: order.organizationId,
            },
            tx,
          )
          const communicationDedupKeys =
            await this.recordClearedFraudCommunications(tx, {
              order,
              flag,
              resolution,
              actorUserId: userId,
            })
          return {
            status: "RESOLVED" as const,
            fraudFlagId,
            resolutionId: resolution.id,
            communicationDedupKeys,
          }
        },
      )

    try {
      committed = await runResolution()
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      try {
        committed = await runResolution()
      } catch (replayError) {
        if (!isUniqueViolation(replayError)) throw replayError
        throw new ConflictException({
          code: "DELIVERY_FRAUD_DECISION_CONFLICT",
          message:
            "Another fraud decision won concurrently. Refresh before retrying.",
        })
      }
    }

    this.communications.dispatchManyByDedupKeyBestEffort(
      committed.communicationDedupKeys,
    )
    const { communicationDedupKeys: _communicationDedupKeys, ...result } =
      committed
    return result
  }

  // Phase 6.9 — Audit finding #4 closure. The legacy `auditMeta` helper has
  // been retired in favor of `orderEventMetadata` from @guestpost/shared. The
  // shared helper supplies the Phase 6 snapshot trio uniformly across every
  // money-audit callsite; the delivery-specific extras (deliveryVersionId,
  // publishedUrl, publisherId) are appended on top. Reports that group audit
  // rows by serviceType / fulfillmentChannel / listingServiceId now see this
  // surface consistently.
  private deliveryAuditMeta(
    order: any,
    version: any,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ...orderEventMetadata(order),
      orderId: order.id,
      deliveryVersionId: version.id,
      publisherId: order.website?.publisherId ?? null,
      publishedUrl: version.publishedUrl,
      ...extra,
    }
  }

  // Phase 7.4 (audit #12) — `deliveryVersionId` flows in so we can key the
  // dedup uniquely per (version, recipient). A worker retry of the same
  // delivery decision writes the row once.
  private async notifyOrderParties(
    order: any,
    deliveryVersionId: string,
    type: string,
    message: string,
  ) {
    const ids = new Set<string>([order.customerId])
    if (order.website?.publisherId) {
      const owners = await this.prisma.publisherMembership.findMany({
        where: {
          publisherId: order.website.publisherId,
          role: "PUBLISHER_OWNER",
        },
        select: { userId: true },
      })
      owners.forEach((o: any) => ids.add(o.userId))
    }
    for (const userId of ids) {
      const dedupKey = notificationDedupKey.deliveryManual(
        deliveryVersionId,
        userId,
      )
      try {
        await this.prisma.notification.create({
          data: {
            userId,
            organizationId: order.organizationId,
            type,
            message,
            dedupKey,
          },
        })
      } catch (err) {
        // P2002 = already notified for this (version, user). Idempotent retry.
        if (!isUniqueViolation(err)) {
          // swallow other errors as before — notification is best-effort
        }
      }
    }
  }

  // FAILED | MANUAL_REVIEW -> APPROVED (treated as verified for settlement).
  async manualApprove(
    deliveryVersionId: string,
    userId: string,
    role: string,
    reason: string,
    context?: {
      overrideReason?:
        | "CRAWLER_BLOCKED"
        | "ROBOTS_TXT"
        | "LOGIN_REQUIRED"
        | "JS_RENDERING"
        | "TEMPORARY_FAILURE"
        | "OTHER"
      notes?: string
    },
  ) {
    const r = this.requireReason(reason)
    const now = new Date()
    const autoAcceptAt = new Date(
      now.getTime() +
        this.decision.computeReviewWindowDays() * 24 * 60 * 60 * 1000,
    )
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    if (!["FAILED", "MANUAL_REVIEW"].includes(version.verificationStatus)) {
      throw new BadRequestException(
        `Only FAILED or MANUAL_REVIEW deliveries can be manually approved (is ${version.verificationStatus})`,
      )
    }
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN", "OPERATIONS"],
        )
        const { currentOrder, currentVersion } =
          await this.loadActiveVersionUnderLock(
            tx,
            order.id,
            version.id,
            version.verificationVersion,
          )
        if (
          !["FAILED", "MANUAL_REVIEW"].includes(
            currentVersion.verificationStatus,
          ) ||
          currentOrder.status !== "PUBLISHED"
        ) {
          throw new ConflictException(
            "Delivery or order state changed. Refresh before approving.",
          )
        }
        await assertNoUnresolvedDeliveryFraudHolds(tx, order.id)
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            interventionStatus: "APPROVED",
            verificationFailureReason: null,
            verificationVersion: version.verificationVersion + 1,
            adminVerifiedById: userId,
            adminOverrideReason: context?.overrideReason ?? null,
            adminVerifiedNotes: context?.notes?.trim() || null,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }

        const orderUpdate = await tx.order.updateMany({
          where: {
            id: order.id,
            status: "PUBLISHED",
            version: currentOrder.version,
            activeDeliveryVersionId: version.id,
          },
          data: {
            status: "VERIFIED",
            verifiedAt: now,
            verifiedBy: userId,
            verifyMethod: "MANUAL_ADMIN",
            autoAcceptAt,
            version: { increment: 1 },
          },
        })
        if (orderUpdate.count === 0) {
          throw new ConflictException(
            "Order was modified by another request. Refresh and retry.",
          )
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "VERIFIED_MANUAL",
            actorId: userId,
            message: "Delivery manually verified by staff",
            metadata: {
              deliveryVersionId: version.id,
              reason: r,
              overrideReason: context?.overrideReason ?? null,
              notes: context?.notes?.trim() || null,
              autoAcceptAt: autoAcceptAt.toISOString(),
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_MANUAL_APPROVED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              roleAtTime: currentRole,
              overrideReason: context?.overrideReason ?? null,
              notes: context?.notes?.trim() || null,
              autoAcceptAt: autoAcceptAt.toISOString(),
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_MANUAL_APPROVED",
      `Delivery for order ${order.id} was manually approved.`,
    )
    return {
      status: "VERIFIED",
      interventionStatus: "APPROVED",
      verifyMethod: "MANUAL_ADMIN",
      autoAcceptAt,
    }
  }

  async manualReject(
    deliveryVersionId: string,
    userId: string,
    role: string,
    reason: string,
  ) {
    const r = this.requireReason(reason)
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN", "OPERATIONS"],
        )
        await this.loadActiveVersionUnderLock(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        const mutableOrder = await this.assertDeliveryEvidenceMutable(
          tx,
          order.id,
          "reject",
        )
        if (mutableOrder.status !== "PUBLISHED") {
          throw new ConflictException(
            "Only a published delivery awaiting verification can be rejected.",
          )
        }
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            interventionStatus: "REJECTED",
            verificationFailureReason: r,
            verificationVersion: version.verificationVersion + 1,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: "VERIFICATION_ESCALATED",
            actorId: userId,
            message: "Delivery rejected during manual verification",
            metadata: { deliveryVersionId: version.id, reason: r },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_MANUAL_REJECTED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              roleAtTime: currentRole,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_MANUAL_REJECTED",
      `Delivery for order ${order.id} was rejected: ${r}`,
    )
    return { status: "REJECTED" }
  }

  // SUPER_ADMIN-only flip FAILED<->VERIFIED.
  async override(
    deliveryVersionId: string,
    userId: string,
    role: string,
    targetStatus: "VERIFIED" | "FAILED",
    reason: string,
  ) {
    if (role !== "SUPER_ADMIN")
      throw new ForbiddenException("Only SUPER_ADMIN may override verification")
    const r = this.requireReason(reason)
    if (!["VERIFIED", "FAILED"].includes(targetStatus))
      throw new BadRequestException(
        "Override target must be VERIFIED or FAILED",
      )
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    const now = new Date()
    const autoAcceptAt = new Date(
      now.getTime() +
        this.decision.computeReviewWindowDays() * 24 * 60 * 60 * 1000,
    )

    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        const currentRole = await assertCurrentStaffAuthority(
          tx,
          userId,
          role,
          ["SUPER_ADMIN"],
        )
        if (targetStatus === "FAILED") {
          await this.assertDeliveryEvidenceMutable(tx, order.id, "override")
        }
        const { currentOrder } = await this.loadActiveVersionUnderLock(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        if (
          (targetStatus === "VERIFIED" &&
            currentOrder.status !== "PUBLISHED") ||
          (targetStatus === "FAILED" && currentOrder.status !== "VERIFIED")
        ) {
          throw new ConflictException(
            "Order state changed. Refresh before overriding verification.",
          )
        }
        if (targetStatus === "VERIFIED") {
          await assertNoUnresolvedDeliveryFraudHolds(tx, order.id)
        }
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            verificationStatus: targetStatus,
            interventionStatus: "OVERRIDDEN",
            verificationFailureReason: targetStatus === "FAILED" ? r : null,
            verificationVersion: version.verificationVersion + 1,
          },
        })
        if (upd.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }

        if (targetStatus === "VERIFIED") {
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "PUBLISHED",
              version: currentOrder.version,
              activeDeliveryVersionId: version.id,
            },
            data: {
              status: "VERIFIED",
              verifiedAt: now,
              verifiedBy: userId,
              verifyMethod: "MANUAL_ADMIN",
              autoAcceptAt,
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0) {
            throw new ConflictException(
              "Order was modified by another request. Refresh and retry.",
            )
          }
        } else if (currentOrder.status === "VERIFIED") {
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "VERIFIED",
              version: currentOrder.version,
              activeDeliveryVersionId: version.id,
            },
            data: {
              status: "PUBLISHED",
              verifiedAt: null,
              verifiedBy: null,
              verifyMethod: null,
              autoAcceptAt: null,
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0) {
            throw new ConflictException(
              "Order was modified by another request. Refresh and retry.",
            )
          }
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType:
              targetStatus === "VERIFIED"
                ? "VERIFIED_MANUAL"
                : "VERIFICATION_ESCALATED",
            actorId: userId,
            message:
              targetStatus === "VERIFIED"
                ? "Delivery verification overridden to verified"
                : "Delivery verification overridden to failed",
            metadata: {
              deliveryVersionId: version.id,
              reason: r,
              targetStatus,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_OVERRIDDEN",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reason: r,
              targetStatus,
              roleAtTime: currentRole,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    await this.notifyOrderParties(
      order,
      version.id,
      "ORDER_DELIVERY_OVERRIDDEN",
      `Delivery for order ${order.id} verification was overridden to ${targetStatus}.`,
    )
    return { status: targetStatus }
  }

  // Re-run automated verification (staff). Resets to PENDING + re-enqueues.
  async reverify(deliveryVersionId: string, userId: string, role: string) {
    const { version, order } =
      await this.loadVersionWithOrder(deliveryVersionId)
    if (version.supersededByVersion != null)
      throw new BadRequestException("Cannot re-verify a superseded delivery")
    await runLockedOrderSerializableTransaction(
      this.prisma,
      order.id,
      async (tx: any) => {
        await assertCurrentStaffAuthority(tx, userId, role, [
          "SUPER_ADMIN",
          "OPERATIONS",
        ])
        const mutableOrder = await this.assertDeliveryEvidenceMutable(
          tx,
          order.id,
          "re-verify",
        )
        if (mutableOrder.status !== "PUBLISHED") {
          throw new ConflictException(
            "Only a published delivery awaiting verification can be re-verified.",
          )
        }
        const currentVersion = await tx.orderDeliveryVersion.findUnique({
          where: { id: version.id },
          select: { supersededByVersion: true },
        })
        if (!currentVersion) {
          throw new NotFoundException("Delivery version not found")
        }
        if (currentVersion.supersededByVersion != null) {
          throw new BadRequestException(
            "Cannot re-verify a superseded delivery",
          )
        }
        const updated = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            verificationVersion: version.verificationVersion,
            supersededByVersion: null,
          },
          data: {
            verificationStatus: "PENDING",
            interventionStatus: "NONE",
            verificationFailureReason: null,
            verificationVersion: version.verificationVersion + 1,
            adminVerifiedById: null,
            adminOverrideReason: null,
            adminVerifiedNotes: null,
          },
        })
        if (updated.count === 0) {
          throw new ConflictException(
            "Delivery was modified by another request. Retry.",
          )
        }
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_VERIFICATION_STARTED",
            entityType: "OrderDeliveryVersion",
            entityId: version.id,
            metadata: this.deliveryAuditMeta(order, version, {
              reverify: true,
            }),
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
      },
    )
    const nextVerificationVersion = version.verificationVersion + 1
    try {
      await this.queue.addJob(
        QUEUES.DELIVERY_VERIFICATION,
        QUEUE_JOBS[QUEUES.DELIVERY_VERIFICATION].VERIFY,
        {
          deliveryVersionId: version.id,
          verificationVersion: nextVerificationVersion,
          actorUserId: userId,
        },
        {
          jobId: deliveryVerificationJobId(version.id, nextVerificationVersion),
          attempts: 3,
          backoff: { type: "custom" },
        },
      )
    } catch (error) {
      this.logger.error(
        `Delivery ${version.id} re-verification committed but enqueue failed; the dispatch sweep will recover it`,
        error instanceof Error ? error.stack : String(error),
      )
      throw new ServiceUnavailableException({
        code: "DELIVERY_VERIFICATION_ENQUEUE_FAILED",
        message:
          "Re-verification was saved, but immediate dispatch failed. The recovery sweep will retry automatically.",
        deliveryVersionId: version.id,
      })
    }
    return { status: "PENDING" }
  }

  // ── Evidence retrieval ────────────────────────────────────────────────────
  async orderEvidence(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      orderBy: { version: "desc" },
      include: { evidence: { orderBy: { createdAt: "desc" } } },
    })
    return versions
  }

  async orderSnapshots(orderId: string) {
    const versions = await this.prisma.orderDeliveryVersion.findMany({
      where: { orderId },
      select: { id: true, version: true, snapshots: true },
    })
    // Presign object keys for time-limited download
    const out = []
    for (const v of versions) {
      for (const s of v.snapshots) {
        out.push({
          deliveryVersionId: v.id,
          version: v.version,
          snapshotId: s.id,
          htmlUrl: await presignGet(s.htmlObjectKey).catch(() => null),
          screenshotUrl: s.screenshotObjectKey
            ? await presignGet(s.screenshotObjectKey).catch(() => null)
            : null,
          responseHeaders: s.responseHeaders,
          createdAt: s.createdAt,
        })
      }
    }
    return out
  }

  async orderAudit(orderId: string) {
    const versionIds = (
      await this.prisma.orderDeliveryVersion.findMany({
        where: { orderId },
        select: { id: true },
      })
    ).map((v: any) => v.id)
    return this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: "Order", entityId: orderId },
          { entityType: "OrderDeliveryVersion", entityId: { in: versionIds } },
          {
            entityType: "FulfillmentAssignment",
            metadata: { path: ["orderId"], equals: orderId },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
  }

  // Full dispute evidence package — reviewers never reconstruct history.
  async disputeEvidencePackage(orderId: string) {
    const [versions, snapshots, audit, dispute, fraudFlags, notifications] =
      await Promise.all([
        this.prisma.orderDeliveryVersion.findMany({
          where: { orderId },
          orderBy: { version: "desc" },
          include: { evidence: { orderBy: { createdAt: "desc" } } },
        }),
        this.orderSnapshots(orderId),
        this.orderAudit(orderId),
        this.prisma.orderDispute
          .findUnique({ where: { orderId } })
          .catch(() => null),
        this.prisma.deliveryFraudFlag.findMany({
          where: { orderId },
          include: { resolution: true },
        }),
        this.prisma.orderEvent.findMany({
          where: { orderId },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      ])
    return {
      dispute,
      versions,
      snapshots,
      fraudFlags,
      auditTrail: audit,
      timeline: notifications,
    }
  }
}
