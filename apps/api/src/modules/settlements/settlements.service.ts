import {
  checkSeparationOfDuties,
  evaluateSettlementEligibility,
  getSettlementReviewDays,
  orderEventMetadata,
  type PublisherTier,
  QUEUES,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import {
  resolvePlatformFeeFraction,
  splitPlatformFee,
} from "../../common/platform-fee"
import type { PrismaService } from "../../common/prisma.service"
import type { AuditService } from "../audit/audit.service"
import { assertOwnerOrCreator } from "../orders/services/owner-or-creator"
import type { QueueService } from "../queues/queue.service"

@Injectable()
export class SettlementsService {
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
    const eligibility = await evaluateSettlementEligibility(
      this.prisma,
      orderId,
    )
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

    // Find publisher from order items' websites + the website's ownership
    // type (we snapshot it onto Settlement so historical reports survive a
    // later ownership change).
    const item = await this.prisma.orderItem.findFirst({
      where: { orderId, websiteId: { not: null } },
      include: {
        website: { select: { publisherId: true, ownershipType: true } },
      },
    })
    const publisherId = item?.website?.publisherId
    const ownerType = item?.website?.ownershipType ?? null
    if (!publisherId)
      throw new BadRequestException("No publisher found for this order")

    // Phase 6: pull the per-service unitPrice from the snapshotted
    // ListingService row. Always present for new orders (Phase 4 hard
    // switch) but tolerate NULL for legacy orders that haven't been
    // backfilled — the column is nullable and reports degrade gracefully.
    const listingServiceId: string | null = order.listingServiceId ?? null
    let serviceType: any = order.type ?? null
    let unitPrice: Decimal | null = null
    if (order.listingServiceId) {
      const ls = await this.prisma.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: { price: true, serviceType: true },
      })
      if (ls) {
        unitPrice = new Decimal(ls.price)
        serviceType = ls.serviceType
      }
    }

    if (!order.amount || new Decimal(order.amount).lessThanOrEqualTo(0)) {
      throw new BadRequestException("Order has no amount to settle")
    }
    const feeFraction = await resolvePlatformFeeFraction(this.prisma)
    const { fee: platformFee, net: publisherAmount } = splitPlatformFee(
      order.amount,
      feeFraction,
    )

    // Tier-aware review window (Phase 7.2 — audit #6). The publisher's payout
    // is held while we keep re-checking the live link. If it's removed during
    // the window, the link sweep raises a fraud flag and settlement gating
    // blocks release. Window length: NEW=30d / TRUSTED=14d / VERIFIED=7d per
    // packages/shared/src/publisher-tier-policy.ts; env override wins when set.
    // Tier resolved inside the transaction via a focused PK lookup (Option B
    // per Phase 7.2 Key decision #6 — cheaper than cascading nested includes
    // into the existing include chain).

    return this.prisma.$transaction(async (tx: any) => {
      // Re-check inside transaction; partial unique index on Settlement.orderId
      // (status != CANCELLED) is the hard guarantee against concurrent duplicates
      const existing = await tx.settlement.findFirst({
        where: { orderId, status: { not: "CANCELLED" } },
      })
      if (existing)
        throw new BadRequestException(
          "Settlement already exists for this order",
        )

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

      let settlement: any
      try {
        settlement = await tx.settlement.create({
          data: {
            orderId,
            publisherId,
            grossAmount: order.amount,
            platformFee,
            publisherAmount,
            status: "PENDING",
            reviewEndsAt,
            // Phase 6 snapshots (read-only after creation).
            listingServiceId,
            serviceType,
            ownerType,
            fulfillmentChannel: order.fulfillmentChannel ?? null,
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
          message: `Settlement created — customer amount: ${order.amount}, publisher amount: ${publisherAmount}`,
          metadata: {
            settlementId: settlement.id,
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
            ...orderEventMetadata(order),
          },
          userId,
          organizationId: order.organizationId,
        },
        tx,
      )

      return settlement
    })
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

  async listSettlements(organizationId?: string, take = 50, skip = 0) {
    const where = organizationId ? { order: { organizationId } } : {}
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

    return this.prisma.$transaction(async (tx: any) => {
      // Conditional transition — the unguarded update here could overwrite a
      // settlement that was concurrently RELEASED (status corruption; the
      // pre-tx status check reads a stale snapshot).
      const transitioned = await tx.settlement.updateMany({
        where: {
          id,
          status: { in: ["PENDING", "UNDER_REVIEW"] },
          version: settlement.version,
        },
        data: { status: "CUSTOMER_APPROVED", version: { increment: 1 } },
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
    })
  }

  // Fired after the release transaction commits — queue writes are not transactional
  private async notifySettlementReleased(settlement: {
    id: string
    orderId: string
    publisherId: string
    publisherAmount: any
    order: { organizationId: string; customerId: string }
  }) {
    const memberships = await this.prisma.publisherMembership.findMany({
      where: { publisherId: settlement.publisherId },
      select: { userId: true },
    })
    for (const m of memberships) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: m.userId,
        organizationId: settlement.order.organizationId,
        type: "SETTLEMENT_RELEASED",
        message: `Settlement of ${settlement.publisherAmount} has been released to your balance.`,
      })
    }
    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: settlement.order.customerId,
      organizationId: settlement.order.organizationId,
      type: "SETTLEMENT_RELEASED",
      message: `Settlement for order ${settlement.orderId} has been released.`,
    })
  }

  // Staff approves settlement (admin side)
  async adminApprove(id: string, userId: string, staffRole: string) {
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

    const result = await this.prisma.$transaction(async (tx: any) => {
      const adminUpdated = await tx.settlement.updateMany({
        where: { id, status: "CUSTOMER_APPROVED", version: settlement.version },
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
      await this.releaseFundsInternal(
        tx,
        id,
        { ...settlement, version: fresh.version },
        userId,
      )

      // Row is now RELEASED — return the final state, not the snapshot
      return tx.settlement.findUniqueOrThrow({ where: { id } })
    })

    await this.notifySettlementReleased(settlement)

    return result
  }

  // Combined approval for dual-role staff (SUPER_ADMIN)
  async forceApprove(id: string, userId: string, staffRole: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED")
      throw new BadRequestException("Settlement already released")

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

    const targetStatus =
      settlement.status === "CUSTOMER_APPROVED"
        ? "ADMIN_APPROVED"
        : "CUSTOMER_APPROVED"

    const result = await this.prisma.$transaction(async (tx: any) => {
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

      if (targetStatus === "ADMIN_APPROVED") {
        await this.releaseFundsInternal(
          tx,
          id,
          { ...settlement, version: fresh.version },
          userId,
        )
        // releaseFundsInternal moved the row to RELEASED — return the final
        // state, not the pre-release snapshot
        return tx.settlement.findUnique({ where: { id } })
      }

      return fresh
    })

    if (targetStatus === "ADMIN_APPROVED") {
      await this.notifySettlementReleased(settlement)
    }

    return result
  }

  async cancelSettlement(id: string, userId: string, reason: string) {
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: { order: true, publisher: true },
    })
    if (!settlement) throw new NotFoundException("Settlement not found")
    if (settlement.status === "RELEASED")
      throw new BadRequestException("Cannot cancel released settlement")

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
        settledAt: new Date(),
        version: { increment: 1 },
      },
    })
    if (released.count === 0) {
      throw new ConflictException(
        "Settlement was already released or modified by another request",
      )
    }

    const balance = await tx.publisherBalance.findUnique({
      where: { publisherId: settlement.publisherId },
    })

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
    } else {
      await tx.publisherBalance.create({
        data: {
          publisherId: settlement.publisherId,
          withdrawableBalance: publisherAmount,
          lifetimeEarnings: publisherAmount,
        },
      })
    }

    // Settlement released = order fully closed. COMPLETED is the terminal state;
    // post-release clawback still works (COMPLETED is refundable).
    //
    // Phase 8.2 (audit #2) — version-guarded so a concurrent order mutation
    // (customer dispute, force-cancel) doesn't get silently overwritten. We
    // intentionally do NOT add a status predicate: releaseFundsInternal is
    // called from adminApprove + forceApprove with order in varying legitimate
    // pre-states (APPROVED / IN_PROGRESS / etc.); version-only is the safer
    // guard. If a status invariant is later proven, tighten the predicate.
    // `order` may be null (the pre-existing null-check on line 517 covers
    // the SoD branch); if null at this point we still need to handle it.
    if (!order)
      throw new NotFoundException("Order not found for settlement release")
    const orderUpdated = await tx.order.updateMany({
      where: { id: settlement.orderId, version: order.version },
      data: { status: "COMPLETED", version: { increment: 1 } },
    })
    if (orderUpdated.count === 0) {
      throw new ConflictException(
        "Order state changed during settlement release. Refresh and retry.",
      )
    }

    // Event-driven trust recompute (proven completion + payout released).
    await this.queue.enqueueTrustRecompute(
      settlement.publisherId,
      "SETTLEMENT_RELEASED",
      `settlement ${settlementId} released`,
    )

    await tx.transaction.create({
      data: {
        amount: publisherAmount,
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
        message: `Settlement released — ${settlement.publisherAmount} added to publisher balance`,
        metadata: {
          settlementId,
          publisherAmount: Number(settlement.publisherAmount),
        },
      },
    })
  }
}
