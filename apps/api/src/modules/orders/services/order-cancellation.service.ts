import {
  CancellationReasonCode,
  CancellationRequestStatus,
  CancellationResolution,
  CancellationResponsibility,
} from "@guestpost/database"
import {
  ACTIVE_CANCELLATION_REQUEST_STATUSES,
  decideOrderCancellation,
  orderEventMetadata,
  resolveOrderCancellationConfig,
} from "@guestpost/shared"
import { FinalRefundResponsibility } from "@guestpost/shared/dist/order-refund-core"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
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

    return this.prisma.$transaction(async (tx: any) => {
      const replay = body.idempotencyKey
        ? await tx.transaction.findFirst({
            where: {
              reference: `customer-cancel:${orderId}:${body.idempotencyKey}`,
            },
          })
        : null
      if (replay) {
        return tx.order.findUniqueOrThrow({ where: { id: orderId } })
      }

      const order = await this.loadOrder(tx, orderId)
      this.assertActorCanAccess(order, actor)
      assertOwnerOrCreator({
        customerId: order.customerId,
        actorUserId: actor.userId,
        actorRole: actor.customerRole,
        action: "cancel order",
      })
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
    })
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
    const result = await this.prisma.$transaction(async (tx: any) => {
      const order = await this.loadOrder(tx, orderId)
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

      const responsibility = channel === "PUBLISHER" ? "PUBLISHER" : "PLATFORM"
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
    })

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
    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const order = await this.loadOrder(tx, orderId)
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
        await this.notifyCounterparty(tx, order, actor.kind, request.id)
        return request
      })
    } catch (error: any) {
      if (error?.code === "P2002") {
        throw new ConflictException(
          "A cancellation request is already active for this order",
        )
      }
      throw error
    }
  }

  async respond(
    orderId: string,
    requestId: string,
    actor: CancellationActorContext,
    body: RespondCancellationRequestDto,
  ) {
    let publisherId: string | null = null
    let responsibility: CancellationResponsibility | null = null
    const result = await this.prisma.$transaction(async (tx: any) => {
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
        throw new ConflictException("Cancellation request already responded to")
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
      return tx.orderCancellationRequest.findUniqueOrThrow({
        where: { id: requestId },
      })
    })

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
    body: ReviewCancellationRequestDto,
  ) {
    return this.prisma.$transaction(async (tx: any) => {
      const request = await tx.orderCancellationRequest.findUnique({
        where: { id: requestId },
        include: { order: true },
      })
      if (!request)
        throw new NotFoundException("Cancellation request not found")
      if (!["UNDER_REVIEW", "ESCALATED"].includes(request.status)) {
        throw new BadRequestException(
          "Cancellation request is not awaiting review",
        )
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
            resolutionReason: body.reason,
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
            resolutionReason: body.reason,
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
            reason: body.reason,
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
            resolutionReason: body.reason,
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
            reason: body.reason,
          },
          userId: staffUserId,
          organizationId: request.order.organizationId,
        },
        tx,
      )
      return tx.orderCancellationRequest.findUniqueOrThrow({
        where: { id: requestId },
      })
    })
  }

  async financeApprove(
    requestId: string,
    financeUserId: string,
    body: FinanceApproveCancellationDto,
  ) {
    let publisherId: string | null = null
    let responsibility: CancellationResponsibility | null = null
    const result = await this.prisma.$transaction(async (tx: any) => {
      const request = await tx.orderCancellationRequest.findUnique({
        where: { id: requestId },
        include: {
          order: {
            include: {
              website: {
                select: { ownershipType: true, publisherId: true },
              },
            },
          },
        },
      })
      if (!request)
        throw new NotFoundException("Cancellation request not found")
      if (request.status !== "PENDING_FINANCE") {
        throw new BadRequestException(
          "Cancellation is not pending finance approval",
        )
      }
      publisherId = request.order.website?.publisherId ?? null
      const resolvedResponsibility = this.assertFinalResponsibility(
        request.responsibility,
      )
      responsibility = resolvedResponsibility
      const refunded = await this.refund.refundOrderInTransaction(
        tx,
        request.order,
        `${request.resolutionReason ?? "Cancellation approved"} — Finance: ${body.reason}`,
        financeUserId,
        `cancellation-request:${request.id}`,
        resolvedResponsibility,
      )
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
          message: "Cancellation refund approved by Finance",
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
            reason: body.reason,
          },
          userId: financeUserId,
          organizationId: request.order.organizationId,
        },
        tx,
      )
      return tx.orderCancellationRequest.findUniqueOrThrow({
        where: { id: requestId },
      })
    })

    if (responsibility === "PUBLISHER" && publisherId) {
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "REFUND_ISSUED",
        `publisher-attributed cancellation ${requestId}`,
      )
    }
    return result
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
    const result = await this.prisma.$transaction(async (tx: any) => {
      const order = await this.loadOrder(tx, orderId)
      this.assertExpectedVersion(order.version, body.expectedVersion)
      if (
        (TERMINAL_ORDER_STATUSES as readonly string[]).includes(order.status)
      ) {
        return order
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
    })

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
    take?: number
    skip?: number
  }) {
    const take = Math.min(Math.max(params.take ?? 50, 1), 100)
    const skip = Math.max(params.skip ?? 0, 0)
    const where = params.status ? { status: params.status } : {}
    const [items, total] = await this.prisma.$transaction([
      this.prisma.orderCancellationRequest.findMany({
        where,
        include: {
          order: {
            include: {
              website: {
                select: { id: true, domain: true, publisherId: true },
              },
              customer: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take,
        skip,
      }),
      this.prisma.orderCancellationRequest.count({ where }),
    ])
    return { items, total, take, skip }
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
    const amount = Number(order.amount ?? 0)
    if (
      order.paymentStatus === "PENDING" &&
      order.status === "PENDING_PAYMENT" &&
      amount > 0
    ) {
      const wallet = await tx.wallet.findUnique({
        where: { organizationId: order.organizationId },
      })
      if (wallet) {
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
      }
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
        metadata: { reasonCode, note, responsibility },
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
          ...orderEventMetadata(order),
        },
        userId: actorUserId,
        organizationId: order.organizationId,
      },
      tx,
    )
    return tx.order.findUniqueOrThrow({ where: { id: order.id } })
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
        dispute: { select: { id: true, status: true } },
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
    for (const recipient of recipients) {
      const { responseWindowHours } = resolveOrderCancellationConfig(
        process.env,
      )
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
