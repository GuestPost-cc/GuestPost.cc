import type { Prisma, SettlementStatus } from "@guestpost/database"
import {
  buildSettlementEligibilitySnapshot,
  checkSeparationOfDuties,
  evaluateSettlementEligibility,
  getSettlementReviewDays,
  notificationDedupKey,
  orderEventMetadata,
  type PublisherTier,
  runSettlementSerializableTransaction,
  WorkflowDecisionService,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import {
  resolvePlatformFeePolicy,
  splitPlatformFee,
} from "../../common/platform-fee"
import { PrismaService } from "../../common/prisma.service"
import { checkPublisherBalanceInvariant } from "../../common/publisher-balance-invariants"
import { lockPublisherBalanceForUpdate } from "../../common/publisher-balance-lock"
import { AuditService } from "../audit/audit.service"
import { assertOwnerOrCreator } from "../orders/services/owner-or-creator"
import { QueueService } from "../queues/queue.service"
import { evaluateSettlementEligibilityTx } from "./settlement-eligibility"

interface SettlementReleaseSummary {
  publisherAmount: string
  debtApplied: string
  credited: string
  currency: string
}

@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name)
  private readonly decision = new WorkflowDecisionService()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // organizationId is null for staff callers — they may create settlements for any org
  async createSettlement(
    orderId: string,
    organizationId: string | null,
    userId: string,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    const order = await this.prisma.order.findFirst({
      where: organizationId ? { id: orderId, organizationId } : { id: orderId },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DELIVERED")
      throw new BadRequestException(
        "Order must be DELIVERED to create settlement",
      )

    // Independent-verification gate: no settlement on a human claim alone.
    // Requires an active VERIFIED (or manually-approved) delivery, no open
    // dispute, no active revision, no fraud flags, status DELIVERED.
    const preSnapshot = await buildSettlementEligibilitySnapshot(
      this.prisma,
      orderId,
    )
    const eligibility = evaluateSettlementEligibility(preSnapshot)
    if (!eligibility.eligible) {
      await this.audit.log({
        action: "ORDER_DELIVERY_SETTLEMENT_BLOCKED",
        entityType: "Order",
        entityId: orderId,
        metadata: {
          ...orderEventMetadata(order),
          reasons: eligibility.reasons,
        },
        userId,
        organizationId: order.organizationId,
      })
      throw new BadRequestException({
        code: "SETTLEMENT_BLOCKED",
        message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
        reasons: eligibility.reasons,
      })
    }

    if (
      !order.amount ||
      new Decimal(order.amount).lessThanOrEqualTo(0) ||
      new Decimal(order.amount).decimalPlaces() > 2
    ) {
      throw new BadRequestException("Order has no amount to settle")
    }

    // Tier-aware review window (Phase 7.2 — audit #6). The publisher's payout
    // is held while we keep re-checking the live link. If it's removed during
    // the window, the link sweep raises a fraud flag and settlement gating
    // blocks release. Window length: NEW=30d / TRUSTED=14d / VERIFIED=7d per
    // packages/shared/src/publisher-tier-policy.ts; env override wins when set.
    // Tier resolved inside the transaction via a focused PK lookup (Option B
    // per Phase 7.2 Key decision #6 — cheaper than cascading nested includes
    // into the existing include chain).

    return runSettlementSerializableTransaction(
      this.prisma,
      async (tx: any) => {
        // Re-check gating inside the transaction to close the TOCTOU window
        // between the pre-transaction evaluateSettlementEligibility call
        // (line 52) and this point — a dispute could have been opened, fraud
        // flag raised, or order cancelled concurrently.
        const txnEligibility = await evaluateSettlementEligibilityTx(
          tx,
          orderId,
        )
        if (!txnEligibility.eligible) {
          throw new BadRequestException({
            code: "SETTLEMENT_BLOCKED",
            message: `Settlement blocked: ${txnEligibility.reasons.join("; ")}`,
            reasons: txnEligibility.reasons,
          })
        }
        if (txnEligibility.snapshot.orderVersion !== order.version) {
          throw new ConflictException(
            "Order financial state changed while settlement was being prepared. Retry.",
          )
        }

        // The eligibility helper has now locked the parent Order row. Every
        // financial and attribution snapshot below is re-read from that locked
        // row; pre-transaction OrderItem/live-listing data is never trusted for
        // publisher liability.
        const lockedOrder = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            organizationId: true,
            version: true,
            amount: true,
            currency: true,
            status: true,
            paymentStatus: true,
            verifyMethod: true,
            listingId: true,
            listingServiceId: true,
            type: true,
            fulfillmentChannel: true,
            websiteId: true,
          },
        })
        if (!lockedOrder) throw new NotFoundException("Order not found")
        if (
          lockedOrder.version !== order.version ||
          lockedOrder.organizationId !== order.organizationId ||
          (organizationId && lockedOrder.organizationId !== organizationId)
        ) {
          throw new ConflictException(
            "Order ownership or financial state changed while settlement was being prepared. Retry.",
          )
        }

        const grossAmount = lockedOrder.amount
          ? new Decimal(lockedOrder.amount)
          : null
        if (
          lockedOrder.currency !== "USD" ||
          lockedOrder.status !== "DELIVERED" ||
          lockedOrder.paymentStatus !== "PAID" ||
          !grossAmount ||
          grossAmount.lessThanOrEqualTo(0) ||
          grossAmount.decimalPlaces() > 2
        ) {
          throw new BadRequestException(
            "Order must be paid, delivered, exact-USD, and have a positive whole-cent amount to settle",
          )
        }
        if (!lockedOrder.websiteId) {
          throw new BadRequestException(
            "Order has no canonical website for publisher attribution",
          )
        }

        const website = await tx.website.findUnique({
          where: { id: lockedOrder.websiteId },
          select: { publisherId: true, ownershipType: true },
        })
        const publisherId = website?.publisherId
        const ownerType = website?.ownershipType ?? null
        if (!publisherId) {
          throw new BadRequestException(
            "Order website has no publisher for settlement attribution",
          )
        }

        const existing = await tx.settlement.findFirst({
          where: { orderId, status: { not: "CANCELLED" } },
        })
        if (existing) {
          throw new BadRequestException(
            "Settlement already exists for this order",
          )
        }

        const listingServiceId: string | null =
          lockedOrder.listingServiceId ?? null
        let serviceType: any = lockedOrder.type ?? null
        let unitPrice: Decimal | null = null
        if (listingServiceId) {
          const listingService = await tx.listingService.findUnique({
            where: { id: listingServiceId },
            select: { price: true, serviceType: true },
          })
          if (!listingService) {
            throw new ConflictException(
              "Order listing-service snapshot is unavailable. Settlement requires review.",
            )
          }
          unitPrice = new Decimal(listingService.price)
          serviceType = listingService.serviceType
        }

        const feePolicy = await resolvePlatformFeePolicy(tx)
        const { fee: platformFee, net: publisherAmount } = splitPlatformFee(
          grossAmount,
          feePolicy.fraction,
        )
        if (
          platformFee.lessThan(0) ||
          publisherAmount.lessThanOrEqualTo(0) ||
          !platformFee.plus(publisherAmount).equals(grossAmount)
        ) {
          throw new BadRequestException(
            "Settlement fee split is not a valid exact-USD allocation",
          )
        }

        const publisherTierRow = await tx.publisher.findUnique({
          where: { id: publisherId },
          select: { tier: true },
        })
        const reviewDays = getSettlementReviewDays(
          (publisherTierRow?.tier ?? "NEW") as PublisherTier,
          process.env.SETTLEMENT_REVIEW_DAYS,
        )
        const reviewEndsAt = new Date(
          Date.now() + reviewDays * 24 * 60 * 60 * 1000,
        )

        const fraudFlags = await tx.deliveryFraudFlag.findMany({
          where: { orderId, resolution: null },
          select: { type: true },
        })
        const releasePolicy = this.decision.computeSettlementReleasePolicy(
          {
            verifyMethod: lockedOrder.verifyMethod,
            amount: grossAmount.toNumber(),
          },
          publisherTierRow ? { tier: publisherTierRow.tier } : null,
          fraudFlags,
          null,
        )

        let settlement: any
        try {
          settlement = await tx.settlement.create({
            data: {
              orderId,
              publisherId,
              grossAmount,
              currency: "USD",
              platformFee,
              publisherAmount,
              platformFeeBps: feePolicy.basisPoints,
              feePolicyVersion: feePolicy.policyVersion,
              status: "PENDING",
              reviewEndsAt,
              releasePolicy,
              // Phase 6 snapshots (read-only after creation).
              listingServiceId,
              serviceType,
              ownerType,
              fulfillmentChannel: lockedOrder.fulfillmentChannel ?? null,
              unitPrice,
            },
          })
        } catch (err: any) {
          if (
            err?.code === "P2002" ||
            /Settlement_orderId_active_key/.test(err?.message ?? "")
          ) {
            throw new BadRequestException(
              "Settlement already exists for this order",
            )
          }
          throw err
        }

        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "SETTLEMENT_CREATED",
            actorId: userId,
            message: `Settlement created — customer amount: ${grossAmount}, publisher amount: ${publisherAmount}`,
            metadata: {
              settlementId: settlement.id,
              releasePolicy,
              publisherAmount: publisherAmount.toNumber(),
              platformFee: platformFee.toNumber(),
            },
          },
        })

        await this.audit.log(
          {
            action: "SETTLEMENT_CREATED",
            entityType: "Settlement",
            entityId: settlement.id,
            // Standardized Phase 6 metadata helper — every order-scoped audit
            // should carry the snapshot trio so historical reports / replays
            // never have to chase the live listing.
            metadata: {
              orderId,
              publisherAmount: publisherAmount.toNumber(),
              platformFee: platformFee.toNumber(),
              ...orderEventMetadata(lockedOrder),
            },
            userId,
            organizationId: lockedOrder.organizationId,
          },
          tx,
        )

        return settlement
      },
    )
  }

  // organizationId is null for staff callers — customers may only see their own org's settlements
  async getSettlement(id: string, organizationId: string | null = null) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        order: { include: { customer: true, website: true } },
        publisher: true,
        approvals: true,
      },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (organizationId && settlement.order.organizationId !== organizationId) {
      throw new ForbiddenException(
        "Settlement does not belong to your organization",
      )
    }
    return settlement
  }

  async listSettlements(
    organizationId?: string,
    take = 50,
    skip = 0,
    statuses?: SettlementStatus[],
  ) {
    const where: Prisma.SettlementWhereInput = {
      ...(organizationId ? { order: { organizationId } } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        include: { order: true, publisher: true, approvals: true },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.settlement.count({ where }),
    ])
    return { items, total, take, skip }
  }

  // Customer approves settlement
  async customerApprove(
    id: string,
    userId: string,
    organizationId: string,
    role: string,
    actorCustomerRole?: string | null,
  ) {
    assertApiFinanceOperationAllowed("operator_decision")
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.order.organizationId !== organizationId) {
      throw new ForbiddenException(
        "Settlement does not belong to your organization",
      )
    }
    // Phase 6.9 — Audit finding R-4. The customer side of dual approval
    // releases publisher payment after admin signs off. Non-creator MEMBERs
    // shouldn't be able to greenlight a sibling MEMBER's settlement.
    // OWNER||creator only — service-layer enforcement on top of the
    // controller's @MemberRoles("OWNER","MEMBER") broad gate.
    assertOwnerOrCreator({
      customerId: settlement.order.customerId,
      actorUserId: userId,
      actorRole: actorCustomerRole,
      action: "approve this settlement",
    })
    if (
      settlement.status !== "PENDING" &&
      settlement.status !== "UNDER_REVIEW"
    ) {
      throw new BadRequestException(
        `Cannot approve settlement in ${settlement.status} status`,
      )
    }
    if (settlement.currency !== "USD") {
      throw new BadRequestException("Settlement currency must be exactly USD")
    }

    // Check for active dispute
    const activeDispute = await this.prisma.orderDispute.findFirst({
      where: {
        orderId: settlement.orderId,
        status: { in: ["OPEN", "UNDER_REVIEW"] },
      },
    })
    if (activeDispute)
      throw new BadRequestException(
        "Cannot approve settlement while dispute is active",
      )

    return runSettlementSerializableTransaction(
      this.prisma,
      async (tx: any) => {
        const eligibility = await evaluateSettlementEligibilityTx(
          tx,
          settlement.orderId,
        )
        if (!eligibility.eligible) {
          throw new BadRequestException({
            code: "SETTLEMENT_BLOCKED",
            message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
            reasons: eligibility.reasons,
          })
        }

        // Conditional transition — the unguarded update here could overwrite a
        // settlement that was concurrently RELEASED (status corruption; the
        // pre-tx status check reads a stale snapshot).
        const transitioned = await tx.settlement.updateMany({
          where: {
            id,
            status: { in: ["PENDING", "UNDER_REVIEW"] },
            version: settlement.version,
            currency: "USD",
          },
          data: {
            status: "CUSTOMER_APPROVED",
            currency: "USD",
            version: { increment: 1 },
          },
        })
        if (transitioned.count === 0) {
          throw new ConflictException(
            "Settlement was modified by another request. Retry.",
          )
        }
        const updated = await tx.settlement.findUniqueOrThrow({ where: { id } })

        await tx.settlementApproval.upsert({
          where: { settlementId_type: { settlementId: id, type: "CUSTOMER" } },
          create: {
            settlementId: id,
            type: "CUSTOMER",
            approvedBy: userId,
            roleAtTime: role,
          },
          update: {
            approvedBy: userId,
            roleAtTime: role,
            approvedAt: new Date(),
          },
        })

        await tx.orderEvent.create({
          data: {
            orderId: settlement.orderId,
            eventType: "SETTLED",
            actorId: userId,
            message: `Settlement customer-approved`,
            metadata: {
              settlementId: id,
              publisherAmount: Number(settlement.publisherAmount),
            },
          },
        })

        await this.audit.log(
          {
            action: "SETTLEMENT_CUSTOMER_APPROVED",
            entityType: "Settlement",
            entityId: id,
            metadata: {
              ...orderEventMetadata(settlement.order),
              orderId: settlement.orderId,
              publisherAmount: Number(settlement.publisherAmount),
            },
            userId,
            organizationId,
          },
          tx,
        )

        return updated
      },
    )
  }

  // Fired after the release transaction commits — queue writes are not transactional
  private async notifySettlementReleased(
    settlement: {
      id: string
      orderId: string
      publisherId: string
      publisherAmount: any
      order: { organizationId: string; customerId: string }
    },
    summary: SettlementReleaseSummary,
  ) {
    let memberships: Array<{ userId: string }> = []
    let publisher: { organizationId: string } | null = null
    try {
      const recipients = await Promise.all([
        this.prisma.publisherMembership.findMany({
          where: { publisherId: settlement.publisherId },
          select: { userId: true },
        }),
        this.prisma.publisher.findUnique({
          where: { id: settlement.publisherId },
          select: { organizationId: true },
        }),
      ])
      memberships = recipients[0]
      publisher = recipients[1]
    } catch (err) {
      // The balance mutation has already committed. Notification availability
      // must not turn a successful release into an apparent API failure.
      this.logger.warn(
        `Failed to resolve settlement notification recipients for ${settlement.id}: ${err}`,
      )
    }
    const debtApplied = new Decimal(summary.debtApplied)
    const publisherMessage = debtApplied.greaterThan(0)
      ? `Settlement of ${summary.publisherAmount} ${summary.currency} was released: ${summary.debtApplied} ${summary.currency} repaid outstanding debt and ${summary.credited} ${summary.currency} was credited to your withdrawable balance.`
      : `Settlement of ${summary.publisherAmount} ${summary.currency} has been credited to your withdrawable balance.`

    for (const m of memberships) {
      try {
        await this.queue.pushNotification(
          "push-in-app",
          {
            userId: m.userId,
            organizationId: publisher?.organizationId ?? null,
            type: "SETTLEMENT_RELEASED",
            message: publisherMessage,
          },
          notificationDedupKey.settlementReleased(settlement.id, m.userId),
        )
      } catch (err) {
        this.logger.warn(
          `Failed to queue settlement release notification for ${m.userId}: ${err}`,
        )
      }
    }
    try {
      await this.queue.pushNotification(
        "push-in-app",
        {
          userId: settlement.order.customerId,
          organizationId: settlement.order.organizationId,
          type: "SETTLEMENT_RELEASED",
          message: `Settlement for order ${settlement.orderId} has been released.`,
        },
        notificationDedupKey.settlementReleased(
          settlement.id,
          settlement.order.customerId,
        ),
      )
    } catch (err) {
      this.logger.warn(
        `Failed to queue settlement release notification for customer ${settlement.order.customerId}: ${err}`,
      )
    }
  }

  private async enqueueSettlementTrustRecompute(
    settlementId: string,
    publisherId: string,
  ) {
    try {
      await this.queue.enqueueTrustRecompute(
        publisherId,
        "SETTLEMENT_RELEASED",
        `settlement ${settlementId} released`,
      )
    } catch (error) {
      // Queue I/O is not transactional. A queue outage must never roll back or
      // falsely report failure for an already-committed money transition.
      this.logger.warn(
        `Failed to enqueue publisher trust recompute after settlement ${settlementId}: ${error}`,
      )
    }
  }

  // Staff approves settlement (admin side)
  async adminApprove(
    id: string,
    reason: string,
    userId: string,
    staffRole: string,
  ) {
    assertApiFinanceOperationAllowed("operator_decision")
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status !== "CUSTOMER_APPROVED") {
      throw new BadRequestException(
        "Customer must approve before admin can approve",
      )
    }

    const previousStatus = settlement.status

    const { result, releaseSummary } =
      await runSettlementSerializableTransaction(
        this.prisma,
        async (tx: any) => {
          // Re-check with fresh transactional snapshot — closes TOCTOU window
          const eligibility = await evaluateSettlementEligibilityTx(
            tx,
            settlement.orderId,
          )
          if (!eligibility.eligible) {
            throw new BadRequestException({
              code: "SETTLEMENT_BLOCKED",
              message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
              reasons: eligibility.reasons,
            })
          }

          const adminUpdated = await tx.settlement.updateMany({
            where: {
              id,
              status: "CUSTOMER_APPROVED",
              version: settlement.version,
            },
            data: {
              status: "ADMIN_APPROVED",
              version: { increment: 1 },
            },
          })
          if (adminUpdated.count === 0) {
            throw new ConflictException(
              "Settlement status changed by another request",
            )
          }

          const fresh = await tx.settlement.findUniqueOrThrow({ where: { id } })

          await tx.settlementApproval.create({
            data: {
              settlementId: id,
              type: "ADMIN",
              approvedBy: userId,
              roleAtTime: staffRole,
            },
          })

          // Auto-release if admin approved
          const releaseSummary = await this.releaseFundsInternal(
            tx,
            id,
            { ...settlement, version: fresh.version },
            userId,
          )

          await this.audit.log(
            {
              action: "SETTLEMENT_ADMIN_APPROVED",
              entityType: "Settlement",
              entityId: id,
              metadata: {
                orderId: settlement.orderId,
                ...orderEventMetadata(settlement.order),
                reason,
                actorRole: staffRole,
                previousStatus,
                newStatus: "ADMIN_APPROVED",
                publisherAmount:
                  settlement.publisherAmount?.toNumber?.() ??
                  Number(settlement.publisherAmount),
              },
              userId,
              organizationId: settlement.order.organizationId,
            },
            tx,
          )

          // Row is now RELEASED — return the final state, not the snapshot
          const result = await tx.settlement.findUniqueOrThrow({
            where: { id },
          })
          return { result, releaseSummary }
        },
      )

    await this.enqueueSettlementTrustRecompute(id, settlement.publisherId)
    await this.notifySettlementReleased(settlement, releaseSummary)

    return result
  }

  // Combined approval for dual-role staff (SUPER_ADMIN)
  async forceApprove(
    id: string,
    reason: string,
    userId: string,
    staffRole: string,
  ) {
    assertApiFinanceOperationAllowed("operator_decision")
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED")
      throw new BadRequestException("Settlement already released")

    const previousStatus = settlement.status

    const targetStatus =
      settlement.status === "CUSTOMER_APPROVED"
        ? "ADMIN_APPROVED"
        : "CUSTOMER_APPROVED"

    const { result, releaseSummary } =
      await runSettlementSerializableTransaction(
        this.prisma,
        async (tx: any) => {
          // Fresh eligibility check with locked snapshot — closes TOCTOU window
          const eligibility = await evaluateSettlementEligibilityTx(
            tx,
            settlement.orderId,
          )
          if (!eligibility.eligible) {
            throw new BadRequestException({
              code: "SETTLEMENT_BLOCKED",
              message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
              reasons: eligibility.reasons,
            })
          }

          const updated = await tx.settlement.updateMany({
            where: { id, version: settlement.version },
            data: {
              status: targetStatus,
              version: { increment: 1 },
            },
          })
          if (updated.count === 0) {
            throw new ConflictException(
              "Settlement was modified by another request",
            )
          }

          const fresh = await tx.settlement.findUniqueOrThrow({ where: { id } })

          await tx.settlementApproval.create({
            data: {
              settlementId: id,
              type: targetStatus === "ADMIN_APPROVED" ? "ADMIN" : "CUSTOMER",
              approvedBy: userId,
              roleAtTime: staffRole,
            },
          })

          const releaseSummary =
            targetStatus === "ADMIN_APPROVED"
              ? await this.releaseFundsInternal(
                  tx,
                  id,
                  { ...settlement, version: fresh.version },
                  userId,
                )
              : null

          await this.audit.log(
            {
              action: "SETTLEMENT_FORCE_APPROVED",
              entityType: "Settlement",
              entityId: id,
              metadata: {
                orderId: settlement.orderId,
                ...orderEventMetadata(settlement.order),
                reason,
                actorRole: staffRole,
                previousStatus,
                newStatus: targetStatus,
                publisherAmount:
                  settlement.publisherAmount?.toNumber?.() ??
                  Number(settlement.publisherAmount),
              },
              userId,
              organizationId: settlement.order.organizationId,
            },
            tx,
          )

          // releaseFundsInternal moved the row to RELEASED — return the final
          // state, not the pre-release snapshot
          const result =
            targetStatus === "ADMIN_APPROVED"
              ? await tx.settlement.findUnique({ where: { id } })
              : fresh
          return { result, releaseSummary }
        },
      )

    if (targetStatus === "ADMIN_APPROVED") {
      await this.enqueueSettlementTrustRecompute(id, settlement.publisherId)
      await this.notifySettlementReleased(settlement, releaseSummary!)
    }

    return result
  }

  async cancelSettlement(id: string, userId: string, reason: string) {
    assertApiFinanceOperationAllowed("operator_decision")
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true, publisher: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED")
      throw new BadRequestException("Cannot cancel released settlement")

    const previousStatus = settlement.status

    return this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.settlement.updateMany({
        where: { id, version: settlement.version },
        data: { status: "CANCELLED", version: { increment: 1 } },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "Settlement was modified by another request. Retry.",
        )
      }
      const settlementRow = await tx.settlement.findUniqueOrThrow({
        where: { id },
      })

      await this.audit.log(
        {
          action: "SETTLEMENT_CANCELLED",
          entityType: "Settlement",
          entityId: id,
          metadata: {
            ...orderEventMetadata(settlement.order),
            orderId: settlement.orderId,
            previousStatus,
            reason,
          },
          userId,
          organizationId: settlement.order.organizationId,
        },
        tx,
      )

      return settlementRow
    })
  }

  async returnToReview(id: string, userId: string, reason: string) {
    assertApiFinanceOperationAllowed("operator_decision")
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status !== "CUSTOMER_APPROVED") {
      throw new BadRequestException(
        "Only customer-approved settlements can be returned to review",
      )
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Phase 8.1 (audit #1) — version-guarded transition. The pre-tx status
      // check at line 445 reads a stale snapshot; a concurrent adminApprove
      // racing this would have silently corrupted the status (e.g. flipped a
      // RELEASED settlement back to UNDER_REVIEW). Now we move the status
      // predicate into the where clause + add the version guard, matching the
      // 6 sibling sites in this file (customerApprove, adminApprove, etc.).
      const transitioned = await tx.settlement.updateMany({
        where: { id, status: "CUSTOMER_APPROVED", version: settlement.version },
        data: { status: "UNDER_REVIEW", version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException(
          "Settlement was modified by another request (likely admin-approved or released). Refresh and retry.",
        )
      }
      const updated = await tx.settlement.findUniqueOrThrow({ where: { id } })

      // Remove stale customer approval so the customer can approve again
      // (unique [settlementId, type] would otherwise block re-approval forever).
      // The revoked approval is preserved in the audit log below before deletion.
      const revoked = await tx.settlementApproval.findUnique({
        where: { settlementId_type: { settlementId: id, type: "CUSTOMER" } },
      })
      if (revoked) {
        await this.audit.log(
          {
            action: "SETTLEMENT_APPROVAL_REVOKED",
            entityType: "SettlementApproval",
            entityId: revoked.id,
            metadata: {
              settlementId: id,
              type: revoked.type,
              approvedBy: revoked.approvedBy,
              roleAtTime: revoked.roleAtTime,
              approvedAt:
                revoked.approvedAt?.toISOString?.() ?? revoked.approvedAt,
              revokedBy: userId,
              reason,
            },
            userId,
            organizationId: settlement.order.organizationId,
          },
          tx,
        )
        await tx.settlementApproval.delete({ where: { id: revoked.id } })
      }

      await tx.orderEvent.create({
        data: {
          orderId: settlement.orderId,
          eventType: "SETTLED",
          actorId: userId,
          message: `Settlement returned to review: ${reason}`,
          metadata: revoked
            ? {
                settlementId: id,
                revokedApprovalBy: revoked.approvedBy,
                revokedApprovalAt: revoked.approvedAt,
              }
            : { settlementId: id },
        },
      })

      return updated
    })
  }

  private async releaseFundsInternal(
    tx: any,
    settlementId: string,
    settlement: any,
    userId: string,
  ) {
    // The final money boundary owns its eligibility proof. Callers may perform
    // earlier checks for UX, but no future/manual/automated path can release by
    // invoking this method around the canonical locked decision.
    const eligibility = await evaluateSettlementEligibilityTx(
      tx,
      settlement.orderId,
    )
    if (eligibility.snapshot.orderStatus === "NOT_FOUND") {
      throw new NotFoundException("Order not found for settlement release")
    }
    if (!eligibility.eligible) {
      throw new BadRequestException({
        code: "SETTLEMENT_BLOCKED",
        message: `Settlement blocked: ${eligibility.reasons.join("; ")}`,
        reasons: eligibility.reasons,
      })
    }
    if (settlement.currency !== "USD") {
      throw new BadRequestException("Settlement currency must be exactly USD")
    }

    // Separation of duties: for platform inventory the fulfiller may not also
    // release the settlement. Look up the order's ownership + active delivery
    // submitter and block self-release.
    // Phase 8.2 (audit #2) — version is needed for the guarded Order.status
    // updateMany at the end of this method. Field list enumerated by recon:
    // every `order.<field>` access in releaseFundsInternal (activeDeliveryVersionId,
    // fulfillmentChannel, organizationId, website.ownershipType) plus version.
    const order = await tx.order.findUnique({
      where: { id: settlement.orderId },
      select: {
        id: true,
        version: true,
        activeDeliveryVersionId: true,
        fulfillmentChannel: true,
        organizationId: true,
        currency: true,
        warrantyDays: true,
        deliveredAt: true,
        website: { select: { ownershipType: true } },
      },
    })
    if (order) {
      const active = order.activeDeliveryVersionId
        ? await tx.orderDeliveryVersion.findUnique({
            where: { id: order.activeDeliveryVersionId },
            select: { submittedByUserId: true },
          })
        : null
      // Channel-first read for SoD check: a platform order must not be
      // released by its own fulfiller, regardless of the website's later
      // ownership changes.
      const channel =
        order.fulfillmentChannel ??
        (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
      const violation = checkSeparationOfDuties({
        ownershipType: channel,
        fulfilledByUserId: active?.submittedByUserId,
        releasedByUserId: userId,
      })
      if (violation) {
        await this.audit.log(
          {
            action: "ORDER_DELIVERY_SETTLEMENT_BLOCKED",
            entityType: "Settlement",
            entityId: settlementId,
            metadata: {
              ...orderEventMetadata(order),
              reason: violation,
              orderId: settlement.orderId,
            },
            userId,
            organizationId: order.organizationId,
          },
          tx,
        )
        throw new ForbiddenException(violation)
      }
    }

    // Prevent duplicate release: only release if status is ADMIN_APPROVED and version matches
    const released = await tx.settlement.updateMany({
      where: {
        id: settlementId,
        status: "ADMIN_APPROVED",
        version: settlement.version,
      },
      data: {
        status: "RELEASED",
        currency: "USD",
        settledAt: new Date(),
        version: { increment: 1 },
      },
    })
    if (released.count === 0) {
      throw new ConflictException(
        "Settlement was already released or modified by another request",
      )
    }

    const balance = await lockPublisherBalanceForUpdate(
      tx,
      settlement.publisherId,
    )
    if (balance && balance.currency !== "USD") {
      throw new BadRequestException(
        "Publisher balance currency must be exactly USD",
      )
    }

    const publisherAmount = new Decimal(settlement.publisherAmount)
    // Outstanding clawback debt is repaid before anything reaches
    // withdrawable — the publisher owes the platform from a prior refund.
    const debt = balance
      ? new Decimal(balance.debtBalance ?? 0)
      : new Decimal(0)
    const debtApplied = Decimal.min(debt, publisherAmount)
    const credited = publisherAmount.minus(debtApplied)

    if (balance) {
      const updated = await tx.publisherBalance.updateMany({
        where: {
          publisherId: settlement.publisherId,
          version: balance.version,
        },
        data: {
          currency: "USD",
          withdrawableBalance: { increment: credited },
          debtBalance: { decrement: debtApplied },
          lifetimeEarnings: { increment: publisherAmount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "Publisher balance was modified by another request. Retry.",
        )
      }
      checkPublisherBalanceInvariant(
        {
          ...balance,
          withdrawableBalance:
            Number(balance.withdrawableBalance) + Number(credited),
          debtBalance: Number(balance.debtBalance ?? 0) - Number(debtApplied),
        },
        this.logger,
        "releaseFundsInternal",
      )
    } else {
      await tx.publisherBalance.create({
        data: {
          publisherId: settlement.publisherId,
          currency: "USD",
          withdrawableBalance: publisherAmount,
          lifetimeEarnings: publisherAmount,
        },
      })
    }

    // Settlement released = order fully closed. COMPLETED is the terminal state;
    // post-release clawback still works (COMPLETED is refundable).
    //
    // Phase 8.2 (audit #2) — version-guarded so a concurrent order mutation
    // (customer dispute, force-cancel) doesn't get silently overwritten. A
    // Exact status/currency/payment predicates mirror the canonical gate as
    // defense in depth. A newly introduced state can never become payout-
    // eligible through a permissive notIn condition.
    // `order` may be null (the pre-existing null-check on line 517 covers
    // the SoD branch); if null at this point we still need to handle it.
    if (!order)
      throw new NotFoundException("Order not found for settlement release")
    const orderUpdated = await tx.order.updateMany({
      where: {
        id: settlement.orderId,
        version: order.version,
        status: "DELIVERED",
        currency: "USD",
        paymentStatus: "PAID",
      },
      data: {
        status: "COMPLETED",
        warrantyEndsAt: order.warrantyDays
          ? new Date(
              (order.deliveredAt?.getTime() ?? Date.now()) +
                order.warrantyDays * 86_400_000,
            )
          : null,
        version: { increment: 1 },
      },
    })
    if (orderUpdated.count === 0) {
      throw new ConflictException(
        "Order state changed during settlement release. Refresh and retry.",
      )
    }

    await tx.transaction.create({
      data: {
        amount: publisherAmount,
        currency: "USD",
        type: "SETTLEMENT_RELEASE",
        orderId: settlement.orderId,
        publisherId: settlement.publisherId,
        settlementId,
        description: `Settlement release of ${publisherAmount.toFixed(2)} for order ${settlement.orderId}`,
      },
    })

    if (debtApplied.greaterThan(0)) {
      await tx.transaction.create({
        data: {
          amount: debtApplied.negated(),
          currency: "USD",
          type: "DEBT_REPAYMENT",
          orderId: settlement.orderId,
          publisherId: settlement.publisherId,
          settlementId,
          description: `Debt repayment of ${debtApplied.toFixed(2)} netted from settlement release`,
        },
      })
    }

    await tx.orderEvent.create({
      data: {
        orderId: settlement.orderId,
        eventType: "SETTLED",
        actorId: userId,
        message: debtApplied.greaterThan(0)
          ? `Settlement released — ${debtApplied.toFixed(2)} applied to publisher debt and ${credited.toFixed(2)} added to withdrawable balance`
          : `Settlement released — ${publisherAmount.toFixed(2)} added to publisher balance`,
        metadata: {
          settlementId,
          publisherAmount: Number(settlement.publisherAmount),
          debtApplied: debtApplied.toNumber(),
          credited: credited.toNumber(),
        },
      },
    })

    await this.audit.log(
      {
        action: "SETTLEMENT_FUNDS_RELEASED",
        entityType: "Settlement",
        entityId: settlementId,
        metadata: {
          orderId: settlement.orderId,
          ...orderEventMetadata(order),
          publisherAmount: publisherAmount.toNumber(),
          debtApplied: debtApplied.toNumber(),
          previousStatus: "ADMIN_APPROVED",
        },
        userId,
        organizationId: order?.organizationId ?? null,
      },
      tx,
    )

    return {
      publisherAmount: publisherAmount.toFixed(2),
      debtApplied: debtApplied.toFixed(2),
      credited: credited.toFixed(2),
      currency: "USD",
    }
  }
}
