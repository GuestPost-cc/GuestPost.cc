import { Injectable, Logger, ConflictException, NotFoundException, BadRequestException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { PayoutProviderService } from "./payout-provider.service"

@Injectable()
export class PayoutExecutionService {
  private readonly logger = new Logger(PayoutExecutionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryption: PayoutEncryptionService,
    private readonly providerService: PayoutProviderService,
  ) {}

  async executeWithdrawal(withdrawalId: string, providerName: string, userId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { payoutMethod: true, publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "APPROVED") {
      throw new BadRequestException(`Withdrawal ${withdrawalId} is ${withdrawal.status}, expected APPROVED`)
    }

    const adapter = this.providerService.getAdapter(providerName)
    const provider = await this.providerService.getActiveProvider(providerName)

    if (withdrawal.payoutMethod && !withdrawal.payoutMethod.isActive) {
      throw new Error("Payout method is no longer active")
    }

    const decryptedDetails = withdrawal.payoutMethod
      ? this.encryption.decrypt(
          withdrawal.payoutMethod.details as unknown as string,
          withdrawal.payoutMethod.encryptionKeyVersion,
        )
      : {}

    let execution: any
    let versionSnapshot: number

    const result = await this.prisma.$transaction(async (tx: any) => {
      const transitioned = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: "APPROVED", version: withdrawal.version },
        data: { status: "PROCESSING", version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is not in APPROVED state")
      }

      const updatedWithdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } })
      versionSnapshot = updatedWithdrawal.version

      execution = await tx.payoutExecution.create({
        data: {
          withdrawalId,
          providerId: provider.id,
          status: "PROCESSING",
          amount: withdrawal.amount,
          fee: 0,
          idempotencyKey: `payout-${withdrawalId}-v${versionSnapshot}`,
        },
      })

      await this.audit.log({
        action: "PAYOUT_EXECUTION_STARTED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: { withdrawalId, providerName, amount: Number(withdrawal.amount) },
        userId,
        organizationId: withdrawal.publisher.organizationId,
      }, tx)

      return { execution, versionSnapshot }
    })

    const execResult = result as { execution: any; versionSnapshot: number }
    execution = execResult.execution
    versionSnapshot = execResult.versionSnapshot

    try {
      const transferResult = await adapter.createTransfer({
        amount: Number(withdrawal.amount),
        currency: "usd",
        recipientDetails: decryptedDetails,
        providerConfig: provider.decryptedConfig,
        idempotencyKey: `payout-${withdrawalId}-v${versionSnapshot}`,
        description: `Publisher payout — withdrawal ${withdrawal.id}`,
      })

      await this.prisma.$transaction(async (tx: any) => {
        await tx.payoutExecution.update({
          where: { id: execution.id },
          data: {
            status: transferResult.status === "COMPLETED" ? "COMPLETED" : "PROCESSING",
            providerExecutionId: transferResult.providerExecutionId,
            fee: transferResult.fee ?? 0,
            providerMetadata: transferResult.metadata as any ?? undefined,
          },
        })

        const withdrawalStatus = transferResult.status === "COMPLETED" ? "COMPLETED" : "PROCESSING"
        const updated = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: "PROCESSING" },
          data: { status: withdrawalStatus, version: { increment: 1 } },
        })
        if (updated.count === 0) {
          throw new ConflictException("Withdrawal state changed during payout execution")
        }

        if (transferResult.status === "COMPLETED") {
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
        }

        await this.audit.log({
          action: transferResult.status === "COMPLETED" ? "PAYOUT_EXECUTION_COMPLETED" : "PAYOUT_EXECUTION_SENT",
          entityType: "PayoutExecution",
          entityId: execution.id,
          metadata: { withdrawalId, providerExecutionId: transferResult.providerExecutionId, status: transferResult.status },
          userId,
          organizationId: withdrawal.publisher.organizationId,
        }, tx)
      })

      return { executionId: execution.id, status: transferResult.status, providerExecutionId: transferResult.providerExecutionId }
    } catch (err: any) {
      // Provider errors can echo the request body (bank details) back in the
      // message — redact before it touches logs, the DB, or the audit trail.
      const safeMessage = this.encryption.redactSensitive(String(err.message ?? err))
      this.logger.error(`Payout execution failed for withdrawal ${withdrawalId}: ${safeMessage}`)

      let providerExecId: string | null = null
      try {
        providerExecId = execution?.id
      } catch { /* swallow */ }

      await this.prisma.$transaction(async (tx: any) => {
        const updateData: any = {
          status: "FAILED",
          errorMessage: safeMessage,
        }

        await tx.payoutExecution.update({
          where: { id: execution.id },
          data: updateData,
        })
        await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: "PROCESSING" },
          data: { status: "FAILED", version: { increment: 1 } },
        })
        await this.audit.log({
          action: "PAYOUT_EXECUTION_FAILED",
          entityType: "PayoutExecution",
          entityId: execution.id,
          metadata: { withdrawalId, error: safeMessage, providerExecutionId: providerExecId ?? undefined },
          userId,
          organizationId: withdrawal.publisher.organizationId,
        }, tx)
      })

      // Rethrow with the redacted message so upstream handlers (BullMQ worker
      // logs, exception filters) never see raw banking data. Mutating in place
      // preserves the error class and HTTP status semantics.
      if (err && typeof err === "object") err.message = safeMessage
      throw err
    }
  }

  async retryExecution(executionId: string, userId: string) {
    const execution = await this.prisma.payoutExecution.findUnique({
      where: { id: executionId },
      include: { withdrawal: { include: { publisher: true } }, provider: true },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (execution.status !== "FAILED") {
      throw new BadRequestException(`Execution ${executionId} is ${execution.status}, expected FAILED`)
    }

    // A FAILED execution that already reached the provider may have actually
    // gone through (timeout after send, late webhook marked it failed, etc.).
    // Re-sending would pay the publisher twice — the retry gets a NEW
    // idempotency key because the withdrawal version advances. Ask the
    // provider for the truth before moving money again.
    if (execution.providerExecutionId) {
      const adapter = this.providerService.getAdapter(execution.provider.name)
      const providerStatus = await adapter.checkTransferStatus(execution.providerExecutionId)
      if (providerStatus.status === "COMPLETED") {
        await this.finalizeCompletedAtProvider(execution, providerStatus, userId)
        return { executionId: execution.id, status: "COMPLETED", providerExecutionId: execution.providerExecutionId, recoveredFromProvider: true }
      }
      if (providerStatus.status === "PROCESSING") {
        throw new ConflictException(
          `Provider transfer ${execution.providerExecutionId} is still processing — cannot retry until it settles`,
        )
      }
    }

    if (execution.withdrawal.status !== "FAILED") {
      const r = await this.prisma.withdrawal.updateMany({
        where: { id: execution.withdrawalId, version: execution.withdrawal.version },
        data: { status: "FAILED", version: { increment: 1 } },
      })
      if (r.count === 0) {
        throw new ConflictException("Withdrawal state changed — cannot retry")
      }
    }

    return this.executeWithdrawal(execution.withdrawalId, execution.provider.name, userId)
  }

  // The provider says the money already moved: reconcile our records to match
  // instead of sending it again.
  private async finalizeCompletedAtProvider(execution: any, providerStatus: { fee?: number; metadata?: Record<string, unknown> }, userId: string) {
    await this.prisma.$transaction(async (tx: any) => {
      const execUpdated = await tx.payoutExecution.updateMany({
        where: { id: execution.id, status: "FAILED" },
        data: {
          status: "COMPLETED",
          fee: providerStatus.fee ?? execution.fee,
          providerMetadata: (providerStatus.metadata as any) ?? undefined,
          errorMessage: null,
        },
      })
      if (execUpdated.count === 0) {
        throw new ConflictException("Execution state changed during provider recovery")
      }

      await tx.withdrawal.updateMany({
        where: { id: execution.withdrawalId, status: { in: ["FAILED", "PROCESSING"] } },
        data: { status: "COMPLETED", version: { increment: 1 } },
      })

      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: execution.withdrawal.publisherId },
      })
      if (balance) {
        await tx.publisherBalance.updateMany({
          where: { publisherId: execution.withdrawal.publisherId, version: balance.version },
          data: { lifetimePaid: { increment: Number(execution.amount) }, version: { increment: 1 } },
        })
      }

      await this.audit.log({
        action: "PAYOUT_EXECUTION_RECOVERED_COMPLETED",
        entityType: "PayoutExecution",
        entityId: execution.id,
        metadata: {
          withdrawalId: execution.withdrawalId,
          providerExecutionId: execution.providerExecutionId,
          note: "Marked FAILED locally but provider reports COMPLETED — reconciled instead of re-sending",
        },
        userId,
        organizationId: execution.withdrawal.publisher.organizationId,
      }, tx)
    })
  }

  async cancelExecution(executionId: string, userId: string) {
    const execution = await this.prisma.payoutExecution.findUnique({
      where: { id: executionId },
      include: { withdrawal: { include: { publisher: true } }, provider: true },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (!["PENDING", "PROCESSING"].includes(execution.status)) {
      throw new BadRequestException(`Execution ${executionId} is ${execution.status}, cannot cancel`)
    }

    const adapter = this.providerService.getAdapter(execution.provider.name)

    if (execution.providerExecutionId) {
      await adapter.cancelTransfer(execution.providerExecutionId, `payout-cancel-${executionId}`)
    }

    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.payoutExecution.updateMany({
        where: { id: executionId, status: execution.status },
        data: { status: "CANCELLED" },
      })
      if (updated.count === 0) {
        throw new ConflictException("Execution state changed before cancel could complete")
      }
      await tx.withdrawal.updateMany({
        where: { id: execution.withdrawalId, status: "PROCESSING" },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
      await this.audit.log({
        action: "PAYOUT_EXECUTION_CANCELLED",
        entityType: "PayoutExecution",
        entityId: executionId,
        metadata: { withdrawalId: execution.withdrawalId },
        userId,
        organizationId: execution.withdrawal.publisher.organizationId,
      }, tx)
    })
  }

  async getExecutionsForWithdrawal(withdrawalId: string) {
    return this.prisma.payoutExecution.findMany({
      where: { withdrawalId },
      orderBy: { createdAt: "desc" },
      include: { provider: { select: { id: true, name: true, displayName: true } } },
    })
  }

  async getPendingStatusChecks(limit = 50) {
    return this.prisma.payoutExecution.findMany({
      where: { status: "PROCESSING", providerExecutionId: { not: null } },
      take: limit,
      orderBy: { createdAt: "asc" },
      include: {
        withdrawal: { include: { publisher: true } },
        provider: true,
      },
    })
  }
}
