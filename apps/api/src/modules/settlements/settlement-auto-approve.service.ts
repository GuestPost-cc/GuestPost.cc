import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { orderEventMetadata } from "@guestpost/shared"

/**
 * Consumes Settlement.reviewEndsAt: settlements still awaiting the customer
 * after the review window closes are auto-approved on the customer's behalf
 * (the window IS the customer's chance to object). Admin approval is still
 * required for release, so dual control is preserved while the customer
 * bottleneck disappears.
 *
 * Interval-based; every mutation is status-guarded so concurrent API
 * instances or a racing manual approval cannot double-apply.
 * Disable with SETTLEMENT_AUTO_APPROVE_DISABLED=true.
 */
@Injectable()
export class SettlementAutoApproveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementAutoApproveService.name)
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (process.env.SETTLEMENT_AUTO_APPROVE_DISABLED === "true") {
      this.logger.warn("Settlement auto-approve disabled via SETTLEMENT_AUTO_APPROVE_DISABLED")
      return
    }
    const intervalMs = Math.max(Number(process.env.SETTLEMENT_AUTO_APPROVE_INTERVAL_MS ?? 15 * 60 * 1000), 60_000)
    this.timer = setInterval(() => {
      this.run().catch((err) => this.logger.error(`Auto-approve sweep failed: ${err}`))
    }, intervalMs)
    this.timer.unref()
    this.logger.log(`Settlement auto-approve sweep every ${intervalMs}ms`)
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  async run() {
    const due = await this.prisma.settlement.findMany({
      where: {
        status: { in: ["PENDING", "UNDER_REVIEW"] },
        reviewEndsAt: { lte: new Date() },
      },
      // Phase 6.9 — include the snapshot trio so orderEventMetadata reads
      // the same fields here as everywhere else. Adds 6 columns to the
      // select; no extra query.
      include: {
        order: {
          select: {
            id: true,
            organizationId: true,
            listingId: true,
            listingServiceId: true,
            type: true,
            fulfillmentChannel: true,
            websiteId: true,
            amount: true,
          },
        },
      },
      take: 100,
    })

    for (const settlement of due) {
      const activeDispute = await this.prisma.orderDispute.findFirst({
        where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
      })
      if (activeDispute) continue

      try {
        await this.prisma.$transaction(async (tx: any) => {
          // Status+version guard — a manual approval racing this sweep wins
          const updated = await tx.settlement.updateMany({
            where: {
              id: settlement.id,
              status: { in: ["PENDING", "UNDER_REVIEW"] },
              version: settlement.version,
            },
            data: { status: "CUSTOMER_APPROVED", version: { increment: 1 } },
          })
          if (updated.count === 0) return

          await tx.settlementApproval.upsert({
            where: { settlementId_type: { settlementId: settlement.id, type: "CUSTOMER" } },
            create: {
              settlementId: settlement.id,
              type: "CUSTOMER",
              approvedBy: "SYSTEM_AUTO_APPROVE",
              roleAtTime: "SYSTEM",
            },
            update: {},
          })

          await tx.orderEvent.create({
            data: {
              orderId: settlement.orderId,
              eventType: "SETTLED",
              actorId: null,
              message: `Settlement auto-approved — review window ended ${settlement.reviewEndsAt?.toISOString()}`,
              metadata: { settlementId: settlement.id, auto: true },
            },
          })

          await this.audit.log({
            action: "SETTLEMENT_AUTO_APPROVED",
            entityType: "Settlement",
            entityId: settlement.id,
            metadata: {
              ...orderEventMetadata(settlement.order),
              orderId: settlement.orderId,
              reviewEndsAt: settlement.reviewEndsAt?.toISOString(),
            },
            userId: null,
            organizationId: settlement.order.organizationId,
          }, tx)
        })
        this.logger.log(`Auto-approved settlement ${settlement.id} (review window ended)`)
      } catch (err) {
        this.logger.error(`Auto-approve failed for settlement ${settlement.id}: ${err}`)
      }
    }
  }
}
