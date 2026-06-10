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

  // ─── PAYOUT METHODS ─────────────────────────────────────────

  private async assertPublisherMember(userId: string, publisherId: string) {
    const membership = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId },
    })
    if (!membership) throw new ForbiddenException("You do not own this publisher account")
  }

  async createPayoutMethod(publisherId: string, userId: string, dto: { type: string; label: string; details: Record<string, unknown>; isDefault?: boolean }) {
    await this.assertPublisherMember(userId, publisherId)
    const allowed = ["bank_transfer", "paypal", "wise"]
    if (!allowed.includes(dto.type)) {
      throw new BadRequestException(`Payout method type must be one of: ${allowed.join(", ")}`)
    }

    return this.prisma.$transaction(async (tx: any) => {
      if (dto.isDefault) {
        await tx.payoutMethod.updateMany({
          where: { publisherId, isDefault: true },
          data: { isDefault: false },
        })
      }
      const method = await tx.payoutMethod.create({
        data: {
          publisherId,
          type: dto.type,
          label: dto.label,
          details: dto.details as any,
          isDefault: dto.isDefault ?? false,
        },
      })
      await this.audit.log({
        action: "PAYOUT_METHOD_CREATED",
        entityType: "PayoutMethod",
        entityId: method.id,
        metadata: { publisherId, type: dto.type, label: dto.label },
        userId,
        organizationId: null,
      }, tx)
      return method
    })
  }

  async listPayoutMethods(publisherId: string, userId: string) {
    await this.assertPublisherMember(userId, publisherId)
    return this.prisma.payoutMethod.findMany({
      where: { publisherId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    })
  }

  async deactivatePayoutMethod(publisherId: string, userId: string, id: string) {
    await this.assertPublisherMember(userId, publisherId)
    const method = await this.prisma.payoutMethod.findFirst({ where: { id, publisherId } })
    if (!method) throw new NotFoundException("Payout method not found")

    const updated = await this.prisma.payoutMethod.update({
      where: { id },
      data: { isActive: false, isDefault: false },
    })
    await this.audit.log({
      action: "PAYOUT_METHOD_DEACTIVATED",
      entityType: "PayoutMethod",
      entityId: id,
      metadata: { publisherId },
      userId,
      organizationId: null,
    })
    return updated
  }

  // ─── WITHDRAWALS ────────────────────────────────────────────

  async requestWithdrawal(
    publisherId: string,
    amount: number,
    method: string,
    userId: string,
    idempotencyKey?: string,
    payoutMethodId?: string,
  ) {
    await this.assertPublisherMember(userId, publisherId)

    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher) throw new NotFoundException("Publisher not found")

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Withdrawal amount must be positive")
    }

    if (payoutMethodId) {
      const payoutMethod = await this.prisma.payoutMethod.findFirst({
        where: { id: payoutMethodId, publisherId, isActive: true },
      })
      if (!payoutMethod) throw new BadRequestException("Payout method not found or inactive")
    }

    // Tier hold: fraud window before staff may approve the payout.
    const holdDays = TIER_WITHDRAWAL_HOLDS[publisher.tier] ?? 7
    const availableAt = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)

    const withdrawal = await this.prisma.$transaction(async (tx: any) => {
      // Idempotency: scoped per publisher via @@unique([publisherId, idempotencyKey]).
      // Never used as the row's PK — a colliding client key must not be able
      // to address another publisher's withdrawal.
      if (idempotencyKey) {
        const existing = await tx.withdrawal.findFirst({
          where: { publisherId, idempotencyKey },
        })
        if (existing) return existing
      }

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId },
      })
      if (!balance) throw new NotFoundException("Publisher balance not found")

      const withdrawable = new Decimal(balance.withdrawableBalance)
      if (withdrawable.lessThan(amount)) {
        throw new BadRequestException(
          `Insufficient withdrawable balance. Available: ${withdrawable}, requested: ${amount}`,
        )
      }

      let created: any
      try {
        created = await tx.withdrawal.create({
          data: {
            publisherId,
            amount,
            method,
            status: "PENDING",
            availableAt,
            idempotencyKey: idempotencyKey ?? null,
            payoutMethodId: payoutMethodId ?? null,
          },
        })
      } catch (err: any) {
        if (err?.code === "P2002") {
          // Concurrent duplicate with same idempotency key
          const existing = await tx.withdrawal.findFirst({ where: { publisherId, idempotencyKey } })
          if (existing) return existing
        }
        throw err
      }

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

      // Ledger row at REQUEST time — this is when the balance moves. A
      // rejection writes the offsetting WITHDRAWAL_REVERSAL.
      await tx.transaction.create({
        data: {
          amount: new Decimal(amount).negated(),
          type: "WITHDRAWAL",
          publisherId,
          reference: `withdrawal-${created.id}`,
          description: `Withdrawal request of ${amount} via ${method}`,
        },
      })

      await this.audit.log({
        action: "WITHDRAWAL_REQUESTED",
        entityType: "Withdrawal",
        entityId: created.id,
        metadata: { publisherId, amount, method, holdDays, availableAt: availableAt.toISOString() },
        userId,
        organizationId: publisher.organizationId,
      }, tx)

      return created
    })

    return withdrawal
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

    // Tier hold is a hard gate, not advisory metadata.
    if (withdrawal.availableAt && withdrawal.availableAt.getTime() > Date.now()) {
      throw new BadRequestException(
        `Withdrawal is in its ${withdrawal.publisher.tier} tier hold until ${withdrawal.availableAt.toISOString()}`,
      )
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
      }, tx)

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

      // The WITHDRAWAL ledger row was written at request time (when the
      // balance moved) — only lifetimePaid changes here.
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
      }, tx)

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

      // Offsetting ledger row for the WITHDRAWAL written at request time
      await tx.transaction.create({
        data: {
          amount: withdrawal.amount,
          type: "WITHDRAWAL_REVERSAL",
          publisherId: withdrawal.publisherId,
          reference: `withdrawal-reject-${id}`,
          description: `Withdrawal ${id} rejected — funds restored`,
        },
      })

      await this.audit.log({
        action: "WITHDRAWAL_REJECTED",
        entityType: "Withdrawal",
        entityId: id,
        metadata: { publisherId: withdrawal.publisherId, amount: Number(withdrawal.amount) },
        userId: approvedBy,
        organizationId: withdrawal.publisher.organizationId,
      }, tx)

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
        include: { publisher: true, payoutMethod: { select: { id: true, type: true, label: true } } },
        take,
        skip,
      }),
      this.prisma.withdrawal.count({ where }),
    ])
    return { items, total, take, skip }
  }
}
