import {
  CancellationReasonCode,
  CancellationRequestStatus,
  CancellationResolution,
  CancellationResponsibility,
  Prisma,
} from "@guestpost/database"
import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  decideOrderCancellation,
  isPostPublicationPublisherOrder,
  isSupportedMoneyCurrency,
  orderEventMetadata,
  resolveOrderCancellationConfig,
  runLockedOrderSerializableTransaction,
  USD_CURRENCY,
} from "@guestpost/shared"
import { FinalRefundResponsibility } from "@guestpost/shared/dist/order-refund-core"
import { lockWalletForUpdate } from "@guestpost/shared/dist/payment-dispute-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../../common/finance-runtime-mode"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { CommunicationsService } from "../../communications/communications.service"
import { QueueService } from "../../queues/queue.service"
import {
  CancellationResponseAction,
  CancelOrderDto,
  CreateCancellationRequestDto,
  FinanceApproveCancellationDto,
  ForceCancelOrderDto,
  RespondCancellationRequestDto,
  ReviewCancellationRequestDto,
} from "../dto/order-cancellation.dto"
import { assertOwnerOrCreator } from "./owner-or-creator"
import { RefundService } from "./refund.service"

const TERMINAL_ORDER_STATUSES = ["CANCELLED", "REFUNDED"] as const
const CANCELLATION_REQUEST_LOOKUP_ID = /^[A-Za-z0-9_-]{1,128}$/
const FINANCE_CANCELLATION_APPROVED_EVENT_MESSAGE =
  "Cancellation refund approved by Finance"

export interface CancellationActorContext {
  userId: string
  kind: "CUSTOMER" | "PUBLISHER" | "STAFF" | "SYSTEM"
  organizationId?: string | null
  publisherId?: string | null
  customerRole?: string | null
  publisherRole?: string | null
  staffRole?: string | null
}

@Injectable()
export class OrderCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refund: RefundService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  async preview(orderId: string, actor: CancellationActorContext) {
    const order = await this.loadOrder(this.prisma, orderId)
    this.assertActorCanAccess(order, actor)
    const channel = this.channelFor(order)
    const activeRequest = order.cancellationRequests[0] ?? null
    const activeDispute = this.hasActiveDispute(order)
    const policyDecision = decideOrderCancellation({
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentChannel: channel,
      actor: actor.kind,
      hasActiveRequest: Boolean(activeRequest),
      hasActiveDispute: Boolean(activeDispute),
      fulfillmentDueAt: order.fulfillmentDueAt,
      warrantyEndsAt: order.warrantyEndsAt,
    })
    const actorCanMutate = this.actorCanMutate(order, actor)
    const decision = actorCanMutate
      ? policyDecision
      : {
          ...policyDecision,
          action: "NOT_ALLOWED" as const,
          refundRequired: false,
          requiresCounterpartyResponse: false,
          message:
            actor.kind === "PUBLISHER"
              ? "Only a publisher owner can perform cancellation actions."
              : "Only the organization owner or original order creator can perform cancellation actions.",
        }

    return {
      ...decision,
      actorCanMutate,
      orderId,
      status: order.status,
      expectedVersion: order.version,
      fulfillmentChannel: channel,
      refund: {
        type: decision.refundRequired ? "FULL" : "NONE",
        amount: decision.refundRequired ? Number(order.amount ?? 0) : 0,
        currency: order.currency,
        destination: decision.refundRequired ? "WALLET" : null,
      },
      activeRequest,
      deadlines: {
        fulfillmentDueAt: order.fulfillmentDueAt,
        warrantyEndsAt: order.warrantyEndsAt,
        fulfillmentOverdue: this.deadlineExpired(order.fulfillmentDueAt),
      },
    }
  }

  async cancelNow(
    orderId: string,
    actor: CancellationActorContext,
    body: CancelOrderDto,
  ) {
    if (actor.kind !== "CUSTOMER") {
      throw new ForbiddenException("Only the customer can cancel this order")
    }

    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        const order = await this.loadOrder(tx, orderId)
        await this.assertFreshActorAuthority(tx, actor)
        // Authorization must precede the idempotency lookup and replay return;
        // knowing another tenant's order ID and command key is not access.
        this.assertActorCanAccess(order, actor)
        assertOwnerOrCreator({
          customerId: order.customerId,
          actorUserId: actor.userId,
          actorRole: actor.customerRole,
          action: "cancel order",
        })
        const replay = body.idempotencyKey
          ? await tx.transaction.findFirst({
              where: {
                reference: `customer-cancel:${orderId}:${body.idempotencyKey}`,
              },
            })
          : null
        if (replay) {
          // Route exact replays through the canonical evidence assertion and
          // communication repair path. This repairs pre-communications refunds
          // without crediting the wallet or creating a second REFUND row.
          const repaired = await this.refund.refundOrderInTransaction(
            tx,
            order,
            this.reasonText(body.reasonCode, body.note),
            actor.userId,
            `customer-cancel:${orderId}:${body.idempotencyKey}`,
            "SYSTEM",
          )
          return repaired.order
        }

        this.assertExpectedVersion(order.version, body.expectedVersion)

        const decision = decideOrderCancellation({
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentChannel: this.channelFor(order),
          actor: "CUSTOMER",
          hasActiveRequest: order.cancellationRequests.length > 0,
          hasActiveDispute: this.hasActiveDispute(order),
          fulfillmentDueAt: order.fulfillmentDueAt,
          warrantyEndsAt: order.warrantyEndsAt,
        })
        if (decision.action !== "CANCEL_NOW") {
          throw new BadRequestException(decision.message)
        }

        if (decision.refundRequired) {
          const responsibility = this.immediateCustomerResponsibility(
            order,
            body.reasonCode,
          )
          const result = await this.refund.refundOrderInTransaction(
            tx,
            order,
            this.reasonText(body.reasonCode, body.note),
            actor.userId,
            `customer-cancel:${orderId}:${body.idempotencyKey ?? order.version}`,
            responsibility,
          )
          return result.order
        }

        return this.cancelUnpaidInTransaction(
          tx,
          order,
          actor.userId,
          body.reasonCode,
          body.note,
          "CUSTOMER",
        )
      },
    )
    this.refund.dispatchOrderRefundCommunicationsBestEffort(orderId)
    this.communications?.dispatchByDedupKeyBestEffort(
      `order:${orderId}:cancelled`,
    )
    return result
  }

  async decline(
    orderId: string,
    actor: CancellationActorContext,
    body: CancelOrderDto,
  ) {
    if (actor.kind !== "PUBLISHER" && actor.kind !== "STAFF") {
      throw new ForbiddenException("Only the fulfiller can decline an order")
    }
    if (actor.kind === "PUBLISHER") {
      this.assertPublisherOwner(actor, "decline order")
    }

    let publisherId: string | null = null
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        const order = await this.loadOrder(tx, orderId)
        await this.assertFreshActorAuthority(tx, actor)
        this.assertActorCanAccess(order, actor)
        this.assertExpectedVersion(order.version, body.expectedVersion)
        const channel = this.channelFor(order)
        const decision = decideOrderCancellation({
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentChannel: channel,
          actor: actor.kind,
          hasActiveRequest: order.cancellationRequests.length > 0,
          hasActiveDispute: this.hasActiveDispute(order),
          fulfillmentDueAt: order.fulfillmentDueAt,
          warrantyEndsAt: order.warrantyEndsAt,
        })
        if (decision.action !== "DECLINE_NOW") {
          throw new BadRequestException(decision.message)
        }

        const responsibility =
          channel === "PUBLISHER" ? "PUBLISHER" : "PLATFORM"
        publisherId = order.website?.publisherId ?? null
        const refunded = await this.refund.refundOrderInTransaction(
          tx,
          order,
          this.reasonText(body.reasonCode, body.note),
          actor.userId,
          `decline:${orderId}:${body.idempotencyKey ?? order.version}`,
          responsibility,
        )

        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "ORDER_DECLINED",
            actorId: actor.userId,
            message: "Unaccepted order declined by fulfiller",
            metadata: {
              reasonCode: body.reasonCode,
              note: body.note,
              responsibility,
            },
          },
        })
        return refunded.order
      },
    )
    this.refund.dispatchOrderRefundCommunicationsBestEffort(orderId)

    if (publisherId) {
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "ORDER_DECLINED",
        `publisher declined order ${orderId}`,
      )
    }
    return result
  }

  async createRequest(
    orderId: string,
    actor: CancellationActorContext,
    body: CreateCancellationRequestDto,
  ) {
    let result: any
    try {
      result = await runLockedOrderSerializableTransaction(
        this.prisma,
        orderId,
        async (tx: any) => {
          const order = await this.loadOrder(tx, orderId)
          await this.assertFreshActorAuthority(tx, actor)
          this.assertActorCanAccess(order, actor)
          if (actor.kind === "CUSTOMER") {
            assertOwnerOrCreator({
              customerId: order.customerId,
              actorUserId: actor.userId,
              actorRole: actor.customerRole,
              action: "request cancellation",
            })
          } else if (actor.kind === "PUBLISHER") {
            this.assertPublisherOwner(actor, "request cancellation")
          }
          this.assertExpectedVersion(order.version, body.expectedVersion)

          const channel = this.channelFor(order)
          const decision = decideOrderCancellation({
            status: order.status,
            paymentStatus: order.paymentStatus,
            fulfillmentChannel: channel,
            actor: actor.kind,
            hasActiveRequest: order.cancellationRequests.length > 0,
            hasActiveDispute: this.hasActiveDispute(order),
            fulfillmentDueAt: order.fulfillmentDueAt,
            warrantyEndsAt: order.warrantyEndsAt,
          })
          if (decision.action !== "REQUEST_CANCELLATION") {
            throw new BadRequestException(decision.message)
          }

          const { responseWindowHours } = resolveOrderCancellationConfig(
            process.env,
          )
          const responseDeadlineAt = new Date(
            Date.now() + responseWindowHours * 60 * 60 * 1000,
          )
          const responsibility = this.initialResponsibility(
            actor.kind,
            body.reasonCode,
            channel,
            order,
          )
          // Claim the order version without changing its lifecycle status. Any
          // fulfillment transition racing this request must lose its optimistic
          // lock, while a transition that committed first makes this request
          // retry against fresh policy state.
          const held = await tx.order.updateMany({
            where: {
              id: orderId,
              version: order.version,
              status: order.status,
            },
            data: { version: { increment: 1 } },
          })
          if (held.count === 0) {
            throw new ConflictException(
              "Order changed while cancellation was requested. Refresh and retry.",
            )
          }
          const request = await tx.orderCancellationRequest.create({
            data: {
              orderId,
              requestedByUserId: actor.userId,
              requesterType: actor.kind,
              actorSnapshot: {
                userId: actor.userId,
                kind: actor.kind,
                customerRole: actor.customerRole ?? null,
                publisherRole: actor.publisherRole ?? null,
                staffRole: actor.staffRole ?? null,
              },
              reasonCode: body.reasonCode,
              note: body.note,
              previousOrderStatus: order.status,
              fulfillmentChannel: channel,
              responsibility,
              responseDeadlineAt,
              idempotencyKey: body.idempotencyKey,
            },
          })

          await tx.orderEvent.create({
            data: {
              orderId,
              eventType: "CANCELLATION_REQUESTED",
              actorId: actor.userId,
              message: "Cancellation requested; fulfillment is paused",
              metadata: {
                requestId: request.id,
                reasonCode: body.reasonCode,
                requesterType: actor.kind,
                responseDeadlineAt: responseDeadlineAt.toISOString(),
              },
            },
          })
          await this.audit.log(
            {
              action: "ORDER_CANCELLATION_REQUESTED",
              entityType: "OrderCancellationRequest",
              entityId: request.id,
              metadata: {
                orderId,
                fromStatus: order.status,
                reasonCode: body.reasonCode,
                ...orderEventMetadata(order),
              },
              userId: actor.userId,
              organizationId: order.organizationId,
            },
            tx,
          )
          await this.notifyCounterparty(
            tx,
            order,
            actor.kind,
            actor.userId,
            request.id,
          )
          return request
        },
      )
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new ConflictException(
          "A cancellation request is already active for this order",
        )
      }
      throw error
    }
    this.communications?.dispatchByDedupKeyBestEffort(
      `cancel-request:${result.id}:counterparty`,
    )
    return result
  }

  async respond(
    orderId: string,
    requestId: string,
    actor: CancellationActorContext,
    body: RespondCancellationRequestDto,
  ) {
    let publisherId: string | null = null
    let responsibility: CancellationResponsibility | null = null
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        await this.assertFreshActorAuthority(tx, actor)
        const request = await tx.orderCancellationRequest.findFirst({
          where: { id: requestId, orderId },
          include: {
            order: {
              include: {
                website: {
                  select: { ownershipType: true, publisherId: true },
                },
                fulfillmentAssignments: {
                  where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
                  select: { assignedToUserId: true },
                  take: 1,
                },
              },
            },
          },
        })
        if (!request)
          throw new NotFoundException("Cancellation request not found")
        if (request.status !== "REQUESTED") {
          throw new ConflictException(
            "Cancellation request already responded to",
          )
        }
        this.assertCounterparty(request, actor)
        const order = request.order
        publisherId = order.website?.publisherId ?? null

        if (body.action === CancellationResponseAction.ACCEPT) {
          const resolvedResponsibility =
            request.responsibility === CancellationResponsibility.UNDETERMINED
              ? CancellationResponsibility.SHARED
              : request.responsibility
          responsibility = resolvedResponsibility
          const refunded = await this.refund.refundOrderInTransaction(
            tx,
            order,
            `Mutually accepted cancellation: ${request.reasonCode}${body.note ? ` — ${body.note}` : ""}`,
            actor.userId,
            `cancellation-request:${request.id}`,
            resolvedResponsibility,
          )
          const resolved = await tx.orderCancellationRequest.updateMany({
            where: { id: request.id, status: "REQUESTED" },
            data: {
              status: "APPROVED",
              respondedByUserId: actor.userId,
              responseNote: body.note,
              responsibility: resolvedResponsibility,
              resolution: "FULL_REFUND",
              resolutionReason: "Counterparty accepted the cancellation",
              refundTransactionId: refunded.refundTransactionId,
              resolvedAt: new Date(),
            },
          })
          if (resolved.count === 0) this.concurrentRequestError()
        } else {
          const contested = await tx.orderCancellationRequest.updateMany({
            where: { id: request.id, status: "REQUESTED" },
            data: {
              status: "UNDER_REVIEW",
              respondedByUserId: actor.userId,
              responseNote: body.note,
            },
          })
          if (contested.count === 0) this.concurrentRequestError()
        }

        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "CANCELLATION_RESPONDED",
            actorId: actor.userId,
            message:
              body.action === CancellationResponseAction.ACCEPT
                ? "Cancellation accepted; full wallet refund issued"
                : "Cancellation contested; case sent for staff review",
            metadata: { requestId, action: body.action, note: body.note },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_CANCELLATION_RESPONDED",
            entityType: "OrderCancellationRequest",
            entityId: requestId,
            metadata: { orderId, action: body.action },
            userId: actor.userId,
            organizationId: order.organizationId,
          },
          tx,
        )
        await this.recordCancellationCommunication(
          tx,
          order,
          requestId,
          "ORDER_CANCELLATION_RESPONDED",
          "Cancellation request updated",
          body.action === CancellationResponseAction.ACCEPT
            ? `Cancellation for order ${orderId} was accepted and the refund was issued.`
            : `Cancellation for order ${orderId} was contested and sent for staff review.`,
          actor.userId,
        )
        return tx.orderCancellationRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      },
    )

    this.refund.dispatchOrderRefundCommunicationsBestEffort(orderId)
    this.communications?.dispatchByDedupKeyBestEffort(
      `cancel-request:${requestId}:order_cancellation_responded`,
    )
    if (responsibility === "PUBLISHER" && publisherId) {
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "REFUND_ISSUED",
        `publisher-attributed cancellation ${requestId}`,
      )
    }
    return result
  }

  async review(
    requestId: string,
    staffUserId: string,
    claimedStaffRole: string | null,
    body: ReviewCancellationRequestDto,
  ) {
    const reviewReason = body.reason?.trim()
    if (!reviewReason || reviewReason.length < 20) {
      throw new BadRequestException(
        "Cancellation review reason must be at least 20 characters",
      )
    }
    if (reviewReason.length > 2000) {
      throw new BadRequestException(
        "Cancellation review reason must be 2,000 characters or fewer",
      )
    }
    const preflight = await this.prisma.orderCancellationRequest.findUnique({
      where: { id: requestId },
      select: { orderId: true },
    })
    if (!preflight) {
      throw new NotFoundException("Cancellation request not found")
    }

    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      preflight.orderId,
      async (tx: any) => {
        await this.assertCurrentCancellationStaffAuthority(
          tx,
          staffUserId,
          claimedStaffRole,
          ["OPERATIONS", "SUPER_ADMIN"],
          "Current Operations or Super Admin authority is required",
        )
        const request = await tx.orderCancellationRequest.findUnique({
          where: { id: requestId },
          include: { order: true },
        })
        if (!request)
          throw new NotFoundException("Cancellation request not found")
        if (request.orderId !== preflight.orderId) {
          throw new ConflictException(
            "Cancellation request changed order ownership while review was starting",
          )
        }
        const confirmedFraudFinding = await tx.deliveryFraudFinding.findFirst({
          where: { cancellationRequestId: request.id },
          select: { id: true },
        })

        if (
          confirmedFraudFinding &&
          request.status === "PENDING_FINANCE" &&
          body.resolution === CancellationResolution.FULL_REFUND &&
          request.resolution === body.resolution &&
          request.responsibility === body.responsibility &&
          request.resolutionReason === reviewReason &&
          request.reviewedByUserId === staffUserId
        ) {
          // Exact response-loss replay. The original transaction already
          // committed its event and audit evidence; never append duplicates.
          return tx.orderCancellationRequest.findUniqueOrThrow({
            where: { id: requestId },
          })
        }
        if (!["UNDER_REVIEW", "ESCALATED"].includes(request.status)) {
          throw new BadRequestException(
            "Cancellation request is not awaiting review",
          )
        }
        if (
          confirmedFraudFinding &&
          body.resolution !== CancellationResolution.FULL_REFUND
        ) {
          throw new ConflictException({
            code: "CONFIRMED_FRAUD_REFUND_REQUIRED",
            message:
              "A cancellation linked to confirmed fraud must proceed to Finance for a full refund",
          })
        }

        if (body.resolution === CancellationResolution.FULL_REFUND) {
          this.assertFinalResponsibility(body.responsibility)
          await tx.orderCancellationRequest.update({
            where: { id: requestId },
            data: {
              status: "PENDING_FINANCE",
              reviewedByUserId: staffUserId,
              responsibility: body.responsibility,
              resolution: body.resolution,
              resolutionReason: reviewReason,
            },
          })
        } else if (body.resolution === CancellationResolution.CONTINUE_ORDER) {
          await tx.orderCancellationRequest.update({
            where: { id: requestId },
            data: {
              status: "REJECTED",
              reviewedByUserId: staffUserId,
              responsibility: body.responsibility,
              resolution: body.resolution,
              resolutionReason: reviewReason,
              resolvedAt: new Date(),
            },
          })
        } else {
          const existingDispute = await tx.orderDispute.findUnique({
            where: { orderId: request.orderId },
          })
          if (existingDispute) {
            throw new ConflictException(
              "This order already has a dispute record; resolve it instead",
            )
          }
          await tx.orderDispute.create({
            data: {
              orderId: request.orderId,
              raisedBy: request.requestedByUserId ?? staffUserId,
              reason: reviewReason,
              previousStatus: request.order.status,
            },
          })
          const transitioned = await tx.order.updateMany({
            where: {
              id: request.orderId,
              version: request.order.version,
              status: request.previousOrderStatus,
            },
            data: { status: "DISPUTED", version: { increment: 1 } },
          })
          if (transitioned.count === 0) {
            throw new ConflictException(
              "Order changed while the cancellation was reviewed. Retry.",
            )
          }
          await tx.orderCancellationRequest.update({
            where: { id: requestId },
            data: {
              status: "DISPUTED",
              reviewedByUserId: staffUserId,
              responsibility: body.responsibility,
              resolution: body.resolution,
              resolutionReason: reviewReason,
              resolvedAt: new Date(),
            },
          })
        }

        await tx.orderEvent.create({
          data: {
            orderId: request.orderId,
            eventType: "CANCELLATION_RESOLVED",
            actorId: staffUserId,
            message: `Cancellation review: ${body.resolution}`,
            metadata: {
              requestId,
              resolution: body.resolution,
              responsibility: body.responsibility,
              pendingFinance:
                body.resolution === CancellationResolution.FULL_REFUND,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_CANCELLATION_REVIEWED",
            entityType: "OrderCancellationRequest",
            entityId: requestId,
            metadata: {
              orderId: request.orderId,
              resolution: body.resolution,
              responsibility: body.responsibility,
              reason: reviewReason,
            },
            userId: staffUserId,
            organizationId: request.order.organizationId,
          },
          tx,
        )
        await this.recordCancellationCommunication(
          tx,
          request.order,
          requestId,
          "ORDER_CANCELLATION_RESOLVED",
          "Cancellation review completed",
          `Cancellation review for order ${request.orderId} was resolved as ${body.resolution}.`,
          staffUserId,
        )
        return tx.orderCancellationRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      },
    )
    this.communications?.dispatchByDedupKeyBestEffort(
      `cancel-request:${requestId}:order_cancellation_resolved`,
    )
    return result
  }

  async financeApprove(
    requestId: string,
    financeUserId: string,
    claimedStaffRole: string | null,
    body: FinanceApproveCancellationDto,
  ) {
    const financeReason = body.reason?.trim()
    if (!financeReason || financeReason.length < 20) {
      throw new BadRequestException(
        "Finance approval reason must be at least 20 characters",
      )
    }
    if (financeReason.length > 2000) {
      throw new BadRequestException(
        "Finance approval reason must be 2,000 characters or fewer",
      )
    }
    let publisherId: string | null = null
    let responsibility: CancellationResponsibility | null = null
    const preflight = await this.prisma.orderCancellationRequest.findUnique({
      where: { id: requestId },
      select: { orderId: true },
    })
    if (!preflight) {
      throw new NotFoundException("Cancellation request not found")
    }

    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      preflight.orderId,
      async (tx: any) => {
        await this.assertCurrentFinanceAuthority(
          tx,
          financeUserId,
          claimedStaffRole,
        )
        const request = await tx.orderCancellationRequest.findUnique({
          where: { id: requestId },
          include: {
            order: {
              include: {
                website: {
                  select: { ownershipType: true, publisherId: true },
                },
                settlements: {
                  where: { status: { not: "CANCELLED" } },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                  select: { id: true },
                },
              },
            },
          },
        })
        if (!request)
          throw new NotFoundException("Cancellation request not found")
        if (request.orderId !== preflight.orderId) {
          throw new ConflictException(
            "Cancellation request changed order ownership while approval was starting",
          )
        }
        if (
          request.status !== "PENDING_FINANCE" &&
          request.status !== "APPROVED"
        ) {
          throw new BadRequestException(
            "Cancellation is not pending finance approval",
          )
        }
        if (request.resolution !== CancellationResolution.FULL_REFUND) {
          throw new ConflictException({
            code: "CANCELLATION_FINANCE_STATE_INVALID",
            message:
              "Finance approval requires a reviewed full-refund recommendation",
          })
        }
        publisherId = request.order.website?.publisherId ?? null
        const resolvedResponsibility = this.assertFinalResponsibility(
          request.responsibility,
        )
        responsibility = resolvedResponsibility
        const refundReason = this.financeRefundReason(request, financeReason)
        const requiresPublisherCompensationDisposition =
          isPostPublicationPublisherOrder({
            fulfillmentChannel:
              request.fulfillmentChannel ?? request.order.fulfillmentChannel,
            websiteOwnershipType: request.order.website?.ownershipType,
            effectiveOrderStatus: request.previousOrderStatus,
            hasSettlement: (request.order.settlements?.length ?? 0) > 0,
          })
        if (
          !requiresPublisherCompensationDisposition &&
          body.publisherCompensation
        ) {
          throw new BadRequestException({
            code: "PUBLISHER_COMPENSATION_NOT_APPLICABLE",
            message:
              "Publisher compensation is not applicable to this cancellation",
          })
        }
        const publisherCompensationIntent =
          requiresPublisherCompensationDisposition
            ? {
                ...(body.publisherCompensation ?? {}),
                effectiveOrderStatus: request.previousOrderStatus,
              }
            : undefined
        const refunded = await this.refund.refundOrderInTransaction(
          tx,
          request.order,
          refundReason,
          financeUserId,
          `cancellation-request:${request.id}`,
          resolvedResponsibility,
          publisherCompensationIntent,
        )

        if (request.status === "APPROVED") {
          await this.assertExactFinanceApprovalReplay(tx, request, {
            financeUserId,
            financeReason,
            responsibility: resolvedResponsibility,
            refundTransactionId: refunded.refundTransactionId,
          })
          // The financial primitive repairs the refund/publisher projections.
          // Repair the cancellation audience with the same stable dedup key;
          // CommunicationsService.record is itself exact-key idempotent.
          await this.recordCancellationCommunication(
            tx,
            request.order,
            requestId,
            "ORDER_CANCELLATION_RESOLVED",
            "Cancellation refund approved",
            `The cancellation refund for order ${request.orderId} was approved.`,
            financeUserId,
          )
          return tx.orderCancellationRequest.findUniqueOrThrow({
            where: { id: requestId },
          })
        }

        await tx.orderCancellationRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            financeApprovedByUserId: financeUserId,
            refundTransactionId: refunded.refundTransactionId,
            resolvedAt: new Date(),
          },
        })
        await tx.orderEvent.create({
          data: {
            orderId: request.orderId,
            eventType: "CANCELLATION_RESOLVED",
            actorId: financeUserId,
            message: FINANCE_CANCELLATION_APPROVED_EVENT_MESSAGE,
            metadata: {
              requestId,
              responsibility,
              refundTransactionId: refunded.refundTransactionId,
            },
          },
        })
        await this.audit.log(
          {
            action: "ORDER_CANCELLATION_FINANCE_APPROVED",
            entityType: "OrderCancellationRequest",
            entityId: requestId,
            metadata: {
              orderId: request.orderId,
              responsibility,
              refundTransactionId: refunded.refundTransactionId,
              reason: financeReason,
            },
            userId: financeUserId,
            organizationId: request.order.organizationId,
          },
          tx,
        )
        await this.recordCancellationCommunication(
          tx,
          request.order,
          requestId,
          "ORDER_CANCELLATION_RESOLVED",
          "Cancellation refund approved",
          `The cancellation refund for order ${request.orderId} was approved.`,
          financeUserId,
        )
        return tx.orderCancellationRequest.findUniqueOrThrow({
          where: { id: requestId },
        })
      },
    )

    this.refund.dispatchOrderRefundCommunicationsBestEffort(preflight.orderId)
    this.communications?.dispatchByDedupKeyBestEffort(
      `cancel-request:${requestId}:order_cancellation_resolved`,
    )
    if (responsibility === "PUBLISHER" && publisherId) {
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "REFUND_ISSUED",
        `publisher-attributed cancellation ${requestId}`,
      )
    }
    return result
  }

  /**
   * Lock both rows that confer staff authority after the canonical Order lock.
   * This makes a concurrent ban or role change serialize with the approval and
   * prevents a cached request role from authorizing a financial mutation.
   */
  private async assertCurrentFinanceAuthority(
    tx: any,
    userId: string,
    claimedRole: string | null,
  ): Promise<void> {
    await this.assertCurrentCancellationStaffAuthority(
      tx,
      userId,
      claimedRole,
      ["FINANCE", "SUPER_ADMIN"],
      "Current Finance or Super Admin authority is required",
    )
  }

  private async assertCurrentCancellationStaffAuthority(
    tx: any,
    userId: string,
    claimedRole: string | null,
    allowedRoles: readonly string[],
    message: string,
  ): Promise<void> {
    const rows = (await tx.$queryRaw(
      Prisma.sql`
        SELECT sm."role"::text AS "role", u."banned", u."userType"::text AS "userType"
        FROM "StaffMembership" sm
        INNER JOIN "User" u ON u."id" = sm."userId"
        WHERE sm."userId" = ${userId}
        FOR UPDATE OF sm, u
      `,
    )) as Array<{ role: string; banned: boolean; userType: string }>
    const current = rows.length === 1 ? rows[0] : null
    if (
      !current ||
      current.banned ||
      current.userType !== "STAFF" ||
      current.role !== claimedRole ||
      !allowedRoles.includes(current.role)
    ) {
      throw new ForbiddenException(message)
    }
  }

  private financeRefundReason(request: any, financeReason: string): string {
    return `${request.resolutionReason ?? "Cancellation approved"} — Finance: ${financeReason}`
  }

  /**
   * APPROVED is a valid response-loss replay only when every immutable record
   * proves it is the same command. Missing or ambiguous evidence is treated as
   * corruption, never as permission to issue or acknowledge another refund.
   */
  private async assertExactFinanceApprovalReplay(
    tx: any,
    request: any,
    expected: {
      financeUserId: string
      financeReason: string
      responsibility: CancellationResponsibility
      refundTransactionId: string
    },
  ): Promise<void> {
    const mismatch = () =>
      new ConflictException({
        code: "CANCELLATION_FINANCE_REPLAY_MISMATCH",
        message:
          "Cancellation approval was already completed with different instructions",
      })

    if (
      request.status !== "APPROVED" ||
      request.resolution !== CancellationResolution.FULL_REFUND ||
      request.financeApprovedByUserId !== expected.financeUserId ||
      request.refundTransactionId !== expected.refundTransactionId ||
      request.responsibility !== expected.responsibility ||
      !request.resolvedAt
    ) {
      throw mismatch()
    }

    const [events, auditRows] = await Promise.all([
      tx.orderEvent.findMany({
        where: {
          orderId: request.orderId,
          eventType: "CANCELLATION_RESOLVED",
          metadata: { path: ["requestId"], equals: request.id },
        },
        select: { actorId: true, message: true, metadata: true },
      }),
      tx.auditLog.findMany({
        where: {
          action: "ORDER_CANCELLATION_FINANCE_APPROVED",
          entityType: "OrderCancellationRequest",
          entityId: request.id,
          userId: expected.financeUserId,
        },
        select: { metadata: true },
      }),
    ])
    const eventMatches = events.filter((event: any) => {
      const metadata = this.objectMetadata(event.metadata)
      return (
        event.actorId === expected.financeUserId &&
        event.message === FINANCE_CANCELLATION_APPROVED_EVENT_MESSAGE &&
        metadata?.requestId === request.id &&
        metadata?.responsibility === expected.responsibility &&
        metadata?.refundTransactionId === expected.refundTransactionId
      )
    })
    const auditMatches = auditRows.filter((row: any) => {
      const metadata = this.objectMetadata(row.metadata)
      return (
        metadata?.orderId === request.orderId &&
        metadata?.responsibility === expected.responsibility &&
        metadata?.refundTransactionId === expected.refundTransactionId &&
        metadata?.reason === expected.financeReason
      )
    })
    if (eventMatches.length !== 1 || auditMatches.length !== 1) {
      throw mismatch()
    }
  }

  private objectMetadata(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  async forceCancel(
    orderId: string,
    staffUserId: string,
    body: ForceCancelOrderDto,
  ) {
    const auditNote = body.note?.trim()
    if (!auditNote || auditNote.length < 20) {
      throw new BadRequestException(
        "Emergency cancellation note must be at least 20 characters",
      )
    }
    if (body.confirmationOrderId !== orderId) {
      throw new BadRequestException(
        "confirmationOrderId must exactly match the order being cancelled",
      )
    }
    const finalResponsibility = this.assertFinalResponsibility(
      body.responsibility,
    )
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      orderId,
      async (tx: any) => {
        const order = await this.loadOrder(tx, orderId)
        this.assertExpectedVersion(order.version, body.expectedVersion)
        if (
          (TERMINAL_ORDER_STATUSES as readonly string[]).includes(order.status)
        ) {
          return order
        }
        const confirmedFraudFinding = await tx.deliveryFraudFinding.findFirst({
          where: { orderId },
          select: { cancellationRequestId: true },
        })
        if (confirmedFraudFinding) {
          throw new ConflictException({
            code: "CONFIRMED_FRAUD_FINANCE_WORKFLOW_REQUIRED",
            message:
              "This order has confirmed fraud evidence. Complete its linked cancellation and Finance refund workflow instead.",
          })
        }
        if (order.paymentStatus === "PAID") {
          return (
            await this.refund.refundOrderInTransaction(
              tx,
              order,
              `Emergency cancellation: ${this.reasonText(body.reasonCode, auditNote)}`,
              staffUserId,
              `force-cancel:${orderId}:${body.idempotencyKey ?? order.version}`,
              finalResponsibility,
              {
                ...body.publisherCompensation,
                effectiveOrderStatus:
                  order.dispute?.previousStatus ?? order.status,
              },
            )
          ).order
        }
        return this.cancelUnpaidInTransaction(
          tx,
          order,
          staffUserId,
          body.reasonCode,
          auditNote,
          body.responsibility,
        )
      },
    )

    this.refund.dispatchOrderRefundCommunicationsBestEffort(orderId)
    this.communications?.dispatchByDedupKeyBestEffort(
      `order:${orderId}:cancelled`,
    )
    if (body.responsibility === CancellationResponsibility.PUBLISHER) {
      const publisherId = await this.prisma.order
        .findUnique({
          where: { id: orderId },
          select: { website: { select: { publisherId: true } } },
        })
        .then((order) => order?.website?.publisherId)
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "REFUND_ISSUED",
        `publisher-attributed emergency cancellation ${orderId}`,
      )
    }
    return result
  }

  async listRequests(params: {
    status?: CancellationRequestStatus
    requestId?: string
    take?: number
    skip?: number
    role: string
  }) {
    if (!new Set(["SUPER_ADMIN", "OPERATIONS", "FINANCE"]).has(params.role)) {
      throw new ForbiddenException("Staff cancellation access is required")
    }
    const canViewFinancials = params.role !== "OPERATIONS"
    const canViewIdentity = params.role === "SUPER_ADMIN"
    const take = Math.min(Math.max(params.take ?? 50, 1), 100)
    const skip = Math.max(params.skip ?? 0, 0)
    if (
      params.requestId !== undefined &&
      (typeof params.requestId !== "string" ||
        !CANCELLATION_REQUEST_LOOKUP_ID.test(params.requestId))
    ) {
      throw new BadRequestException({
        code: "INVALID_CANCELLATION_REQUEST_ID",
        message: "Cancellation request ID is invalid",
      })
    }
    const where = {
      ...(params.status && { status: params.status }),
      ...(params.requestId && { id: params.requestId }),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.orderCancellationRequest.findMany({
        where,
        include: {
          fraudFindings: {
            where: { outcome: "CONFIRMED_FRAUD" },
            select: { id: true },
            take: 1,
          },
          order: {
            include: {
              website: {
                select: {
                  id: true,
                  domain: true,
                  publisherId: true,
                  ownershipType: true,
                },
              },
              customer: { select: { id: true, name: true, email: true } },
              settlements: {
                where: { status: { not: "CANCELLED" } },
                orderBy: { createdAt: "desc" },
                take: 1,
                select: {
                  publisherAmount: true,
                  currency: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take,
        skip,
      }),
      this.prisma.orderCancellationRequest.count({ where }),
    ])
    return {
      items: items.map((request: any) => {
        const { fraudFindings, ...requestWithoutFraudFindings } = request
        const activeSettlement = request.order.settlements?.[0] ?? null
        const required = isPostPublicationPublisherOrder({
          fulfillmentChannel: request.fulfillmentChannel,
          websiteOwnershipType: request.order.website?.ownershipType,
          effectiveOrderStatus: request.previousOrderStatus,
          hasSettlement: Boolean(activeSettlement),
        })
        const customer = request.order.customer
        const order = {
          // This is a role-scoped API contract. Never spread a Prisma Order
          // record here: new scalar fields are otherwise silently exposed to
          // Operations as the schema evolves.
          id: request.order.id,
          title: request.order.title,
          status: request.order.status,
          fulfillmentChannel: request.order.fulfillmentChannel,
          website: request.order.website
            ? {
                id: request.order.website.id,
                domain: request.order.website.domain,
                publisherId: request.order.website.publisherId,
              }
            : null,
          ...(canViewFinancials && {
            amount: request.order.amount,
            currency: request.order.currency,
          }),
          customer: customer
            ? {
                id: customer.id,
                name: customer.name,
                ...(canViewIdentity && { email: customer.email }),
              }
            : null,
        }
        return {
          ...requestWithoutFraudFindings,
          order,
          requiresConfirmedFraudFullRefund: (fraudFindings?.length ?? 0) > 0,
          ...(canViewFinancials && {
            publisherCompensationPolicy: {
              required,
              maximumAmount: String(
                required
                  ? (activeSettlement?.publisherAmount ??
                      request.order.amount ??
                      0)
                  : 0,
              ),
              currency: activeSettlement?.currency ?? request.order.currency,
              effectiveOrderStatus: request.previousOrderStatus,
            },
          }),
        }
      }),
      total,
      take,
      skip,
    }
  }

  async assertNoActiveCancellation(orderId: string, db: any = this.prisma) {
    const active = await db.orderCancellationRequest.findFirst({
      where: {
        orderId,
        status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] },
      },
      select: { id: true, status: true },
    })
    if (active) {
      throw new ConflictException({
        code: "CANCELLATION_HOLD",
        message: "Fulfillment is paused while cancellation is being resolved",
        cancellationRequestId: active.id,
        cancellationStatus: active.status,
      })
    }
  }

  private async cancelUnpaidInTransaction(
    tx: any,
    order: any,
    actorUserId: string,
    reasonCode: CancellationReasonCode,
    note: string | undefined,
    responsibility: CancellationResponsibility | "CUSTOMER",
  ) {
    const amount = new Decimal(order.amount ?? 0)
    let reservationReleaseTransactionId: string | null = null
    if (
      order.paymentStatus === "PENDING" &&
      order.status === "PENDING_PAYMENT" &&
      amount.greaterThan(0)
    ) {
      // Releasing a reservation makes cash-equivalent wallet funds available
      // again. Keep this writer behind the same fail-closed cutover gate as
      // refunds and deposits; draft cancellations with no reservation remain
      // available while finance is locked.
      assertApiFinanceOperationAllowed("new_liability")
      const walletIdentity = await tx.wallet.findUnique({
        where: { organizationId: order.organizationId },
        select: { id: true },
      })
      if (!walletIdentity) {
        throw new ConflictException({
          code: "RESERVATION_WALLET_MISSING",
          message:
            "Pending-payment order has no wallet reservation owner; reconciliation is required",
        })
      }
      await lockWalletForUpdate(tx, walletIdentity.id)
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: walletIdentity.id },
      })
      if (
        !isSupportedMoneyCurrency(order.currency) ||
        !isSupportedMoneyCurrency(wallet.currency)
      ) {
        throw new ConflictException({
          code: "RESERVATION_CURRENCY_INVALID",
          message:
            "Pending-payment reservation is not denominated in canonical USD",
        })
      }
      if (new Decimal(wallet.reservedBalance).lessThan(amount)) {
        throw new ConflictException({
          code: "RESERVATION_BALANCE_MISMATCH",
          message:
            "Pending-payment order exceeds its reserved wallet balance; reconciliation is required",
        })
      }
      // Aggregate reservedBalance is shared by every pending order in the
      // wallet. Prove this order owns one exact, unconsumed reservation before
      // making any of it spendable again; otherwise a corrupt order could
      // release funds reserved for a different checkout.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Transaction" WHERE "orderId" = $1 AND "walletId" = $2 AND "type" IN (\'RESERVATION\', \'PURCHASE\', \'RELEASE\') FOR SHARE',
        order.id,
        wallet.id,
      )
      const reservationLedger = await tx.transaction.findMany({
        where: {
          orderId: order.id,
          walletId: wallet.id,
          type: { in: ["RESERVATION", "PURCHASE", "RELEASE"] },
        },
        select: {
          id: true,
          type: true,
          amount: true,
          currency: true,
          publisherId: true,
          settlementId: true,
          provider: true,
          providerRef: true,
        },
      })
      const reservations = reservationLedger.filter(
        (entry: any) => entry.type === "RESERVATION",
      )
      const reservation = reservations[0]
      if (
        reservations.length !== 1 ||
        reservationLedger.some((entry: any) => entry.type !== "RESERVATION") ||
        !new Decimal(reservation?.amount ?? 0).equals(amount.negated()) ||
        reservation?.currency !== USD_CURRENCY ||
        reservation?.publisherId != null ||
        reservation?.settlementId != null ||
        reservation?.provider != null ||
        reservation?.providerRef != null
      ) {
        throw new ConflictException({
          code: "RESERVATION_LEDGER_MISMATCH",
          message:
            "Pending-payment order lacks one exact unconsumed reservation ledger row; reconciliation is required",
        })
      }
      const released = await tx.wallet.updateMany({
        where: { id: wallet.id, version: wallet.version },
        data: {
          reservedBalance: { decrement: amount },
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (released.count === 0) {
        throw new ConflictException("Wallet changed concurrently. Retry.")
      }
      const releaseTransaction = await tx.transaction.create({
        data: {
          walletId: wallet.id,
          orderId: order.id,
          amount,
          type: "RELEASE",
          currency: USD_CURRENCY,
          reference: `reservation-release:${order.id}`,
          description: `Release of ${amount.toFixed(2)} USD reservation for cancelled order ${order.id}`,
        },
      })
      reservationReleaseTransactionId = releaseTransaction.id
    }
    await tx.fulfillmentAssignment.updateMany({
      where: {
        orderId: order.id,
        status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      },
      data: { status: "CANCELLED", version: { increment: 1 } },
    })
    const cancelled = await tx.order.updateMany({
      where: { id: order.id, version: order.version },
      data: {
        status: "CANCELLED",
        refundResponsibility: responsibility,
        version: { increment: 1 },
      },
    })
    if (cancelled.count === 0) {
      throw new ConflictException(
        "Order was modified by another request. Retry.",
      )
    }
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "ORDER_CANCELLED",
        actorId: actorUserId,
        message: `Order cancelled: ${this.reasonText(reasonCode, note)}`,
        metadata: {
          reasonCode,
          note,
          responsibility,
          reservationReleaseTransactionId,
        },
      },
    })
    await this.audit.log(
      {
        action: "ORDER_CANCELLED",
        entityType: "Order",
        entityId: order.id,
        metadata: {
          fromStatus: order.status,
          reasonCode,
          note,
          responsibility,
          reservationReleaseTransactionId,
          ...orderEventMetadata(order),
        },
        userId: actorUserId,
        organizationId: order.organizationId,
      },
      tx,
    )
    await this.recordCancellationCommunication(
      tx,
      order,
      order.id,
      "ORDER_CANCELLED",
      "Order cancelled",
      `Order ${order.id} was cancelled.`,
      actorUserId,
    )
    return tx.order.findUniqueOrThrow({ where: { id: order.id } })
  }

  private async recordCancellationCommunication(
    tx: any,
    order: any,
    aggregateId: string,
    type:
      | "ORDER_CANCELLED"
      | "ORDER_CANCELLATION_RESPONDED"
      | "ORDER_CANCELLATION_RESOLVED",
    title: string,
    message: string,
    actorUserId?: string,
  ) {
    if (!this.communications) return
    const publisherId =
      order.website?.publisherId ??
      (order.websiteId
        ? (
            await tx.website.findUnique({
              where: { id: order.websiteId },
              select: { publisherId: true },
            })
          )?.publisherId
        : null)
    const recipients = [
      ...new Set<string>([
        ...(await this.communications.customerOrderRecipients(order.id, tx)),
        ...(await this.communications.publisherRecipients(
          publisherId,
          false,
          tx,
        )),
      ]),
    ]
    await this.communications.record(
      {
        type,
        aggregateType:
          type === "ORDER_CANCELLED" ? "Order" : "CancellationRequest",
        aggregateId,
        organizationId: order.organizationId,
        title,
        message,
        actionPath: `/dashboard/orders/${order.id}`,
        dedupKey:
          type === "ORDER_CANCELLED"
            ? `order:${order.id}:cancelled`
            : `cancel-request:${aggregateId}:${type.toLowerCase()}`,
        recipientUserIds: recipients,
        actorUserId,
      },
      tx,
    )
  }

  private async loadOrder(db: any, orderId: string) {
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        website: {
          select: { ownershipType: true, publisherId: true, domain: true },
        },
        cancellationRequests: {
          where: {
            status: { in: [...ACTIVE_CANCELLATION_REQUEST_STATUSES] },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        fulfillmentAssignments: {
          where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
          select: { assignedToUserId: true },
          take: 1,
        },
        dispute: { select: { id: true, status: true, previousStatus: true } },
      },
    })
    if (!order) throw new NotFoundException("Order not found")
    return order
  }

  private assertActorCanAccess(order: any, actor: CancellationActorContext) {
    if (
      actor.kind === "CUSTOMER" &&
      (!actor.organizationId || order.organizationId !== actor.organizationId)
    ) {
      throw new NotFoundException("Order not found")
    }
    if (
      actor.kind === "PUBLISHER" &&
      (!actor.publisherId || order.website?.publisherId !== actor.publisherId)
    ) {
      throw new NotFoundException("Order not found")
    }
    if (
      actor.kind === "STAFF" &&
      actor.staffRole !== "SUPER_ADMIN" &&
      this.channelFor(order) !== "PLATFORM"
    ) {
      throw new ForbiddenException(
        "Operations can only act as fulfiller for platform orders",
      )
    }
    if (
      actor.kind === "STAFF" &&
      actor.staffRole !== "SUPER_ADMIN" &&
      order.fulfillmentAssignments?.[0]?.assignedToUserId !== actor.userId
    ) {
      throw new ForbiddenException(
        "Only the assigned Operations user can act for this order",
      )
    }
  }

  /**
   * Re-check the request authority inside the locked financial transaction.
   * The request-scoped resolver closes dropped cache invalidation; this closes
   * the smaller revoke-after-guard race before cancellation can issue a refund.
   */
  private async assertFreshActorAuthority(
    tx: any,
    actor: CancellationActorContext,
  ): Promise<void> {
    if (actor.kind === "CUSTOMER") {
      if (!actor.organizationId) {
        throw new ForbiddenException("No active customer authority")
      }
      const membership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: actor.userId,
            organizationId: actor.organizationId,
          },
        },
        select: {
          role: true,
          status: true,
          user: { select: { banned: true, userType: true } },
        },
      })
      if (
        membership?.status !== "ACTIVE" ||
        membership?.user.banned ||
        membership?.user.userType !== "CUSTOMER" ||
        membership?.role !== actor.customerRole
      ) {
        throw new ForbiddenException("Customer authority changed; retry")
      }
      return
    }

    if (actor.kind === "PUBLISHER") {
      if (!actor.publisherId) {
        throw new ForbiddenException("No active publisher authority")
      }
      const membership = await tx.publisherMembership.findUnique({
        where: {
          userId_publisherId: {
            userId: actor.userId,
            publisherId: actor.publisherId,
          },
        },
        select: {
          role: true,
          user: { select: { banned: true, userType: true } },
        },
      })
      if (
        !membership ||
        membership.user.banned ||
        membership.user.userType !== "PUBLISHER" ||
        membership.role !== actor.publisherRole
      ) {
        throw new ForbiddenException("Publisher authority changed; retry")
      }
      return
    }

    if (actor.kind === "STAFF") {
      const membership = await tx.staffMembership.findUnique({
        where: { userId: actor.userId },
        select: {
          role: true,
          user: { select: { banned: true, userType: true } },
        },
      })
      if (
        !membership ||
        membership.user.banned ||
        membership.user.userType !== "STAFF" ||
        membership.role !== actor.staffRole
      ) {
        throw new ForbiddenException("Staff authority changed; retry")
      }
    }
  }

  private assertCounterparty(request: any, actor: CancellationActorContext) {
    const order = request.order
    if (request.requesterType === "CUSTOMER") {
      if (request.fulfillmentChannel === "PUBLISHER") {
        if (
          actor.kind !== "PUBLISHER" ||
          order.website?.publisherId !== actor.publisherId
        ) {
          throw new ForbiddenException(
            "Only this order's publisher can respond",
          )
        }
        this.assertPublisherOwner(actor, "respond to cancellation")
      } else {
        if (actor.kind !== "STAFF") {
          throw new ForbiddenException("Only platform operations can respond")
        }
        const assignedToUserId =
          order.fulfillmentAssignments?.[0]?.assignedToUserId ?? null
        if (
          actor.staffRole !== "SUPER_ADMIN" &&
          assignedToUserId !== actor.userId
        ) {
          throw new ForbiddenException(
            "Only the assigned Operations user can respond",
          )
        }
      }
      return
    }

    if (
      actor.kind !== "CUSTOMER" ||
      order.organizationId !== actor.organizationId
    ) {
      throw new ForbiddenException("Only the customer can respond")
    }
    assertOwnerOrCreator({
      customerId: order.customerId,
      actorUserId: actor.userId,
      actorRole: actor.customerRole,
      action: "respond to cancellation",
    })
  }

  private assertPublisherOwner(
    actor: CancellationActorContext,
    action: string,
  ) {
    if (actor.publisherRole !== "PUBLISHER_OWNER") {
      throw new ForbiddenException(`Only a publisher owner can ${action}`)
    }
  }

  private actorCanMutate(order: any, actor: CancellationActorContext): boolean {
    if (actor.kind === "CUSTOMER") {
      return actor.customerRole === "OWNER" || order.customerId === actor.userId
    }
    if (actor.kind === "PUBLISHER") {
      return actor.publisherRole === "PUBLISHER_OWNER"
    }
    if (actor.kind === "STAFF") {
      return (
        actor.staffRole === "SUPER_ADMIN" ||
        order.fulfillmentAssignments?.[0]?.assignedToUserId === actor.userId
      )
    }
    return true
  }

  private channelFor(order: any): "PUBLISHER" | "PLATFORM" {
    return (
      order.fulfillmentChannel ??
      (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
    )
  }

  private hasActiveDispute(order: any): boolean {
    return Boolean(
      order.dispute && ["OPEN", "UNDER_REVIEW"].includes(order.dispute.status),
    )
  }

  private assertExpectedVersion(actual: number, expected: number) {
    if (actual !== expected) {
      throw new ConflictException(
        "Order changed since it was displayed. Refresh and try again.",
      )
    }
  }

  private initialResponsibility(
    requester: CancellationActorContext["kind"],
    reasonCode: CancellationReasonCode,
    channel: "PUBLISHER" | "PLATFORM",
    order: any,
  ): CancellationResponsibility {
    if (
      (
        [
          CancellationReasonCode.CUSTOMER_CHANGED_MIND,
          CancellationReasonCode.CAMPAIGN_CHANGED,
          CancellationReasonCode.DUPLICATE_ORDER,
        ] as readonly CancellationReasonCode[]
      ).includes(reasonCode)
    ) {
      return CancellationResponsibility.CUSTOMER
    }
    if (requester === "PUBLISHER") {
      return CancellationResponsibility.PUBLISHER
    }
    if (
      requester === "STAFF" ||
      reasonCode === CancellationReasonCode.PLATFORM_ERROR
    ) {
      return CancellationResponsibility.PLATFORM
    }
    if (
      (
        [
          CancellationReasonCode.CAPACITY_UNAVAILABLE,
          CancellationReasonCode.TOPIC_UNSUITABLE,
          CancellationReasonCode.WEBSITE_UNAVAILABLE,
          CancellationReasonCode.PRICING_ERROR,
          CancellationReasonCode.POLICY_CONFLICT,
          CancellationReasonCode.QUALITY_FAILURE,
        ] as readonly CancellationReasonCode[]
      ).includes(reasonCode)
    ) {
      return channel === "PUBLISHER"
        ? CancellationResponsibility.PUBLISHER
        : CancellationResponsibility.PLATFORM
    }
    if (
      reasonCode === CancellationReasonCode.MISSED_DEADLINE &&
      this.deadlineExpired(order.fulfillmentDueAt)
    ) {
      return channel === "PUBLISHER"
        ? CancellationResponsibility.PUBLISHER
        : CancellationResponsibility.PLATFORM
    }
    return CancellationResponsibility.UNDETERMINED
  }

  private immediateCustomerResponsibility(
    order: any,
    reasonCode: CancellationReasonCode,
  ): FinalRefundResponsibility {
    if (reasonCode !== CancellationReasonCode.MISSED_DEADLINE) {
      return "CUSTOMER"
    }

    const { acceptanceWindowHours } = resolveOrderCancellationConfig(
      process.env,
    )
    const acceptanceDeadline = order.submittedAt
      ? new Date(order.submittedAt).getTime() +
        acceptanceWindowHours * 60 * 60 * 1000
      : Number.POSITIVE_INFINITY
    if (acceptanceDeadline > Date.now()) {
      throw new BadRequestException(
        `The ${acceptanceWindowHours}-hour acceptance deadline has not been missed`,
      )
    }
    return this.channelFor(order) === "PUBLISHER" ? "PUBLISHER" : "PLATFORM"
  }

  private assertFinalResponsibility(
    responsibility: CancellationResponsibility,
  ): FinalRefundResponsibility {
    if (responsibility === CancellationResponsibility.UNDETERMINED) {
      throw new BadRequestException(
        "A specific responsibility attribution is required before refunding",
      )
    }
    return responsibility
  }

  private deadlineExpired(value: Date | string | null | undefined): boolean {
    if (!value) return false
    const timestamp =
      value instanceof Date ? value.getTime() : Date.parse(value)
    return Number.isFinite(timestamp) && timestamp <= Date.now()
  }

  private reasonText(reasonCode: CancellationReasonCode, note?: string) {
    return note ? `${reasonCode}: ${note}` : reasonCode
  }

  private concurrentRequestError(): never {
    throw new ConflictException(
      "Cancellation request was modified by another response. Refresh.",
    )
  }

  private async notifyCounterparty(
    tx: any,
    order: any,
    requesterType: CancellationActorContext["kind"],
    requesterUserId: string,
    requestId: string,
  ) {
    let recipients: Array<{ userId: string }> = []
    if (requesterType === "CUSTOMER") {
      if (
        this.channelFor(order) === "PUBLISHER" &&
        order.website?.publisherId
      ) {
        recipients = await tx.publisherMembership.findMany({
          where: { publisherId: order.website.publisherId },
          select: { userId: true },
        })
      } else {
        recipients = await tx.fulfillmentAssignment
          .findMany({
            where: {
              orderId: order.id,
              status: { in: ["ASSIGNED", "IN_PROGRESS"] },
            },
            select: { assignedToUserId: true },
          })
          .then((rows: Array<{ assignedToUserId: string }>) =>
            rows.map((row) => ({ userId: row.assignedToUserId })),
          )
      }
    } else {
      recipients = [{ userId: order.customerId }]
    }
    const { responseWindowHours } = resolveOrderCancellationConfig(process.env)
    if (this.communications) {
      await this.communications.record(
        {
          type: "ORDER_CANCELLATION_REQUESTED",
          aggregateType: "CancellationRequest",
          aggregateId: requestId,
          organizationId: order.organizationId,
          title: "Cancellation response required",
          message: `Cancellation request ${requestId} needs your response within ${responseWindowHours} hours.`,
          actionPath: `/dashboard/orders/${order.id}`,
          dedupKey: `cancel-request:${requestId}:counterparty`,
          recipientUserIds: recipients.map((recipient) => recipient.userId),
          actorUserId: requesterUserId,
        },
        tx,
      )
      return
    }
    for (const recipient of recipients) {
      await tx.notification.create({
        data: {
          userId: recipient.userId,
          organizationId:
            requesterType === "CUSTOMER" ? null : order.organizationId,
          type: "ORDER_CANCELLATION_REQUESTED",
          message: `Cancellation request ${requestId} needs your response within ${responseWindowHours} hours`,
          dedupKey: `cancel-request:${requestId}`,
        },
      })
    }
  }
}
