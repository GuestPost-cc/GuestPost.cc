import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common"
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

  async requestWithdrawal(publisherId: string, amount: number, method: string, userId: string) {
    const balance = await this.getBalance(publisherId)

    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const holdDays = TIER_WITHDRAWAL_HOLDS[publisher.tier] ?? 7
    const queuedAt = new Date(Date.now() + holdDays * 24 * 60 * 60 * 1000)

    const withdrawable = Number(balance.withdrawableBalance)
    if (withdrawable < amount) {
      throw new BadRequestException(
        `Insufficient withdrawable balance. Available: ${withdrawable}, requested: ${amount}`,
      )
    }

    return this.prisma.$transaction(async (tx: any) => {
      const withdrawal = await tx.withdrawal.create({
        data: {
          publisherId,
          amount,
          method,
          status: "PENDING",
        },
      })

      await tx.publisherBalance.update({
        where: { publisherId },
        data: {
          withdrawableBalance: { decrement: amount },
        },
      })

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
      const updated = await tx.withdrawal.update({
        where: { id },
        data: { status: "APPROVED", approvedBy, approvedAt: new Date() },
      })

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

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: approvedBy, // Ideally the publisher owner
      organizationId: withdrawal.publisher.organizationId,
      type: "WITHDRAWAL_APPROVED",
      message: `Withdrawal of ${withdrawal.amount} has been approved.`,
    })

    return result
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
      const updated = await tx.withdrawal.update({
        where: { id },
        data: { status: "COMPLETED", approvedBy, approvedAt: new Date() },
      })

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
      const updated = await tx.withdrawal.update({
        where: { id },
        data: { status: "REJECTED", approvedBy, approvedAt: new Date() },
      })

      await tx.publisherBalance.update({
        where: { publisherId: withdrawal.publisherId },
        data: { withdrawableBalance: { increment: Number(withdrawal.amount) } },
      })

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

    await this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
      userId: approvedBy, // Ideally publisher owner
      organizationId: withdrawal.publisher.organizationId,
      type: "WITHDRAWAL_REJECTED",
      message: `Withdrawal of ${withdrawal.amount} was rejected.`,
    })

    return result
  }

  async listWithdrawals(publisherId?: string) {
    const where = publisherId ? { publisherId } : {}
    return this.prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { publisher: true },
    })
  }
}
