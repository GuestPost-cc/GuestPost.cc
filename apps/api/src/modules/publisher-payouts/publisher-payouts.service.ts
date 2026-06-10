import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { QUEUES } from "@guestpost/shared"
import { Decimal } from "@prisma/client/runtime/library"

const TIER_WITHDRAWAL_HOLDS: Record<string, number> = {
  NEW: 30,
  TRUSTED: 14,
  VERIFIED: 7,
}

@Injectable()
export class PublisherPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async getBalance(publisherId: string) {
    let balance = await this.prisma.publisherBalance.findUnique({
      where: { publisherId },
    })
    if (!balance) {
      balance = await this.prisma.publisherBalance.create({
        data: { publisherId },
      })
    }
    return balance
  }

  async requestWithdrawal(publisherId: string, amount: number, method: string, userId: string, idempotencyKey?: string) {
    const membership = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId },
    })
    if (!membership) throw new ForbiddenException("You do not own this publisher account")

    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const holdDays = TIER_WITHDRAWAL_HOLDS[publisher.tier] ?? 7
    const queuedAt = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)

    return this.prisma.$transaction(async (tx: any) => {
      // Idempotency: check for existing withdrawal with same reference
      if (idempotencyKey) {
        const existing = await tx.withdrawal.findFirst({
          where: { id: idempotencyKey, publisherId },
        })
        if (existing) return existing
      }

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId },
      })
      if (!balance) throw new NotFoundException("Publisher balance not found")

      const withdrawable = Number(balance.withdrawableBalance)
      if (withdrawable < amount) {
        throw new BadRequestException(
          `Insufficient withdrawable balance. Available: ${withdrawable}, requested: ${amount}`,
        )
      }

      // Use idempotencyKey as withdrawal id for dedup
      const withdrawalId = idempotencyKey ?? undefined

      const withdrawal = await tx.withdrawal.create({
        data: {
          id: withdrawalId,
          publisherId,
          amount,
          method,
          status: "PENDING",
        },
      })

      const updated = await tx.publisherBalance.updateMany({
        where: { publisherId, version: balance.version },
        data: {
          withdrawableBalance: { decrement: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Publisher balance was modified by another request. Retry.")
      }

      await this.audit.log({
        action: "WITHDRAWAL_REQUESTED",
        entityType: "Withdrawal",
        entityId: withdrawal.id,
        metadata: { publisherId, amount, method, holdDays, queuedAt: queuedAt.toISOString() },
        userId,
        organizationId: publisher.organizationId,
      })

      return withdrawal
    })
  }

  async approveWithdrawal(id: string, approvedBy: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "PENDING") {
      throw new BadRequestException("Withdrawal is not pending")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Status-guarded write: concurrent approve/reject — only one transition wins
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "PENDING", version: withdrawal.version },
        data: { status: "APPROVED", approvedBy, approvedAt: new Date(), version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is no longer pending")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      await this.audit.log({
        action: "WITHDRAWAL_APPROVED",
        entityType: "Withdrawal",
        entityId: id,
        metadata: { publisherId: withdrawal.publisherId, amount: Number(withdrawal.amount) },
        userId: approvedBy,
        organizationId: withdrawal.publisher.organizationId,
      })

      return updated
    })

    await this.notifyPublisherMembers(withdrawal.publisherId, withdrawal.publisher.organizationId, "WITHDRAWAL_APPROVED", `Withdrawal of ${withdrawal.amount} has been approved.`)

    return result
  }

  private async notifyPublisherMembers(publisherId: string, organizationId: string, type: string, message: string) {
    const memberships = await this.prisma.publisherMembership.findMany({
      where: { publisherId },
      select: { userId: true },
    })
    for (const m of memberships) {
      await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: m.userId,
        organizationId,
        type,
        message,
      })
    }
  }

  async markWithdrawalPaid(id: string, approvedBy: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "APPROVED") {
      throw new BadRequestException("Withdrawal must be approved before marking as paid")
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Status-guarded write: prevents double mark-paid (double lifetimePaid increment)
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "APPROVED", version: withdrawal.version },
        data: { status: "COMPLETED", approvedBy, approvedAt: new Date(), version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is not in APPROVED state")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      // Update lifetimePaid
      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: withdrawal.publisherId },
      })
      if (balance) {
        await tx.publisherBalance.updateMany({
          where: { publisherId: withdrawal.publisherId, version: balance.version },
          data: {
            lifetimePaid: { increment: Number(withdrawal.amount) },
            version: { increment: 1 },
          },
        })
      }

      await this.audit.log({
        action: "WITHDRAWAL_COMPLETED",
        entityType: "Withdrawal",
        entityId: id,
        metadata: { publisherId: withdrawal.publisherId, amount: Number(withdrawal.amount) },
        userId: approvedBy,
        organizationId: withdrawal.publisher.organizationId,
      })

      return updated
    })
  }

  async rejectWithdrawal(id: string, approvedBy: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "PENDING") {
      throw new BadRequestException("Only pending withdrawals can be rejected")
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Status-guarded write: prevents double reject (double balance restore)
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "PENDING", version: withdrawal.version },
        data: { status: "REJECTED", approvedBy, approvedAt: new Date(), version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is no longer pending")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: withdrawal.publisherId },
      })
      if (balance) {
        const restored = await tx.publisherBalance.updateMany({
          where: { publisherId: withdrawal.publisherId, version: balance.version },
          data: {
            withdrawableBalance: { increment: Number(withdrawal.amount) },
            version: { increment: 1 },
          },
        })
        if (restored.count === 0) {
          throw new ConflictException("Publisher balance was modified by another request. Retry.")
        }
      }

      await this.audit.log({
        action: "WITHDRAWAL_REJECTED",
        entityType: "Withdrawal",
        entityId: id,
        metadata: { publisherId: withdrawal.publisherId, amount: Number(withdrawal.amount) },
        userId: approvedBy,
        organizationId: withdrawal.publisher.organizationId,
      })

      return updated
    })

    await this.notifyPublisherMembers(withdrawal.publisherId, withdrawal.publisher.organizationId, "WITHDRAWAL_REJECTED", `Withdrawal of ${withdrawal.amount} was rejected.`)

    return result
  }

  async listWithdrawals(publisherId?: string, take = 50, skip = 0) {
    const where = publisherId ? { publisherId } : {}
    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { publisher: true },
        take,
        skip,
      }),
      this.prisma.withdrawal.count({ where }),
    ])
    return { items, total, take, skip }
  }
}
