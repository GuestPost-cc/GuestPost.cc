import { publisherPayoutStatementDescriptor } from "@guestpost/shared"
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
      include: {
        payoutMethod: { include: { providerAccount: true } },
        publisher: true,
      },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    if (withdrawal.status !== "APPROVED") {
      throw new BadRequestException(
        `Withdrawal ${withdrawalId} is ${withdrawal.status}, expected APPROVED`,
      )
    }

    const allowedProvidersByMethod: Record<string, string[]> = {
      bank_transfer: ["manual"],
      wise: ["wise"],
      stripe_connect: ["stripe_connect"],
      // No PayPal adapter is active yet. Keeping the route empty fails closed
      // instead of treating an unsupported provider as a manual payout.
      paypal: [],
    }
    if (
      !(allowedProvidersByMethod[withdrawal.method] ?? []).includes(
        providerName,
      )
    ) {
      throw new BadRequestException(
        `Provider ${providerName} is not authorized for ${withdrawal.method} withdrawals`,
      )
    }

    const adapter = this.providerService.getAdapter(providerName)
    const provider = await this.providerService.getActiveProvider(providerName)
    if (
      !adapter.capabilities.supportedCurrencies.includes(withdrawal.currency)
    ) {
      throw new BadRequestException(
        `${providerName} does not support ${withdrawal.currency} payouts`,
      )
    }

    if (withdrawal.payoutMethod && !withdrawal.payoutMethod.isActive) {
      throw new Error("Payout method is no longer active")
    }

    let recipientDetails: Record<string, unknown> = withdrawal.payoutMethod
      ? this.encryption.decrypt(
          withdrawal.payoutMethod.details as unknown as string,
          withdrawal.payoutMethod.encryptionKeyVersion,
        )
      : {}

    if (providerName === "stripe_connect") {
      const account = withdrawal.payoutMethod?.providerAccount
      if (account?.provider !== "stripe_connect") {
        throw new BadRequestException(
          "Withdrawal is not linked to a Stripe connected payout account",
        )
      }
      recipientDetails = {
        connectedAccountId: account.providerAccountId,
        providerAccountStatus: account.status,
        payoutScheduleConfigured: account.payoutScheduleConfigured,
        publicReference: withdrawal.publicReference,
      }
    }

    const recipientValidation =
      await adapter.validateRecipient(recipientDetails)
    if (!recipientValidation.valid) {
      throw new BadRequestException(
        recipientValidation.error ?? "Payout destination is not ready",
      )
    }

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
          sourceCurrency: withdrawal.currency,
          destinationCurrency: withdrawal.currency,
          destinationAmount: withdrawal.netAmount ?? withdrawal.amount,
          requestedReference: withdrawal.publicReference,
          stage: "CREATED",
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
    let transferRecorded = false
    try {
      transferResult = await adapter.createTransfer({
        amount: Number(withdrawal.netAmount ?? withdrawal.amount),
        currency: withdrawal.currency,
        recipientDetails,
        providerConfig: provider.decryptedConfig,
        idempotencyKey: `payout-${withdrawalId}-v${versionSnapshot}`,
        description: `GuestPost publisher payout ${withdrawal.publicReference ?? withdrawal.id}`,
      })

      // Persist provider evidence before starting the next money movement.
      // A crash after Stripe accepted the Transfer can then be resumed without
      // creating a duplicate transfer or falsely returning publisher funds.
      if (providerName === "stripe_connect") {
        const transferEvidence = await this.prisma.payoutExecution.updateMany({
          where: {
            id: execution.id,
            status: "PROCESSING",
            stage: "CREATED",
            version: execution.version,
          },
          data: {
            providerExecutionId: transferResult.providerExecutionId,
            providerTransferId:
              transferResult.providerTransferId ??
              transferResult.providerExecutionId,
            stage: "TRANSFER_CREATED",
            providerMetadata: (transferResult.metadata as any) ?? undefined,
          },
        })
        if (transferEvidence.count === 0) {
          throw new ConflictException(
            "Payout execution changed before the Stripe transfer could be recorded",
          )
        }
        transferRecorded = true

        if (!adapter.createBankPayout) {
          throw new Error("Stripe adapter cannot create a bank payout")
        }
        const connectedAccountId = String(recipientDetails.connectedAccountId)
        const payoutResult = await adapter.createBankPayout({
          amount: Number(withdrawal.netAmount ?? withdrawal.amount),
          currency: withdrawal.currency,
          connectedAccountId,
          idempotencyKey: `payout-bank-${withdrawalId}-v${versionSnapshot}`,
          description: `GuestPost publisher payout ${withdrawal.publicReference ?? withdrawal.id}`,
          statementDescriptor: publisherPayoutStatementDescriptor(
            withdrawal.publicReference ?? withdrawal.id,
          ),
          publicReference: withdrawal.publicReference ?? withdrawal.id,
        })
        const payoutEvidence = await this.prisma.payoutExecution.updateMany({
          where: {
            id: execution.id,
            status: "PROCESSING",
            stage: "TRANSFER_CREATED",
            version: execution.version,
          },
          data: {
            providerExecutionId: payoutResult.providerExecutionId,
            providerPayoutId: payoutResult.providerPayoutId,
            acceptedReference: payoutResult.acceptedReference,
            stage:
              payoutResult.status === "COMPLETED"
                ? "BANK_PAID"
                : payoutResult.status === "FAILED"
                  ? "BANK_PAYOUT_FAILED"
                  : "BANK_PAYOUT_CREATED",
            providerMetadata: (payoutResult.metadata as any) ?? undefined,
          },
        })
        if (payoutEvidence.count === 0) {
          throw new ConflictException(
            "Payout execution changed before the Stripe bank payout could be recorded",
          )
        }
        transferResult = payoutResult
        if (payoutResult.status === "FAILED") {
          throw new Error(
            "Stripe bank payout failed after the connected-balance transfer; finance recovery is required",
          )
        }
      }

      await this.prisma.$transaction(async (tx: any) => {
        const executionUpdated = await tx.payoutExecution.updateMany({
          where: {
            id: execution.id,
            status: "PROCESSING",
            version: execution.version,
          },
          data: {
            status:
              transferResult.status === "COMPLETED"
                ? "COMPLETED"
                : "PROCESSING",
            providerExecutionId: transferResult.providerExecutionId,
            providerTransferId: transferResult.providerTransferId ?? undefined,
            providerPayoutId: transferResult.providerPayoutId ?? undefined,
            acceptedReference: transferResult.acceptedReference ?? undefined,
            stage:
              transferResult.status === "COMPLETED"
                ? "BANK_PAID"
                : providerName === "stripe_connect"
                  ? "BANK_PAYOUT_PENDING"
                  : "PROVIDER_SENT",
            fee: transferResult.fee ?? 0,
            providerMetadata: (transferResult.metadata as any) ?? undefined,
          },
        })
        if (executionUpdated.count === 0) {
          throw new ConflictException(
            "Payout execution changed during provider finalization",
          )
        }

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

      const currentExecution = execution?.id
        ? await this.prisma.payoutExecution.findUnique({
            where: { id: execution.id },
          })
        : null
      if (currentExecution?.status === "COMPLETED") {
        return {
          executionId: currentExecution.id,
          status: "COMPLETED",
          providerExecutionId: currentExecution.providerExecutionId,
          recoveredFromConcurrentFinalization: true,
        }
      }
      if (
        currentExecution?.status === "CANCELLED" ||
        currentExecution?.stage === "CANCEL_REQUESTED"
      ) {
        if (err && typeof err === "object") err.message = safeMessage
        throw err
      }

      await this.prisma.$transaction(async (tx: any) => {
        if (providerName === "stripe_connect" && transferRecorded) {
          const held = await tx.payoutExecution.updateMany({
            where: {
              id: execution.id,
              status: "PROCESSING",
              version: execution.version,
            },
            data: {
              status: "PROCESSING",
              errorMessage: safeMessage,
              stage: transferResult?.providerPayoutId
                ? "BANK_PAYOUT_RECOVERY_REQUIRED"
                : "TRANSFER_RECOVERY_REQUIRED",
            },
          })
          if (held.count === 0) return
          await this.audit.log(
            {
              action: "PAYOUT_EXECUTION_RECOVERY_REQUIRED",
              entityType: "PayoutExecution",
              entityId: execution.id,
              metadata: {
                withdrawalId,
                providerTransferId:
                  transferResult?.providerTransferId ??
                  transferResult?.providerExecutionId,
                providerPayoutId: transferResult?.providerPayoutId,
                error: safeMessage,
              },
              userId,
              organizationId: withdrawal.publisher.organizationId,
            },
            tx,
          )
          return
        }
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
      include: {
        withdrawal: {
          include: {
            publisher: true,
            payoutMethod: { include: { providerAccount: true } },
          },
        },
        provider: true,
      },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (
      execution.provider.name === "stripe_connect" &&
      execution.status === "PROCESSING" &&
      execution.providerTransferId &&
      !execution.providerPayoutId &&
      execution.stage === "TRANSFER_RECOVERY_REQUIRED"
    ) {
      return this.resumeStripeBankPayout(execution, userId)
    }
    if (
      execution.provider.name === "stripe_connect" &&
      execution.status === "PROCESSING" &&
      execution.providerPayoutId
    ) {
      const adapter = this.providerService.getAdapter("stripe_connect")
      const providerStatus = await adapter.checkTransferStatus(
        execution.providerPayoutId,
        {
          connectedAccountId:
            execution.withdrawal.payoutMethod?.providerAccount
              ?.providerAccountId,
          providerTransferId: execution.providerTransferId ?? undefined,
          providerPayoutId: execution.providerPayoutId,
        },
      )
      if (providerStatus.status === "COMPLETED") {
        await this.finalizeCompletedAtProvider(
          execution,
          providerStatus,
          userId,
        )
        return {
          executionId: execution.id,
          status: "COMPLETED",
          providerExecutionId: execution.providerPayoutId,
          recoveredFromProvider: true,
        }
      }
      if (
        providerStatus.status === "FAILED" ||
        providerStatus.status === "CANCELLED"
      ) {
        throw new ConflictException(
          "Stripe bank payout did not settle. Cancel and reverse the recorded transfer before creating another payout.",
        )
      }
      throw new ConflictException(
        `Stripe bank payout ${execution.providerPayoutId} is still processing`,
      )
    }
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
      {
        connectedAccountId:
          execution.withdrawal.payoutMethod?.providerAccount?.providerAccountId,
        providerTransferId: execution.providerTransferId ?? undefined,
        providerPayoutId: execution.providerPayoutId ?? undefined,
      },
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

  private async resumeStripeBankPayout(execution: any, userId: string) {
    const account = execution.withdrawal.payoutMethod?.providerAccount
    if (account?.status !== "ENABLED") {
      throw new ConflictException(
        "Stripe connected account is not enabled; resolve onboarding before recovery",
      )
    }
    const adapter = this.providerService.getAdapter("stripe_connect")
    if (!adapter.createBankPayout) {
      throw new Error("Stripe adapter cannot create a bank payout")
    }
    const withdrawal = execution.withdrawal
    const payout = await adapter.createBankPayout({
      amount: Number(withdrawal.netAmount ?? withdrawal.amount),
      currency: withdrawal.currency,
      connectedAccountId: account.providerAccountId,
      idempotencyKey: `payout-bank-${withdrawal.id}-v${withdrawal.version}`,
      description: `GuestPost publisher payout ${withdrawal.publicReference ?? withdrawal.id}`,
      statementDescriptor: publisherPayoutStatementDescriptor(
        withdrawal.publicReference ?? withdrawal.id,
      ),
      publicReference: withdrawal.publicReference ?? withdrawal.id,
    })

    await this.prisma.$transaction(async (tx: any) => {
      const updated = await tx.payoutExecution.updateMany({
        where: {
          id: execution.id,
          status: "PROCESSING",
          providerTransferId: execution.providerTransferId,
          providerPayoutId: null,
        },
        data: {
          providerExecutionId: payout.providerExecutionId,
          providerPayoutId: payout.providerPayoutId,
          acceptedReference: payout.acceptedReference,
          stage:
            payout.status === "COMPLETED" ? "BANK_PAID" : "BANK_PAYOUT_CREATED",
          providerMetadata: (payout.metadata as any) ?? undefined,
          errorMessage: null,
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException(
          "Payout recovery was completed by another process",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_BANK_STAGE_RESUMED",
          entityType: "PayoutExecution",
          entityId: execution.id,
          metadata: {
            withdrawalId: withdrawal.id,
            providerTransferId: execution.providerTransferId,
            providerPayoutId: payout.providerPayoutId,
          },
          userId,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )
    })
    return {
      executionId: execution.id,
      // The resume transaction only persists provider evidence. Even if Stripe
      // returns `paid` immediately, the normal webhook/poller completion path
      // performs the guarded withdrawal + lifetimePaid transition.
      status: "PROCESSING",
      providerExecutionId: payout.providerExecutionId,
      recoveredBankStage: true,
    }
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
        where: { id: execution.id, status: execution.status },
        data: {
          status: "COMPLETED",
          ...(execution.provider?.name === "stripe_connect"
            ? { stage: "BANK_PAID" }
            : {}),
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
      include: {
        withdrawal: {
          include: {
            publisher: true,
            payoutMethod: { include: { providerAccount: true } },
          },
        },
        provider: true,
      },
    })
    if (!execution) throw new NotFoundException("Payout execution not found")
    if (!["PENDING", "PROCESSING"].includes(execution.status)) {
      throw new BadRequestException(
        `Execution ${executionId} is ${execution.status}, cannot cancel`,
      )
    }
    if (!execution.providerExecutionId) {
      throw new ConflictException(
        "Provider outcome is not yet recorded. Cancellation is blocked until the in-flight send is reconciled.",
      )
    }
    if (
      execution.provider.name === "stripe_connect" &&
      ![
        "TRANSFER_RECOVERY_REQUIRED",
        "BANK_PAYOUT_PENDING",
        "BANK_PAYOUT_RECOVERY_REQUIRED",
        "CANCEL_REQUESTED",
      ].includes(execution.stage)
    ) {
      throw new ConflictException(
        "Stripe payout is between provider stages. Wait for recovery status before cancelling.",
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
        data: { stage: "CANCEL_REQUESTED", version: claimedVersion },
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
        {
          connectedAccountId:
            execution.withdrawal.payoutMethod?.providerAccount
              ?.providerAccountId,
          providerTransferId: execution.providerTransferId ?? undefined,
          providerPayoutId: execution.providerPayoutId ?? undefined,
        },
      )
    }

    // Tx2 — idempotent finalization. WHERE version = claimedVersion ensures
    // no other caller can race through. Safe to retry on partial failure.
    await this.prisma.$transaction(async (tx: any) => {
      const finalized = await tx.payoutExecution.updateMany({
        where: {
          id: executionId,
          version: claimedVersion,
          status: { in: ["PENDING", "PROCESSING"] },
          stage: "CANCEL_REQUESTED",
        },
        data: {
          status: "CANCELLED",
          stage: "CANCELLED_REVERSED",
          version: { increment: 1 },
        },
      })
      if (finalized.count === 0) {
        throw new ConflictException(
          "Execution changed while provider cancellation was in progress",
        )
      }
      const wUpdated = await tx.withdrawal.updateMany({
        where: { id: execution.withdrawalId, status: "PROCESSING" },
        data: { status: "APPROVED", version: { increment: 1 } },
      })
      if (wUpdated.count === 0) {
        throw new ConflictException(
          "Withdrawal changed while provider cancellation was in progress",
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
