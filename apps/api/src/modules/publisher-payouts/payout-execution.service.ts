import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PrismaService } from "../../common/prisma.service"
import { checkPublisherBalanceInvariant } from "../../common/publisher-balance-invariants"
import { lockPublisherBalanceForUpdate } from "../../common/publisher-balance-lock"
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

  async executeWithdrawal(
    withdrawalId: string,
    providerName: string,
    userId: string,
  ) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { payoutMethod: true, publisher: true },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "APPROVED") {
      throw new BadRequestException(
        `Withdrawal ${withdrawalId} is ${withdrawal.status}, expected APPROVED`,
      )
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
        where: {
          id: withdrawalId,
          status: "APPROVED",
          version: withdrawal.version,
        },
        data: { status: "PROCESSING", version: { increment: 1 } },
      })
      if (transitioned.count === 0) {
        throw new ConflictException("Withdrawal is not in APPROVED state")
      }

      const updatedWithdrawal = await tx.withdrawal.findUnique({
        where: { id: withdrawalId },
      })
      versionSnapshot = updatedWithdrawal.version

      // Lock publisher balance and check for outstanding debt before
      // moving money. This serializes with concurrent refund clawbacks:
      // the lock guarantees no debt appears between our check and commit.
      const payoutBalance = await lockPublisherBalanceForUpdate(
        tx,
        withdrawal.publisherId,
      )
      const currentDebt = new Decimal(payoutBalance?.debtBalance ?? 0)
      if (currentDebt.greaterThan(0)) {
        throw new BadRequestException(
          `Publisher has outstanding debt of ${currentDebt.toFixed(2)} — resolve before executing payout`,
        )
      }

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

      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_STARTED",
          entityType: "PayoutExecution",
          entityId: execution.id,
          metadata: {
            withdrawalId,
            providerName,
            amount: Number(withdrawal.amount),
          },
          userId,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )

      return { execution, versionSnapshot }
    })

    const execResult = result as { execution: any; versionSnapshot: number }
    execution = execResult.execution
    versionSnapshot = execResult.versionSnapshot

    let transferResult: any = null
    try {
      transferResult = await adapter.createTransfer({
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
            status:
              transferResult.status === "COMPLETED"
                ? "COMPLETED"
                : "PROCESSING",
            providerExecutionId: transferResult.providerExecutionId,
            fee: transferResult.fee ?? 0,
            providerMetadata: (transferResult.metadata as any) ?? undefined,
          },
        })

        const withdrawalStatus =
          transferResult.status === "COMPLETED" ? "COMPLETED" : "PROCESSING"
        const updated = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: "PROCESSING" },
          data: { status: withdrawalStatus, version: { increment: 1 } },
        })
        if (updated.count === 0) {
          throw new ConflictException(
            "Withdrawal state changed during payout execution",
          )
        }

        if (transferResult.status === "COMPLETED") {
          const balance = await lockPublisherBalanceForUpdate(
            tx,
            withdrawal.publisherId,
          )
          if (!balance) {
            throw new Error("Publisher balance missing during payout")
          }
          await tx.publisherBalance.update({
            where: { publisherId: withdrawal.publisherId },
            data: {
              lifetimePaid: { increment: Number(withdrawal.amount) },
              version: { increment: 1 },
            },
          })
          checkPublisherBalanceInvariant(
            balance,
            this.logger,
            "executeWithdrawal/completed",
          )
        }

        await this.audit.log(
          {
            action:
              transferResult.status === "COMPLETED"
                ? "PAYOUT_EXECUTION_COMPLETED"
                : "PAYOUT_EXECUTION_SENT",
            entityType: "PayoutExecution",
            entityId: execution.id,
            metadata: {
              withdrawalId,
              providerExecutionId: transferResult.providerExecutionId,
              status: transferResult.status,
            },
            userId,
            organizationId: withdrawal.publisher.organizationId,
          },
          tx,
        )
      })

      return {
        executionId: execution.id,
        status: transferResult.status,
        providerExecutionId: transferResult.providerExecutionId,
      }
    } catch (err: any) {
      // Provider errors can echo the request body (bank details) back in the
      // message — redact before it touches logs, the DB, or the audit trail.
      const safeMessage = this.encryption.redactSensitive(
        String(err.message ?? err),
      )
      this.logger.error(
        `Payout execution failed for withdrawal ${withdrawalId}: ${safeMessage}`,
      )

      // If the provider returned successfully but our local finalization
      // failed, retain its transfer id. Reconciliation can then query provider
      // truth; storing our internal execution id here previously made that
      // recovery path impossible and could make a retry send money twice.
      const providerExecId: string | null =
        transferResult?.providerExecutionId ??
        execution?.providerExecutionId ??
        null

      await this.prisma.$transaction(async (tx: any) => {
        const updateData: any = {
          status: "FAILED",
          errorMessage: safeMessage,
          providerExecutionId: providerExecId ?? undefined,
        }

        await tx.payoutExecution.update({
          where: { id: execution.id },
          data: updateData,
        })
        await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: "PROCESSING" },
          data: { status: "FAILED", version: { increment: 1 } },
        })
        await this.audit.log(
          {
            action: "PAYOUT_EXECUTION_FAILED",
            entityType: "PayoutExecution",
            entityId: execution.id,
            metadata: {
              withdrawalId,
              error: safeMessage,
              providerExecutionId: providerExecId ?? undefined,
            },
            userId,
            organizationId: withdrawal.publisher.organizationId,
          },
          tx,
        )
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
      throw new BadRequestException(
        `Execution ${executionId} is ${execution.status}, expected FAILED`,
      )
    }

    // No provider reference means the original POST may have succeeded but
    // its response was lost. The old retry path advanced the withdrawal
    // version and generated a NEW provider idempotency key, which could create
    // a second real transfer. Fail closed until finance reconciles the
    // original idempotency key in the provider dashboard.
    if (!execution.providerExecutionId) {
      throw new ConflictException(
        "Provider outcome is unconfirmed and no provider transfer reference was recorded. Do not retry: reconcile the original idempotency key with the provider first.",
      )
    }

    // A FAILED execution that already reached the provider may have actually
    // gone through (timeout after send, late webhook marked it failed, etc.).
    // Re-sending would pay the publisher twice — the retry gets a NEW
    // idempotency key because the withdrawal version advances. Ask the
    // provider for the truth before moving money again.
    const adapter = this.providerService.getAdapter(execution.provider.name)
    const providerStatus = await adapter.checkTransferStatus(
      execution.providerExecutionId,
    )
    if (providerStatus.status === "COMPLETED") {
      await this.finalizeCompletedAtProvider(execution, providerStatus, userId)
      return {
        executionId: execution.id,
        status: "COMPLETED",
        providerExecutionId: execution.providerExecutionId,
        recoveredFromProvider: true,
      }
    }
    if (providerStatus.status === "PROCESSING") {
      throw new ConflictException(
        `Provider transfer ${execution.providerExecutionId} is still processing — cannot retry until it settles`,
      )
    }

    if (execution.withdrawal.status !== "FAILED") {
      const r = await this.prisma.withdrawal.updateMany({
        where: {
          id: execution.withdrawalId,
          version: execution.withdrawal.version,
        },
        data: { status: "FAILED", version: { increment: 1 } },
      })
      if (r.count === 0) {
        throw new ConflictException("Withdrawal state changed — cannot retry")
      }
    }

    // Reset withdrawal to APPROVED so executeWithdrawal can transition it
    const reset = await this.prisma.withdrawal.updateMany({
      where: { id: execution.withdrawalId, status: "FAILED" },
      data: { status: "APPROVED", version: { increment: 1 } },
    })
    if (reset.count === 0) {
      throw new ConflictException("Withdrawal state changed — cannot retry")
    }

    return this.executeWithdrawal(
      execution.withdrawalId,
      execution.provider.name,
      userId,
    )
  }

  // The provider says the money already moved: reconcile our records to match
  // instead of sending it again.
  private async finalizeCompletedAtProvider(
    execution: any,
    providerStatus: { fee?: number; metadata?: Record<string, unknown> },
    userId: string,
  ) {
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
        throw new ConflictException(
          "Execution state changed during provider recovery",
        )
      }

      const wUpdated = await tx.withdrawal.updateMany({
        where: {
          id: execution.withdrawalId,
          status: { in: ["FAILED", "PROCESSING"] },
        },
        data: { status: "COMPLETED", version: { increment: 1 } },
      })
      if (wUpdated.count === 0) {
        throw new ConflictException(
          "Withdrawal state changed during provider recovery",
        )
      }

      const balance = await lockPublisherBalanceForUpdate(
        tx,
        execution.withdrawal.publisherId,
      )
      if (!balance) throw new Error("Publisher balance missing during payout")
      await tx.publisherBalance.update({
        where: { publisherId: execution.withdrawal.publisherId },
        data: {
          lifetimePaid: { increment: Number(execution.amount) },
          version: { increment: 1 },
        },
      })

      await this.audit.log(
        {
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
        },
        tx,
      )
    })
  }

  async cancelExecution(executionId: string, userId: string) {
    const execution = await this.prisma.payoutExecution.findUnique({
      where: { id: executionId },
      include: { withdrawal: { include: { publisher: true } }, provider: true },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (!["PENDING", "PROCESSING"].includes(execution.status)) {
      throw new BadRequestException(
        `Execution ${executionId} is ${execution.status}, cannot cancel`,
      )
    }

    // Phase 8.8 — Two-phase commit: claim → provider → finalize.
    // Tx1 locks the row with FOR UPDATE and bumps the version so no
    // concurrent webhook, poller, or admin can overlap. The claimed
    // version is carried through to Tx2 as the finalization guard.
    const claimedVersion = execution.version + 1

    await this.prisma.$transaction(async (tx: any) => {
      const locked = await tx.payoutExecution.findUnique({
        where: { id: executionId },
      })
      if (!locked || !["PENDING", "PROCESSING"].includes(locked.status)) {
        throw new ConflictException(
          `Execution ${executionId} is no longer cancellable`,
        )
      }
      const claimed = await tx.payoutExecution.updateMany({
        where: { id: executionId, version: execution.version },
        data: { version: claimedVersion },
      })
      if (claimed.count === 0) {
        throw new ConflictException(
          "Execution version changed before cancel could claim — lost race",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_CANCEL_REQUESTED",
          entityType: "PayoutExecution",
          entityId: executionId,
          metadata: { withdrawalId: execution.withdrawalId, claimedVersion },
          userId,
          organizationId: execution.withdrawal.publisher.organizationId,
        },
        tx,
      )
    })

    // Provider call — execution is claimed at claimedVersion. Idempotency
    // key protects against Stripe double-reversal on retry.
    const adapter = this.providerService.getAdapter(execution.provider.name)
    if (execution.providerExecutionId) {
      await adapter.cancelTransfer(
        execution.providerExecutionId,
        `payout-cancel-${executionId}`,
      )
    }

    // Tx2 — idempotent finalization. WHERE version = claimedVersion ensures
    // no other caller can race through. Safe to retry on partial failure.
    await this.prisma.$transaction(async (tx: any) => {
      const finalized = await tx.payoutExecution.updateMany({
        where: {
          id: executionId,
          version: claimedVersion,
          status: { not: "CANCELLED" },
        },
        data: { status: "CANCELLED", version: { increment: 1 } },
      })
      if (finalized.count === 0) {
        // Already finalized (e.g. retry after partial Tx2 failure) — carry on
        // so withdrawal update below still runs if it was the part that failed.
        this.logger.warn("cancelExecution Tx2: execution already finalized", {
          executionId,
        })
      }
      const wUpdated = await tx.withdrawal.updateMany({
        where: { id: execution.withdrawalId, status: "PROCESSING" },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
      if (wUpdated.count === 0) {
        // Withdrawal already transitioned — log but don't throw, the execution
        // is still correctly CANCELLED.
        this.logger.warn(
          "cancelExecution Tx2: withdrawal already transitioned",
          {
            withdrawalId: execution.withdrawalId,
          },
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_EXECUTION_CANCELLED",
          entityType: "PayoutExecution",
          entityId: executionId,
          metadata: { withdrawalId: execution.withdrawalId, claimedVersion },
          userId,
          organizationId: execution.withdrawal.publisher.organizationId,
        },
        tx,
      )
    })
  }

  async getExecutionsForWithdrawal(withdrawalId: string) {
    return this.prisma.payoutExecution.findMany({
      where: { withdrawalId },
      orderBy: { createdAt: "desc" },
      include: {
        provider: { select: { id: true, name: true, displayName: true } },
      },
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
