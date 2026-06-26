import {
  getWithdrawalHoldDays,
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
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { PayoutExecutionService } from "./payout-execution.service"

// Phase 7.2 — TIER_WITHDRAWAL_HOLDS lifted to packages/shared/src/publisher-tier-policy.ts
// (audit #6 sibling rider). Single source of truth across the platform for
// "what does each publisher tier mean numerically" — see TIER_WITHDRAWAL_HOLD_DAYS
// and TIER_SETTLEMENT_REVIEW_DAYS in that file.

@Injectable()
export class PublisherPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly encryption: PayoutEncryptionService,
    readonly _execution: PayoutExecutionService,
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
    if (!membership)
      throw new ForbiddenException("You do not own this publisher account")
  }

  async createPayoutMethod(
    publisherId: string,
    userId: string,
    dto: {
      type: string
      label: string
      details: Record<string, unknown>
      isDefault?: boolean
    },
  ) {
    await this.assertPublisherMember(userId, publisherId)
    const allowed = ["bank_transfer", "paypal", "wise"]
    if (!allowed.includes(dto.type)) {
      throw new BadRequestException(
        `Payout method type must be one of: ${allowed.join(", ")}`,
      )
    }

    const { ciphertext, version } = this.encryption.encrypt(dto.details)
    const displayDetails = this.encryption.extractDisplayDetails(
      dto.details,
      dto.type,
    )

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
          details: ciphertext as any,
          displayDetails: displayDetails as any,
          encryptionKeyVersion: version,
          isDefault: dto.isDefault ?? false,
        },
      })
      const publisher = await tx.publisher.findUnique({
        where: { id: publisherId },
      })
      await this.audit.log(
        {
          action: "PAYOUT_METHOD_CREATED",
          entityType: "PayoutMethod",
          entityId: method.id,
          metadata: { publisherId, type: dto.type, label: dto.label },
          userId,
          organizationId: publisher?.organizationId as string | null,
        },
        tx,
      )
      return {
        id: method.id,
        type: method.type,
        label: method.label,
        isDefault: method.isDefault,
        displayDetails,
      }
    })
  }

  async listPayoutMethods(publisherId: string, userId: string) {
    await this.assertPublisherMember(userId, publisherId)
    const methods = await this.prisma.payoutMethod.findMany({
      where: { publisherId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        type: true,
        label: true,
        displayDetails: true,
        isDefault: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return methods.map((m: any) => ({
      id: m.id,
      type: m.type,
      label: m.label,
      isDefault: m.isDefault,
      displayDetails: m.displayDetails ?? {},
    }))
  }

  async decryptPayoutMethod(
    methodId: string,
    userId: string,
    reason: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<{
    details: Record<string, unknown>
    methodId: string
    publisherId: string
  }> {
    const method = await this.prisma.payoutMethod.findUnique({
      where: { id: methodId },
      include: { publisher: { select: { organizationId: true } } },
    })
    if (!method) throw new NotFoundException("Payout method not found")

    const details = this.encryption.decrypt(
      method.details as unknown as string,
      method.encryptionKeyVersion,
    )

    await this.audit.log({
      action: "PAYOUT_METHOD_DECRYPTED",
      entityType: "PayoutMethod",
      entityId: methodId,
      metadata: {
        publisherId: method.publisherId,
        reason,
        ipAddress,
        userAgent,
      },
      userId,
      organizationId: method.publisher?.organizationId ?? null,
    })

    return { details, methodId, publisherId: method.publisherId }
  }

  async deactivatePayoutMethod(
    publisherId: string,
    userId: string,
    id: string,
  ) {
    await this.assertPublisherMember(userId, publisherId)
    const method = await this.prisma.payoutMethod.findFirst({
      where: { id, publisherId },
    })
    if (!method) throw new NotFoundException("Payout method not found")

    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    await this.prisma.payoutMethod.update({
      where: { id },
      data: { isActive: false, isDefault: false },
    })
    await this.audit.log({
      action: "PAYOUT_METHOD_DEACTIVATED",
      entityType: "PayoutMethod",
      entityId: id,
      metadata: { publisherId },
      userId,
      organizationId: publisher?.organizationId ?? null,
    })
    return { id, isActive: false }
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

    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException("Withdrawal amount must be positive")
    }

    if (payoutMethodId) {
      const payoutMethod = await this.prisma.payoutMethod.findFirst({
        where: { id: payoutMethodId, publisherId, isActive: true },
      })
      if (!payoutMethod)
        throw new BadRequestException("Payout method not found or inactive")
    }

    // Tier hold: fraud window before staff may approve the payout.
    // Values: NEW=30d / TRUSTED=14d / VERIFIED=7d. Helper applies
    // WITHDRAWAL_HOLD_DAYS env override when set (incident-response escape
    // hatch). Falls back to NEW (most conservative) if tier is somehow null.
    const holdDays = getWithdrawalHoldDays(
      (publisher.tier ?? "NEW") as PublisherTier,
      process.env.WITHDRAWAL_HOLD_DAYS,
    )
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
          const existing = await tx.withdrawal.findFirst({
            where: { publisherId, idempotencyKey },
          })
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
        throw new ConflictException(
          "Publisher balance was modified by another request. Retry.",
        )
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

      await this.audit.log(
        {
          action: "WITHDRAWAL_REQUESTED",
          entityType: "Withdrawal",
          entityId: created.id,
          metadata: {
            publisherId,
            amount,
            method,
            holdDays,
            availableAt: availableAt.toISOString(),
          },
          userId,
          organizationId: publisher.organizationId,
        },
        tx,
      )

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
    if (
      withdrawal.availableAt &&
      withdrawal.availableAt.getTime() > Date.now()
    ) {
      throw new BadRequestException(
        `Withdrawal is in its ${withdrawal.publisher.tier} tier hold until ${withdrawal.availableAt.toISOString()}`,
      )
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Status-guarded write: concurrent approve/reject — only one transition wins
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "PENDING", version: withdrawal.version },
        data: {
          status: "APPROVED",
          approvedBy,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is no longer pending")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      await this.audit.log(
        {
          action: "WITHDRAWAL_APPROVED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: withdrawal.publisherId,
            amount: Number(withdrawal.amount),
          },
          userId: approvedBy,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

      return updated
    })

    await this.notifyPublisherMembers(
      withdrawal.publisherId,
      withdrawal.publisher.organizationId,
      "WITHDRAWAL_APPROVED",
      `Withdrawal of ${withdrawal.amount} has been approved.`,
    )

    return result
  }

  private async notifyPublisherMembers(
    publisherId: string,
    organizationId: string,
    type: string,
    message: string,
  ) {
    const memberships = await this.prisma.publisherMembership.findMany({
      where: { publisherId },
      select: { userId: true },
    })
    for (const m of memberships) {
      this.queue.addJob(QUEUES.NOTIFICATION, "push-in-app", {
        userId: m.userId,
        organizationId,
        type,
        message,
      }).catch(() => {})
    }
  }

  async markWithdrawalPaid(id: string, approvedBy: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (
      withdrawal.status !== "APPROVED" &&
      withdrawal.status !== "PROCESSING"
    ) {
      throw new BadRequestException(
        "Withdrawal must be approved before marking as paid",
      )
    }

    // PROCESSING means a payout execution is in flight. Only a MANUAL
    // execution may be completed by hand — automated providers (Wise/Stripe)
    // own their completion via webhook or status poll, and marking those paid
    // here could double-pay if the provider later settles the transfer.
    let inFlightManualExecution: any = null
    if (withdrawal.status === "PROCESSING") {
      inFlightManualExecution = await this.prisma.payoutExecution.findFirst({
        where: { withdrawalId: id, status: "PROCESSING" },
        include: { provider: true },
      })
      if (inFlightManualExecution?.provider.name !== "manual") {
        throw new BadRequestException(
          "Withdrawal is being processed by an automated provider — completion comes from the provider, not mark-paid",
        )
      }
    }

    return this.prisma.$transaction(async (tx: any) => {
      // Status-guarded write: prevents double mark-paid (double lifetimePaid increment)
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: withdrawal.status, version: withdrawal.version },
        data: {
          status: "COMPLETED",
          approvedBy,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal state changed — retry")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      if (inFlightManualExecution) {
        // Complete the in-flight manual execution instead of creating a duplicate
        const execDone = await tx.payoutExecution.updateMany({
          where: { id: inFlightManualExecution.id, status: "PROCESSING" },
          data: {
            status: "COMPLETED",
            providerMetadata: {
              markedBy: approvedBy,
              markedAt: new Date().toISOString(),
            },
          },
        })
        if (execDone.count === 0) {
          throw new ConflictException("Execution state changed — retry")
        }
      } else {
        // Direct mark-paid without an execution: record one for traceability
        const manualProvider = await tx.payoutProvider.findUnique({
          where: { name: "manual" },
        })
        if (manualProvider) {
          await tx.payoutExecution.create({
            data: {
              withdrawalId: id,
              providerId: manualProvider.id,
              status: "COMPLETED",
              amount: withdrawal.amount,
              providerExecutionId: `manual-${id}-${Date.now()}`,
              providerMetadata: {
                markedBy: approvedBy,
                markedAt: new Date().toISOString(),
              },
            },
          })
        }
      }

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: withdrawal.publisherId },
      })
      if (balance) {
        await tx.publisherBalance.updateMany({
          where: {
            publisherId: withdrawal.publisherId,
            version: balance.version,
          },
          data: {
            lifetimePaid: { increment: Number(withdrawal.amount) },
            version: { increment: 1 },
          },
        })
      }

      await this.audit.log(
        {
          action: "WITHDRAWAL_COMPLETED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: withdrawal.publisherId,
            amount: Number(withdrawal.amount),
          },
          userId: approvedBy,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

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
        data: {
          status: "REJECTED",
          approvedBy,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
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
          where: {
            publisherId: withdrawal.publisherId,
            version: balance.version,
          },
          data: {
            withdrawableBalance: { increment: Number(withdrawal.amount) },
            version: { increment: 1 },
          },
        })
        if (restored.count === 0) {
          throw new ConflictException(
            "Publisher balance was modified by another request. Retry.",
          )
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

      await this.audit.log(
        {
          action: "WITHDRAWAL_REJECTED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: withdrawal.publisherId,
            amount: Number(withdrawal.amount),
          },
          userId: approvedBy,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

      return updated
    })

    await this.notifyPublisherMembers(
      withdrawal.publisherId,
      withdrawal.publisher.organizationId,
      "WITHDRAWAL_REJECTED",
      `Withdrawal of ${withdrawal.amount} was rejected.`,
    )

    return result
  }

  // FAILED -> REVERSED administrative recovery. A withdrawal whose payout
  // execution hard-failed (bad bank details, provider rejection) otherwise
  // traps the publisher's funds forever: the balance was decremented at
  // request time and rejectWithdrawal only handles PENDING. Returns the money
  // to withdrawableBalance so the publisher can fix details and re-request.
  async reverseFailedWithdrawal(
    id: string,
    reversedBy: string,
    reason: string,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: { publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "FAILED") {
      throw new BadRequestException(
        `Only FAILED withdrawals can be reversed (current: ${withdrawal.status})`,
      )
    }

    // Money must not have actually moved at the provider. A COMPLETED
    // execution means the publisher was paid; PROCESSING means the provider
    // may still pay — reversing either would double the funds.
    const unsafeExecution = await this.prisma.payoutExecution.findFirst({
      where: { withdrawalId: id, status: { in: ["COMPLETED", "PROCESSING"] } },
      select: { id: true, status: true },
    })
    if (unsafeExecution) {
      throw new BadRequestException(
        `Cannot reverse: execution ${unsafeExecution.id} is ${unsafeExecution.status} — resolve at the provider first`,
      )
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      // Status+version guard: double reversal would double-restore the balance
      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "FAILED", version: withdrawal.version },
        data: {
          status: "REVERSED",
          approvedBy: reversedBy,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      })
      if (transitioned.count === 0) {
        throw new ConflictException(
          "Withdrawal is no longer FAILED — already reversed or retried",
        )
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({ where: { id } })

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: withdrawal.publisherId },
      })
      if (!balance) throw new NotFoundException("Publisher balance not found")
      const restored = await tx.publisherBalance.updateMany({
        where: {
          publisherId: withdrawal.publisherId,
          version: balance.version,
        },
        data: {
          withdrawableBalance: { increment: Number(withdrawal.amount) },
          version: { increment: 1 },
        },
      })
      if (restored.count === 0) {
        throw new ConflictException(
          "Publisher balance was modified by another request. Retry.",
        )
      }

      // Offsetting ledger row for the WITHDRAWAL written at request time.
      // Unique reference makes a concurrent duplicate reversal abort here
      // even if it somehow passed the status guard.
      await tx.transaction.create({
        data: {
          amount: withdrawal.amount,
          type: "WITHDRAWAL_REVERSAL",
          publisherId: withdrawal.publisherId,
          reference: `withdrawal-reverse-${id}`,
          description: `Failed withdrawal ${id} reversed — funds restored: ${reason}`,
        },
      })

      await this.audit.log(
        {
          action: "WITHDRAWAL_REVERSED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: withdrawal.publisherId,
            amount: Number(withdrawal.amount),
            reason,
          },
          userId: reversedBy,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

      return updated
    })

    await this.notifyPublisherMembers(
      withdrawal.publisherId,
      withdrawal.publisher.organizationId,
      "WITHDRAWAL_REVERSED",
      `Failed withdrawal of ${withdrawal.amount} was reversed — funds returned to your balance.`,
    )

    return result
  }

  async listWithdrawals(publisherId?: string, take = 50, skip = 0) {
    const where = publisherId ? { publisherId } : {}
    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          publisher: true,
          payoutMethod: { select: { id: true, type: true, label: true } },
        },
        take,
        skip,
      }),
      this.prisma.withdrawal.count({ where }),
    ])
    return { items, total, take, skip }
  }
}
