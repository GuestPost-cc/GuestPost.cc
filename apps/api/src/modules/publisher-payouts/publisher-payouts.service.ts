import { Prisma, type WithdrawalStatus } from "@guestpost/database"
import {
  getWithdrawalHoldDays,
  isSupportedMoneyCurrency,
  type PublisherTier,
  QUEUES,
  STRIPE_INITIAL_FEE_POLICY_VERSION,
  USD_CURRENCY,
} from "@guestpost/shared"
import { createFinancialReference } from "@guestpost/shared/dist/financial-reference-server"
import { finalizePayoutExecution } from "@guestpost/shared/dist/payout-finalization-core"
import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "@guestpost/shared/dist/prisma-transaction-retry"
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
import { PrismaService } from "../../common/prisma.service"
import { checkPublisherBalanceInvariant } from "../../common/publisher-balance-invariants"
import { isStripeFeatureEnabled } from "../../common/stripe-client"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import type { CompleteManualWithdrawalDto } from "./dto/complete-manual-withdrawal.dto"
import type { CreatePayoutMethodDto } from "./dto/create-payout-method.dto"
import { PayoutEncryptionService } from "./payout-encryption.service"
import { PayoutExecutionService } from "./payout-execution.service"
import { normalizePayoutMethodInput } from "./payout-method-input"

const APPROVAL_BLOCK_REASONS = {
  NOT_PENDING: "Withdrawal is no longer pending",
  APPROVER_INELIGIBLE:
    "Withdrawal approval requires a current unbanned Finance or Super Admin staff member",
  TIER_HOLD_ACTIVE: "Withdrawal tier hold has not elapsed",
  PUBLISHER_BANNED: "Every publisher owner is banned",
  MEMBERSHIP_REVOKED: "Publisher owner membership no longer exists",
  MEMBERSHIP_INELIGIBLE: "No eligible publisher owner remains",
  REQUESTER_PROVENANCE_MISSING:
    "Withdrawal requester provenance is missing and requires finance review",
  REQUESTER_INELIGIBLE:
    "The withdrawal requester is no longer an eligible publisher owner",
  RESERVATION_INVALID:
    "Withdrawal reservation no longer exactly covers the requested amount",
  CURRENCY_INVALID:
    "Withdrawal or its reservation is not denominated in canonical USD",
  PAYOUT_METHOD_INVALID:
    "Payout method is missing, inactive, or does not match the withdrawal",
  ALREADY_EXECUTING: "A payout execution is already in flight",
} as const

type ApprovalBlockReason = keyof typeof APPROVAL_BLOCK_REASONS

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Phase 7.2 — TIER_WITHDRAWAL_HOLDS lifted to packages/shared/src/publisher-tier-policy.ts
// (audit #6 sibling rider). Single source of truth across the platform for
// "what does each publisher tier mean numerically" — see TIER_WITHDRAWAL_HOLD_DAYS
// and TIER_SETTLEMENT_REVIEW_DAYS in that file.

@Injectable()
export class PublisherPayoutsService {
  private readonly logger = new Logger(PublisherPayoutsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly encryption: PayoutEncryptionService,
    readonly _execution: PayoutExecutionService,
  ) {}

  private legacyPayoutMethodsEnabled() {
    return (
      process.env.PAYOUT_LEGACY_METHODS_ENABLED === "true" ||
      process.env.NODE_ENV === "development" ||
      process.env.NODE_ENV === "test"
    )
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 7
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: "Serializable",
        })
      } catch (error: unknown) {
        if (!isRetryablePrismaTransactionError(error)) throw error
        if (attempt === maxAttempts) {
          throw new ConflictException(
            "Financial state changed concurrently. Retry the operation.",
          )
        }
        await sleep(prismaTransactionRetryDelayMs(attempt))
      }
    }
    throw new ConflictException(
      "Financial state changed concurrently. Retry the operation.",
    )
  }

  async getBalance(publisherId: string) {
    const balance = await this.prisma.publisherBalance.findUnique({
      where: { publisherId },
    })
    if (!balance) {
      throw new NotFoundException("Publisher balance is not provisioned")
    }
    if (
      !isSupportedMoneyCurrency((balance as { currency?: unknown }).currency)
    ) {
      throw new ConflictException({
        code: "PUBLISHER_BALANCE_CURRENCY_INVALID",
        message:
          "Publisher balance is not denominated in canonical USD; Finance reconciliation is required",
      })
    }
    return balance
  }

  // ─── PAYOUT METHODS ─────────────────────────────────────────

  private async assertPublisherMember(userId: string, publisherId: string) {
    const membership = await this.prisma.publisherMembership.findFirst({
      where: {
        userId,
        publisherId,
        role: "PUBLISHER_OWNER",
        user: {
          banned: false,
          userType: "PUBLISHER",
        },
      },
      select: { id: true },
    })
    if (!membership)
      throw new ForbiddenException(
        "An active publisher owner account is required",
      )
  }

  async createPayoutMethod(
    publisherId: string,
    userId: string,
    dto: CreatePayoutMethodDto,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    if (!this.legacyPayoutMethodsEnabled()) {
      throw new BadRequestException(
        "Direct payout-method entry is disabled. Connect a verified provider account instead.",
      )
    }
    const input = normalizePayoutMethodInput(dto)

    return this.runSerializable(async (tx) => {
      // Authorization is locked and re-evaluated in the same serializable
      // transaction as the secret write. A concurrent owner revocation, user
      // ban, or publisher deletion must commit either wholly before or after
      // payout-destination creation.
      const ownerRows = await tx.$queryRaw<
        Array<{
          membershipId: string
          role: string
          banned: boolean
          userType: string
          organizationId: string
        }>
      >(Prisma.sql`
        SELECT
          pm."id" AS "membershipId",
          pm."role"::text AS "role",
          u."banned",
          u."userType"::text AS "userType",
          p."organizationId"
        FROM "PublisherMembership" pm
        INNER JOIN "User" u ON u."id" = pm."userId"
        INNER JOIN "Publisher" p ON p."id" = pm."publisherId"
        WHERE pm."publisherId" = ${publisherId}
          AND pm."userId" = ${userId}
        FOR UPDATE OF pm, u, p
      `)
      const owner = ownerRows[0]
      if (
        owner?.role !== "PUBLISHER_OWNER" ||
        owner.banned !== false ||
        owner.userType !== "PUBLISHER"
      ) {
        throw new ForbiddenException(
          "An active publisher owner account is required",
        )
      }

      const { ciphertext, version } = this.encryption.encrypt(input.details)
      const displayDetails = this.encryption.extractDisplayDetails(
        input.details,
        input.type,
      )

      if (input.isDefault) {
        await tx.payoutMethod.updateMany({
          where: { publisherId, isDefault: true },
          data: { isDefault: false },
        })
      }
      const method = await tx.payoutMethod.create({
        data: {
          publisherId,
          type: input.type,
          label: input.label,
          details: ciphertext as any,
          displayDetails: displayDetails as any,
          encryptionKeyVersion: version,
          isDefault: input.isDefault,
        },
      })
      await this.audit.log(
        {
          action: "PAYOUT_METHOD_CREATED",
          entityType: "PayoutMethod",
          entityId: method.id,
          metadata: {
            publisherId,
            type: input.type,
            label: input.label,
          },
          userId,
          organizationId: owner.organizationId,
        },
        tx,
      )
      return {
        id: method.id,
        type: method.type,
        label: method.label,
        isDefault: method.isDefault,
        isActive: method.isActive,
        displayDetails,
      }
    })
  }

  async listPayoutMethods(
    publisherId: string,
    userId: string,
    includeInactive = false,
  ) {
    await this.assertPublisherMember(userId, publisherId)
    const methods = await this.prisma.payoutMethod.findMany({
      where: { publisherId, ...(includeInactive ? {} : { isActive: true }) },
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
      isActive: m.isActive,
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
    assertApiFinanceOperationAllowed("operator_decision")
    const normalizedReason = reason.trim()
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new BadRequestException(
        "A decrypt reason between 10 and 500 characters is required",
      )
    }
    const normalizedIpAddress = ipAddress.trim().slice(0, 128) || "unknown"
    const normalizedUserAgent = userAgent.trim().slice(0, 512) || "unknown"

    return this.runSerializable(async (tx) => {
      // Lock both authorization rows before reading their current values. A
      // concurrent ban, role downgrade, or permission revocation therefore
      // completes either wholly before or wholly after this audited decrypt.
      const staffRows = await tx.$queryRaw<
        Array<{
          role: string
          permissions: unknown
          banned: boolean
          userType: string
        }>
      >(Prisma.sql`
        SELECT sm."role", sm."permissions", u."banned", u."userType"::text AS "userType"
        FROM "StaffMembership" sm
        INNER JOIN "User" u ON u."id" = sm."userId"
        WHERE sm."userId" = ${userId}
        FOR UPDATE OF sm, u
      `)
      const staff = staffRows[0]
      const permissions = Array.isArray(staff?.permissions)
        ? staff.permissions.filter(
            (permission): permission is string =>
              typeof permission === "string",
          )
        : []
      if (
        !staff ||
        staff.banned ||
        staff.userType !== "STAFF" ||
        (staff.role !== "SUPER_ADMIN" && staff.role !== "FINANCE") ||
        !permissions.includes("FINANCIAL_DATA_DECRYPT")
      ) {
        throw new ForbiddenException(
          "Current finance authorization is required to decrypt payout data",
        )
      }

      const lockedMethod = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "PayoutMethod"
        WHERE "id" = ${methodId}
        FOR UPDATE
      `)
      if (lockedMethod.length === 0) {
        throw new NotFoundException("Payout method not found")
      }
      const method = await tx.payoutMethod.findUnique({
        where: { id: methodId },
        include: { publisher: { select: { organizationId: true } } },
      })
      if (!method) throw new NotFoundException("Payout method not found")

      const details = this.encryption.decrypt(
        method.details as unknown as string,
        method.encryptionKeyVersion,
      )

      await this.audit.log(
        {
          action: "PAYOUT_METHOD_DECRYPTED",
          entityType: "PayoutMethod",
          entityId: methodId,
          metadata: {
            publisherId: method.publisherId,
            reason: normalizedReason,
            ipAddress: normalizedIpAddress,
            userAgent: normalizedUserAgent,
          },
          ipAddress: normalizedIpAddress,
          userAgent: normalizedUserAgent,
          userId,
          organizationId: method.publisher?.organizationId ?? null,
        },
        tx,
      )

      return { details, methodId, publisherId: method.publisherId }
    })
  }

  async deactivatePayoutMethod(
    publisherId: string,
    userId: string,
    id: string,
  ) {
    assertApiFinanceOperationAllowed("operator_decision")
    return this.runSerializable(async (tx: any) => {
      const currentOwner = await tx.publisherMembership.findFirst({
        where: {
          userId,
          publisherId,
          role: "PUBLISHER_OWNER",
          user: { banned: false, userType: "PUBLISHER" },
        },
        select: { id: true },
      })
      if (!currentOwner) {
        throw new ForbiddenException(
          "An active publisher owner account is required",
        )
      }

      // This operation takes only the PayoutMethod row lock. Withdrawal
      // lifecycle triggers update the method's liability counter after holding
      // their Withdrawal row, so deactivation never waits on a Withdrawal and
      // cannot invert the global Withdrawal -> PayoutMethod lock order.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutMethod" WHERE "id" = $1 AND "publisherId" = $2 FOR UPDATE',
        id,
        publisherId,
      )
      const method = await tx.payoutMethod.findFirst({
        where: { id, publisherId },
        include: { publisher: { select: { organizationId: true } } },
      })
      if (!method) throw new NotFoundException("Payout method not found")
      if (!method.isActive) {
        await this.audit.log(
          {
            action: "PAYOUT_METHOD_DEACTIVATION_REPLAYED",
            entityType: "PayoutMethod",
            entityId: id,
            metadata: { publisherId, version: method.version },
            userId,
            organizationId: method.publisher.organizationId,
          },
          tx,
        )
        return { id, isActive: false, replayed: true }
      }
      if (method.nonterminalWithdrawalCount !== 0) {
        throw new ConflictException({
          code: "PAYOUT_METHOD_HAS_RESERVED_WITHDRAWALS",
          message:
            "Payout method cannot be deactivated while reserved withdrawals remain nonterminal",
        })
      }

      const deactivated = await tx.payoutMethod.updateMany({
        where: {
          id,
          publisherId,
          isActive: true,
          version: method.version,
          nonterminalWithdrawalCount: 0,
        },
        data: {
          isActive: false,
          isDefault: false,
          version: { increment: 1 },
        },
      })
      if (deactivated.count !== 1) {
        throw new ConflictException(
          "Payout method liability changed concurrently; review and retry",
        )
      }
      await this.audit.log(
        {
          action: "PAYOUT_METHOD_DEACTIVATED",
          entityType: "PayoutMethod",
          entityId: id,
          metadata: { publisherId },
          userId,
          organizationId: method.publisher.organizationId,
        },
        tx,
      )
      return { id, isActive: false, replayed: false }
    })
  }

  async reactivatePayoutMethod(
    publisherId: string,
    userId: string,
    id: string,
  ) {
    assertApiFinanceOperationAllowed("new_liability")
    return this.runSerializable(async (tx: any) => {
      const currentOwner = await tx.publisherMembership.findFirst({
        where: {
          userId,
          publisherId,
          role: "PUBLISHER_OWNER",
          user: { banned: false, userType: "PUBLISHER" },
        },
        select: { id: true },
      })
      if (!currentOwner) {
        throw new ForbiddenException(
          "An active publisher owner account is required",
        )
      }

      const observed = await tx.payoutMethod.findFirst({
        where: { id, publisherId },
        select: {
          id: true,
          type: true,
          providerAccountId: true,
          version: true,
        },
      })
      if (!observed) throw new NotFoundException("Payout method not found")

      const managed =
        observed.type === "stripe_connect" ||
        observed.providerAccountId !== null
      if (
        managed &&
        (observed.type !== "stripe_connect" || !observed.providerAccountId)
      ) {
        throw new ConflictException({
          code: "PAYOUT_METHOD_PROVIDER_BINDING_INVALID",
          message:
            "Managed payout method is not bound to a canonical Stripe account",
        })
      }

      // Provider sync owns PublisherProviderAccount before it inspects the
      // managed method. Match that order here: observe the immutable binding,
      // lock/re-read the account first, then lock/re-read the method and verify
      // that the observed identity/version did not change.
      let account: any = null
      if (observed.providerAccountId) {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PublisherProviderAccount" WHERE "id" = $1 FOR SHARE',
          observed.providerAccountId,
        )
        account = await tx.publisherProviderAccount.findUnique({
          where: { id: observed.providerAccountId },
        })
      }
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutMethod" WHERE "id" = $1 AND "publisherId" = $2 FOR UPDATE',
        id,
        publisherId,
      )
      const method = await tx.payoutMethod.findFirst({
        where: { id, publisherId },
        include: { publisher: { select: { organizationId: true } } },
      })
      if (!method) throw new NotFoundException("Payout method not found")
      if (
        method.version !== observed.version ||
        method.type !== observed.type ||
        method.providerAccountId !== observed.providerAccountId
      ) {
        throw new ConflictException({
          code: "PAYOUT_METHOD_REACTIVATION_RACE",
          message:
            "Payout method changed concurrently; refresh before reactivating",
        })
      }
      if (method.isActive) {
        await this.audit.log(
          {
            action: "PAYOUT_METHOD_REACTIVATION_REPLAYED",
            entityType: "PayoutMethod",
            entityId: id,
            metadata: { publisherId, version: method.version },
            userId,
            organizationId: method.publisher.organizationId,
          },
          tx,
        )
        return { id, isActive: true, replayed: true }
      }
      if (method.nonterminalWithdrawalCount !== 0) {
        throw new ConflictException({
          code: "PAYOUT_METHOD_LIABILITY_INCONSISTENT",
          message:
            "Inactive payout method has reserved withdrawal liability and cannot be reactivated",
        })
      }

      if (managed) {
        const ready =
          account?.publisherId === publisherId &&
          account.provider === "stripe_connect" &&
          account.isActive === true &&
          account.status === "ENABLED" &&
          account.transfersEnabled === true &&
          account.payoutsEnabled === true &&
          account.detailsSubmitted === true &&
          account.payoutScheduleConfigured === true &&
          account.defaultCurrency === USD_CURRENCY
        if (!ready) {
          throw new ConflictException({
            code: "PAYOUT_METHOD_PROVIDER_NOT_READY",
            message:
              "Stripe payout account must be fully enabled and manually scheduled before reactivation",
          })
        }
      } else if (!this.legacyPayoutMethodsEnabled()) {
        throw new BadRequestException(
          "Legacy payout methods cannot be reactivated during the Stripe rollout",
        )
      }

      const reactivated = await tx.payoutMethod.updateMany({
        where: {
          id,
          publisherId,
          isActive: false,
          version: method.version,
          nonterminalWithdrawalCount: 0,
        },
        data: {
          isActive: true,
          version: { increment: 1 },
        },
      })
      if (reactivated.count !== 1) {
        throw new ConflictException({
          code: "PAYOUT_METHOD_REACTIVATION_RACE",
          message:
            "Payout method changed concurrently; refresh before reactivating",
        })
      }
      await this.audit.log(
        {
          action: "PAYOUT_METHOD_REACTIVATED",
          entityType: "PayoutMethod",
          entityId: id,
          metadata: {
            publisherId,
            type: method.type,
            providerAccountId: method.providerAccountId,
            previousVersion: method.version,
            version: method.version + 1,
          },
          userId,
          organizationId: method.publisher.organizationId,
        },
        tx,
      )
      return { id, isActive: true, replayed: false }
    })
  }

  // ─── WITHDRAWALS ────────────────────────────────────────────

  private async allocateWithdrawalSources(
    tx: any,
    withdrawalId: string,
    publisherId: string,
    amount: Decimal,
    balance: any,
  ): Promise<Decimal> {
    let remaining = new Decimal(amount)
    let sequence = 0
    let carryUsed = new Decimal(0)
    const carryAvailable = new Decimal(
      balance.allocationCarryForward ?? balance.withdrawableBalance ?? 0,
    ).minus(new Decimal(balance.allocationCarryForwardUsed ?? 0))

    if (carryAvailable.greaterThan(0)) {
      carryUsed = Decimal.min(carryAvailable, remaining)
      if (carryUsed.greaterThan(0)) {
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId,
            sourceType: "CARRY_FORWARD",
            amount: carryUsed,
            currency: USD_CURRENCY,
            sequence: sequence++,
          },
        })
        remaining = remaining.minus(carryUsed)
      }
    }

    if (remaining.greaterThan(0)) {
      const transactions = await tx.transaction.findMany({
        where: {
          publisherId,
          settlementId: { not: null },
          type: { in: ["SETTLEMENT_RELEASE", "DEBT_REPAYMENT"] },
          ...(balance.allocationCutoverAt
            ? { createdAt: { gte: balance.allocationCutoverAt } }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          settlement: { select: { serviceType: true, orderId: true } },
          withdrawalAllocations: {
            where: { releasedAt: null },
            select: { amount: true },
          },
        },
      })
      if (
        transactions.some((row: any) => !isSupportedMoneyCurrency(row.currency))
      ) {
        throw new ConflictException({
          code: "WITHDRAWAL_SOURCE_CURRENCY_INVALID",
          message:
            "Publisher liability contains a non-USD source; Finance reconciliation is required",
        })
      }
      const debtBySettlement = new Map<string, Decimal>()
      for (const row of transactions) {
        if (row.type !== "DEBT_REPAYMENT" || !row.settlementId) continue
        debtBySettlement.set(
          row.settlementId,
          (debtBySettlement.get(row.settlementId) ?? new Decimal(0)).plus(
            row.amount,
          ),
        )
      }
      for (const row of transactions) {
        if (remaining.lessThanOrEqualTo(0)) break
        if (row.type !== "SETTLEMENT_RELEASE" || !row.settlementId) continue
        const allocated = row.withdrawalAllocations.reduce(
          (sum: Decimal, item: any) => sum.plus(item.amount),
          new Decimal(0),
        )
        const sourceAvailable = new Decimal(row.amount)
          .plus(debtBySettlement.get(row.settlementId) ?? 0)
          .minus(allocated)
        if (sourceAvailable.lessThanOrEqualTo(0)) continue
        const use = Decimal.min(sourceAvailable, remaining)
        await tx.withdrawalAllocation.create({
          data: {
            withdrawalId,
            sourceType: "SETTLEMENT_RELEASE",
            sourceTransactionId: row.id,
            settlementId: row.settlementId,
            orderId: row.settlement?.orderId ?? row.orderId,
            amount: use,
            currency: USD_CURRENCY,
            sequence: sequence++,
            serviceType: row.settlement?.serviceType ?? null,
          },
        })
        remaining = remaining.minus(use)
      }
    }

    if (remaining.greaterThan(0)) {
      throw new ConflictException(
        "Withdrawal source allocation does not match the publisher balance. Finance reconciliation is required.",
      )
    }
    return carryUsed
  }

  private async releaseWithdrawalSources(
    tx: any,
    withdrawalId: string,
    expectedAmount: Decimal,
    expectedCurrency: string,
  ) {
    if (!isSupportedMoneyCurrency(expectedCurrency)) {
      throw new ConflictException({
        code: "WITHDRAWAL_CURRENCY_INVALID",
        message: "Withdrawal is not denominated in canonical USD",
      })
    }
    const active = await tx.withdrawalAllocation.findMany({
      where: { withdrawalId, releasedAt: null },
      select: {
        id: true,
        sourceType: true,
        amount: true,
        currency: true,
      },
    })
    const total = active.reduce(
      (sum: Decimal, item: any) => sum.plus(item.amount),
      new Decimal(0),
    )
    if (
      active.length === 0 ||
      !total.equals(expectedAmount) ||
      active.some(
        (item: any) =>
          new Decimal(item.amount).lessThanOrEqualTo(0) ||
          item.currency !== USD_CURRENCY,
      )
    ) {
      throw new ConflictException(
        "Withdrawal allocations do not exactly cover the reserved amount",
      )
    }
    const carry = active
      .filter((item: any) => item.sourceType === "CARRY_FORWARD")
      .reduce(
        (sum: Decimal, item: any) => sum.plus(item.amount),
        new Decimal(0),
      )
    const released = await tx.withdrawalAllocation.updateMany({
      where: {
        id: { in: active.map((item: any) => item.id) },
        releasedAt: null,
      },
      data: { releasedAt: new Date() },
    })
    if (released.count !== active.length) {
      throw new ConflictException(
        "Withdrawal allocation release lost a concurrent race",
      )
    }
    return carry
  }

  private assertMatchingWithdrawalRequest(
    existing: any,
    amount: Decimal,
    method: string,
    payoutMethodId: string,
    requestedBy: string,
  ) {
    if (
      !new Decimal(existing.amount).equals(amount) ||
      existing.method !== method ||
      (existing.payoutMethodId ?? null) !== (payoutMethodId ?? null) ||
      !isSupportedMoneyCurrency(existing.currency) ||
      existing.requestedBy !== requestedBy
    ) {
      throw new ConflictException(
        "This withdrawal request key was already used for different payout details",
      )
    }
  }

  async requestWithdrawal(
    publisherId: string,
    amount: number,
    method: string,
    userId: string,
    idempotencyKey: string,
    payoutMethodId: string,
  ) {
    await this.assertPublisherMember(userId, publisherId)
    if (
      !idempotencyKey ||
      idempotencyKey.length > 191 ||
      !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)
    ) {
      throw new BadRequestException(
        "A valid withdrawal idempotency key is required",
      )
    }

    const amountDecimal = new Decimal(amount)
    if (
      !Number.isFinite(amount) ||
      !amountDecimal.isFinite() ||
      amountDecimal.lessThan(1) ||
      amountDecimal.greaterThan(1_000_000) ||
      !amountDecimal.mul(100).isInteger()
    ) {
      throw new BadRequestException(
        "Withdrawal amount must be between 1 and 1,000,000 with no more than two decimal places",
      )
    }
    if (!["bank_transfer", "wise", "stripe_connect"].includes(method)) {
      throw new BadRequestException("Unsupported payout method")
    }

    if (!payoutMethodId) {
      throw new BadRequestException(
        "Select an active payout method before requesting a withdrawal",
      )
    }

    // An acknowledged retry is a read of an already-committed command, not a
    // new liability. Resolve it before mutable rollout, provider-account, and
    // runtime-mode gates so a lost response remains replayable even when those
    // controls change after the original reservation committed.
    const committed = await this.prisma.withdrawal.findFirst({
      where: { publisherId, idempotencyKey },
    })
    if (committed) {
      this.assertMatchingWithdrawalRequest(
        committed,
        amountDecimal,
        method,
        payoutMethodId,
        userId,
      )
      return committed
    }

    assertApiFinanceOperationAllowed("new_liability")

    const publicReference = createFinancialReference("WD")
    try {
      return await this.runSerializable(async (tx) => {
        // Idempotency: scoped per publisher via @@unique([publisherId, idempotencyKey]).
        // Never used as the row's PK — a colliding client key must not be able
        // to address another publisher's withdrawal.
        const existing = await tx.withdrawal.findFirst({
          where: { publisherId, idempotencyKey },
        })
        if (existing) {
          this.assertMatchingWithdrawalRequest(
            existing,
            amountDecimal,
            method,
            payoutMethodId,
            userId,
          )
          return existing
        }

        // Read the tier and hold policy in the same Serializable transaction as
        // the balance reservation. A concurrent tier change must therefore
        // serialize before or after this request instead of producing a payout
        // whose reservation and approval window came from different snapshots.
        const currentPublisher = await tx.publisher.findUnique({
          where: { id: publisherId },
          select: {
            tier: true,
            organizationId: true,
          },
        })
        if (!currentPublisher) {
          throw new NotFoundException("Publisher not found")
        }
        // Values: NEW=30d / TRUSTED=14d / VERIFIED=7d. The environment
        // override is an incident-response control and is sampled atomically
        // with the persisted publisher tier for this reservation.
        const holdDays = getWithdrawalHoldDays(
          (currentPublisher.tier ?? "NEW") as PublisherTier,
          process.env.WITHDRAWAL_HOLD_DAYS,
        )
        const availableAt = new Date(
          Date.now() + holdDays * 24 * 60 * 60 * 1000,
        )

        const currentRequester = await tx.publisherMembership.findFirst({
          where: {
            userId,
            publisherId,
            role: "PUBLISHER_OWNER",
            user: {
              banned: false,
              userType: "PUBLISHER",
            },
          },
          select: { id: true },
        })
        if (!currentRequester) {
          throw new ForbiddenException(
            "Publisher owner eligibility changed; review and retry",
          )
        }

        const currentPayoutMethod = await tx.payoutMethod.findFirst({
          where: {
            id: payoutMethodId,
            publisherId,
            isActive: true,
            type: method,
          },
          include: { providerAccount: true },
        })
        if (!currentPayoutMethod) {
          throw new BadRequestException(
            "Payout method changed or became inactive; review and retry",
          )
        }
        if (
          !this.legacyPayoutMethodsEnabled() &&
          currentPayoutMethod.type !== "stripe_connect"
        ) {
          throw new BadRequestException(
            "This payout method is not available during the Stripe rollout",
          )
        }
        if (
          currentPayoutMethod.type === "stripe_connect" &&
          (currentPayoutMethod.providerAccount?.publisherId !== publisherId ||
            currentPayoutMethod.providerAccount.provider !== "stripe_connect" ||
            currentPayoutMethod.providerAccount.isActive !== true ||
            currentPayoutMethod.providerAccount.status !== "ENABLED" ||
            currentPayoutMethod.providerAccount.transfersEnabled !== true ||
            currentPayoutMethod.providerAccount.payoutsEnabled !== true ||
            currentPayoutMethod.providerAccount.detailsSubmitted !== true ||
            currentPayoutMethod.providerAccount.payoutScheduleConfigured !==
              true ||
            currentPayoutMethod.providerAccount.defaultCurrency !==
              USD_CURRENCY)
        ) {
          throw new BadRequestException(
            "Stripe payout account is not fully enabled or manually scheduled",
          )
        }
        if (
          isStripeFeatureEnabled("connect") &&
          currentPayoutMethod.type !== "stripe_connect"
        ) {
          throw new BadRequestException(
            "Select a verified Stripe payout method before requesting a withdrawal",
          )
        }

        const balance = await tx.publisherBalance.findUnique({
          where: { publisherId },
        })
        if (!balance) throw new NotFoundException("Publisher balance not found")
        if (
          !isSupportedMoneyCurrency(
            (balance as { currency?: unknown }).currency,
          )
        ) {
          throw new ConflictException({
            code: "PUBLISHER_BALANCE_CURRENCY_INVALID",
            message:
              "Publisher balance is not denominated in canonical USD; Finance reconciliation is required",
          })
        }

        const withdrawable = new Decimal(balance.withdrawableBalance)
        if (withdrawable.lessThan(amountDecimal)) {
          throw new BadRequestException(
            `Insufficient withdrawable balance. Available: ${withdrawable}, requested: ${amount}`,
          )
        }

        // Debt gate: outstanding clawback debt must be repaid through settlement
        // before the publisher may withdraw. This prevents money extraction
        // after a refund clawback created a debtBalance.
        const debt = new Decimal(balance.debtBalance ?? 0)
        if (debt.greaterThan(0)) {
          throw new BadRequestException(
            `Cannot withdraw while outstanding debt of ${debt.toFixed(2)} exists. Repay through future settlements.`,
          )
        }

        // PostgreSQL aborts the transaction after a unique violation. P2002
        // recovery therefore happens only after this callback has rolled back.
        const created = await tx.withdrawal.create({
          data: {
            publisherId,
            amount: amountDecimal,
            currency: USD_CURRENCY,
            publicReference,
            payoutFee: 0,
            netAmount: amount,
            feePolicyVersion: STRIPE_INITIAL_FEE_POLICY_VERSION,
            method,
            status: "PENDING",
            availableAt,
            idempotencyKey: idempotencyKey ?? null,
            payoutMethodId: payoutMethodId ?? null,
            requestedBy: userId,
          },
        })

        const carryUsed = await this.allocateWithdrawalSources(
          tx,
          created.id,
          publisherId,
          amountDecimal,
          balance,
        )

        const updated = await tx.publisherBalance.updateMany({
          where: { publisherId, version: balance.version },
          data: {
            withdrawableBalance: { decrement: amountDecimal },
            allocationCarryForwardUsed: { increment: carryUsed },
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
            withdrawableBalance: new Decimal(balance.withdrawableBalance).minus(
              amountDecimal,
            ),
          },
          this.logger,
          "requestWithdrawal",
        )

        // Ledger row at REQUEST time — this is when the balance moves. A
        // rejection writes the offsetting WITHDRAWAL_REVERSAL.
        await tx.transaction.create({
          data: {
            amount: amountDecimal.negated(),
            type: "WITHDRAWAL",
            currency: USD_CURRENCY,
            publisherId,
            reference: `withdrawal-${created.id}`,
            description: `Withdrawal ${created.publicReference} of ${amount} USD via ${method}`,
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
              publicReference: created.publicReference,
              payoutFee: 0,
              netAmount: amount,
              feePolicyVersion: STRIPE_INITIAL_FEE_POLICY_VERSION,
              holdDays,
              availableAt: availableAt.toISOString(),
            },
            userId,
            organizationId: currentPublisher.organizationId,
          },
          tx,
        )

        return created
      })
    } catch (error: unknown) {
      if (!isPrismaUniqueConstraintError(error)) throw error

      // Resolve a concurrent winner with the top-level client, outside the
      // aborted PostgreSQL transaction, then verify immutable request fields.
      const existing = await this.prisma.withdrawal.findFirst({
        where: { publisherId, idempotencyKey },
      })
      if (!existing) throw error
      this.assertMatchingWithdrawalRequest(
        existing,
        amountDecimal,
        method,
        payoutMethodId,
        userId,
      )
      return existing
    }
  }

  async approveWithdrawal(id: string, approvedBy: string) {
    assertApiFinanceOperationAllowed("operator_decision")
    const result = await this.runSerializable(async (tx) => {
      // Allocation INSERT/UPDATE triggers acquire this same parent lock before
      // accepting child evidence. Lock before the approval snapshot so the
      // reservation read cannot race a late allocation commit.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        id,
      )
      const w = await tx.withdrawal.findUnique({
        where: { id },
        select: {
          id: true,
          publisherId: true,
          amount: true,
          currency: true,
          method: true,
          status: true,
          version: true,
          availableAt: true,
          payoutMethodId: true,
          requestedBy: true,
          publisher: {
            select: {
              organizationId: true,
            },
          },
        },
      })
      if (!w) throw new NotFoundException("Withdrawal not found")

      // Return a blocked result instead of throwing inside the transaction.
      // The audit row must commit before the caller receives the rejection.
      const block = async (reason: ApprovalBlockReason) => {
        const message = APPROVAL_BLOCK_REASONS[reason]
        await this.audit.log(
          {
            action: "WITHDRAWAL_APPROVAL_BLOCKED",
            entityType: "Withdrawal",
            entityId: id,
            metadata: {
              withdrawalId: id,
              publisherId: w.publisherId,
              reason,
              message,
              amount: Number(w.amount),
            },
            userId: approvedBy,
            organizationId: w.publisher.organizationId,
          },
          tx,
        )
        return { kind: "blocked" as const, reason, message }
      }

      if (w.status !== "PENDING") {
        return block("NOT_PENDING")
      }
      if (!isSupportedMoneyCurrency(w.currency)) {
        return block("CURRENCY_INVALID")
      }
      const eligibleApprover = await tx.staffMembership.findFirst({
        where: {
          userId: approvedBy,
          role: { in: ["FINANCE", "SUPER_ADMIN"] },
          user: { userType: "STAFF", banned: false },
        },
        select: { id: true },
      })
      if (!eligibleApprover) {
        return block("APPROVER_INELIGIBLE")
      }
      if (w.availableAt && w.availableAt.getTime() > Date.now()) {
        return block("TIER_HOLD_ACTIVE")
      }

      // Publisher has no account-level banned field. Eligibility belongs to
      // real owner memberships and their linked User rows.
      const ownerMemberships = await tx.publisherMembership.findMany({
        where: {
          publisherId: w.publisherId,
          role: "PUBLISHER_OWNER",
        },
        select: {
          id: true,
          userId: true,
          user: { select: { banned: true, userType: true } },
        },
      })
      if (ownerMemberships.length === 0) {
        return block("MEMBERSHIP_REVOKED")
      }
      if (ownerMemberships.every((membership) => membership.user.banned)) {
        return block("PUBLISHER_BANNED")
      }
      if (
        !ownerMemberships.some(
          (membership) =>
            !membership.user.banned && membership.user.userType === "PUBLISHER",
        )
      ) {
        return block("MEMBERSHIP_INELIGIBLE")
      }
      if (!w.requestedBy) {
        return block("REQUESTER_PROVENANCE_MISSING")
      }
      if (
        !ownerMemberships.some(
          (membership) =>
            membership.userId === w.requestedBy &&
            !membership.user.banned &&
            membership.user.userType === "PUBLISHER",
        )
      ) {
        return block("REQUESTER_INELIGIBLE")
      }

      // The balance was reserved at request time. Approval proves the durable,
      // unreleased allocation still covers the withdrawal exactly; checking
      // available balance again would reject a valid full-balance withdrawal.
      const allocations = await tx.withdrawalAllocation.findMany({
        where: { withdrawalId: id },
        select: {
          amount: true,
          currency: true,
          releasedAt: true,
        },
      })
      const allocatedAmount = allocations.reduce(
        (sum, allocation) => sum.plus(allocation.amount),
        new Decimal(0),
      )
      const reservationValid =
        allocations.length > 0 &&
        allocations.every(
          (allocation) =>
            allocation.releasedAt === null &&
            new Decimal(allocation.amount).greaterThan(0) &&
            allocation.currency === USD_CURRENCY,
        ) &&
        allocatedAmount.equals(new Decimal(w.amount))
      if (!reservationValid) {
        return block("RESERVATION_INVALID")
      }

      const method = w.payoutMethodId
        ? await tx.payoutMethod.findFirst({
            where: {
              id: w.payoutMethodId,
              publisherId: w.publisherId,
              isActive: true,
              type: w.method,
            },
            include: { providerAccount: true },
          })
        : null
      const stripeAccount = method?.providerAccount
      const stripeMethodValid =
        method?.type === "stripe_connect" &&
        stripeAccount?.provider === "stripe_connect" &&
        stripeAccount.publisherId === w.publisherId &&
        stripeAccount.isActive &&
        stripeAccount.status === "ENABLED" &&
        stripeAccount.transfersEnabled &&
        stripeAccount.payoutsEnabled &&
        stripeAccount.detailsSubmitted &&
        stripeAccount.payoutScheduleConfigured &&
        stripeAccount.defaultCurrency === USD_CURRENCY
      const legacyMethodValid =
        Boolean(method) &&
        method?.type !== "stripe_connect" &&
        this.legacyPayoutMethodsEnabled()
      if (!method || (!stripeMethodValid && !legacyMethodValid)) {
        return block("PAYOUT_METHOD_INVALID")
      }

      const executionCount = await tx.payoutExecution.count({
        where: { withdrawalId: id },
      })
      if (executionCount > 0) {
        return block("ALREADY_EXECUTING")
      }

      const transitioned = await tx.withdrawal.updateMany({
        where: { id, status: "PENDING", version: w.version },
        data: {
          status: "APPROVED",
          approvedBy,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      })
      if (transitioned.count === 0) {
        return block("NOT_PENDING")
      }
      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id },
        include: { publisher: { select: { organizationId: true } } },
      })

      await this.audit.log(
        {
          action: "WITHDRAWAL_APPROVED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: w.publisherId,
            amount: Number(w.amount),
          },
          userId: approvedBy,
          organizationId: w.publisher.organizationId,
        },
        tx,
      )

      return {
        kind: "approved" as const,
        updated,
        publisherId: w.publisherId,
        organizationId: w.publisher.organizationId,
        amount: w.amount,
      }
    })

    if (result.kind === "blocked") {
      throw new BadRequestException({
        code: result.reason,
        message: result.message,
      })
    }

    await this.notifyPublisherMembers(
      result.publisherId,
      result.organizationId,
      "WITHDRAWAL_APPROVED",
      `Withdrawal of ${result.amount} has been approved.`,
    )

    return result.updated
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
      this.queue
        .addJob(QUEUES.NOTIFICATION, "push-in-app", {
          userId: m.userId,
          organizationId,
          type,
          message,
        })
        .catch(() => {})
    }
  }

  async completeManualWithdrawal(
    id: string,
    completedBy: string,
    dto: CompleteManualWithdrawalDto,
  ) {
    assertApiFinanceOperationAllowed("manual_completion")
    const withdrawalPublicReference = dto.withdrawalPublicReference
    const executionId = dto.executionId?.trim()
    const bankReference = dto.bankReference
      ?.trim()
      .replace(/\s+/g, " ")
      .toUpperCase()
    const reason = dto.reason?.trim()
    const paidAt = new Date(dto.paidAt)
    if (
      typeof withdrawalPublicReference !== "string" ||
      withdrawalPublicReference.length < 1 ||
      withdrawalPublicReference.length > 191 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(withdrawalPublicReference) ||
      !executionId ||
      !/^[A-Za-z0-9_-]+$/.test(executionId) ||
      !bankReference ||
      bankReference.length < 6 ||
      bankReference.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/.test(bankReference) ||
      !reason ||
      reason.length < 10 ||
      reason.length > 2000 ||
      !Number.isFinite(paidAt.getTime())
    ) {
      throw new BadRequestException("Valid manual payout evidence is required")
    }
    if (paidAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException(
        "Manual payout paidAt cannot be in the future",
      )
    }

    const result = await finalizePayoutExecution(this.prisma, {
      source: "MANUAL_BANK_CONFIRMATION",
      withdrawalPublicReference,
      executionId,
      withdrawalId: id,
      providerName: "manual",
      providerReference: bankReference,
      evidenceAt: paidAt,
      actorUserId: completedBy,
      reason,
      metadata: {
        manualCompletion: {
          bankReference,
          paidAt: paidAt.toISOString(),
          reason,
        },
      },
    })
    if (result.kind === "conflict") {
      const body = { code: result.code, message: result.message }
      if (result.code === "MAKER_CHECKER_VIOLATION") {
        throw new ForbiddenException(body)
      }
      throw new ConflictException(body)
    }

    const updated = await this.prisma.withdrawal.findUniqueOrThrow({
      where: { id },
    })
    if (result.kind === "completed") {
      const publisher = await this.prisma.publisher.findUniqueOrThrow({
        where: { id: updated.publisherId },
        select: { organizationId: true },
      })
      await this.notifyPublisherMembers(
        updated.publisherId,
        publisher.organizationId,
        "WITHDRAWAL_COMPLETED",
        `Withdrawal of ${updated.amount} has been paid.`,
      )
    }
    return updated
  }

  async rejectWithdrawal(id: string, rejectedBy: string, reason: string) {
    assertApiFinanceOperationAllowed("operator_decision")
    return this.rejectOrAbandonWithdrawal(id, rejectedBy, reason, "PENDING")
  }

  async abandonApprovedWithdrawal(
    id: string,
    rejectedBy: string,
    reason: string,
  ) {
    assertApiFinanceOperationAllowed("operator_decision")
    return this.rejectOrAbandonWithdrawal(id, rejectedBy, reason, "APPROVED")
  }

  private async rejectOrAbandonWithdrawal(
    id: string,
    rejectedBy: string,
    reason: string,
    expectedStatus: "PENDING" | "APPROVED",
  ) {
    const normalizedReason = reason?.trim()
    if (
      !normalizedReason ||
      normalizedReason.length < 10 ||
      normalizedReason.length > 2_000
    ) {
      throw new BadRequestException(
        "A rejection reason between 10 and 2000 characters is required",
      )
    }
    const result = await this.runSerializable(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "Withdrawal" WHERE "id" = $1 FOR UPDATE',
        id,
      )
      const withdrawal = await tx.withdrawal.findUnique({
        where: { id },
        include: { publisher: true },
      })
      if (!withdrawal) throw new NotFoundException("Withdrawal not found")
      if (withdrawal.status !== expectedStatus) {
        throw new ConflictException(
          expectedStatus === "PENDING"
            ? "Only pending withdrawals can be rejected"
            : "Only approved withdrawals can use safe pre-provider abandonment",
        )
      }
      if (!isSupportedMoneyCurrency(withdrawal.currency)) {
        throw new ConflictException({
          code: "WITHDRAWAL_CURRENCY_INVALID",
          message: "Withdrawal is not denominated in canonical USD",
        })
      }
      const eligibleRejector = await tx.staffMembership.findFirst({
        where: {
          userId: rejectedBy,
          role: { in: ["FINANCE", "SUPER_ADMIN"] },
          user: { userType: "STAFF", banned: false },
        },
        select: { id: true },
      })
      if (!eligibleRejector) {
        throw new ForbiddenException({
          code: "WITHDRAWAL_REJECTOR_INELIGIBLE",
          message:
            "Withdrawal rejection requires a current unbanned Finance or Super Admin staff member",
        })
      }
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayoutExecution" WHERE "withdrawalId" = $1 ORDER BY "id" FOR UPDATE',
        id,
      )
      const executions = await tx.payoutExecution.findMany({
        where: { withdrawalId: id },
        select: {
          id: true,
          status: true,
          stage: true,
          cancellationSource: true,
          providerExecutionId: true,
          providerTransferId: true,
          providerPayoutId: true,
          acceptedReference: true,
          bankTraceReference: true,
        },
      })
      const claimCount = await tx.payoutExecutionClaim.count({
        where: { execution: { withdrawalId: id } },
      })
      if (expectedStatus === "PENDING" && executions.length > 0) {
        throw new ConflictException(
          "A withdrawal with payout execution history cannot be rejected",
        )
      }
      const unsafeApprovedHistory =
        claimCount !== 0 ||
        executions.some(
          (execution: any) =>
            execution.status !== "CANCELLED" ||
            execution.stage !== "PRE_PROVIDER_ABORTED" ||
            execution.cancellationSource !== "PRE_PROVIDER_ABORT" ||
            execution.providerExecutionId !== null ||
            execution.providerTransferId !== null ||
            execution.providerPayoutId !== null ||
            execution.acceptedReference !== null ||
            execution.bankTraceReference !== null,
        )
      if (expectedStatus === "APPROVED" && unsafeApprovedHistory) {
        throw new ConflictException({
          code: "WITHDRAWAL_ABANDONMENT_NOT_PROVABLY_PRE_PROVIDER",
          message:
            "Approved withdrawal abandonment requires claim-free pre-provider-aborted execution history",
        })
      }

      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "PublisherBalance" WHERE "publisherId" = $1 FOR UPDATE',
        withdrawal.publisherId,
      )
      const balance = await tx.publisherBalance.findUnique({
        where: { publisherId: withdrawal.publisherId },
      })
      if (!balance) {
        throw new ConflictException(
          "Publisher balance is missing; rejection cannot restore funds",
        )
      }
      if (
        !isSupportedMoneyCurrency((balance as { currency?: unknown }).currency)
      ) {
        throw new ConflictException({
          code: "PUBLISHER_BALANCE_CURRENCY_INVALID",
          message:
            "Publisher balance is not denominated in canonical USD; rejection cannot restore funds",
        })
      }
      const amount = new Decimal(withdrawal.amount)
      const rejectedAt = new Date()
      const isApprovedAbandonment = expectedStatus === "APPROVED"
      const transitioned = await tx.withdrawal.updateMany({
        where: {
          id,
          status: expectedStatus,
          version: withdrawal.version,
        },
        data: {
          status: "REJECTED",
          rejectedBy,
          rejectedAt,
          version: { increment: 1 },
        },
      })
      if (transitioned.count !== 1) {
        throw new ConflictException(
          "Withdrawal changed while rejection was being recorded",
        )
      }

      // The parent transition is intentionally first. The allocation evidence
      // trigger permits releasedAt only while the locked parent is REJECTED;
      // every later balance/ledger/audit write is in this same transaction, so
      // any failure rolls both the status and release markers back.
      const releasedCarry = await this.releaseWithdrawalSources(
        tx,
        id,
        amount,
        withdrawal.currency,
      )
      const restored = await tx.publisherBalance.updateMany({
        where: {
          publisherId: withdrawal.publisherId,
          version: balance.version,
        },
        data: {
          withdrawableBalance: { increment: amount },
          allocationCarryForwardUsed: { decrement: releasedCarry },
          version: { increment: 1 },
        },
      })
      if (restored.count !== 1) {
        throw new ConflictException(
          "Publisher balance changed during rejection",
        )
      }

      await tx.transaction.create({
        data: {
          amount,
          type: "WITHDRAWAL_REVERSAL",
          currency: USD_CURRENCY,
          publisherId: withdrawal.publisherId,
          reference: `withdrawal-reject-${id}`,
          description: `Withdrawal ${id} rejected — funds restored`,
        },
      })
      await this.audit.log(
        {
          action: isApprovedAbandonment
            ? "WITHDRAWAL_PRE_PROVIDER_ABANDONED"
            : "WITHDRAWAL_REJECTED",
          entityType: "Withdrawal",
          entityId: id,
          metadata: {
            publisherId: withdrawal.publisherId,
            amount: String(amount),
            currency: USD_CURRENCY,
            reason: normalizedReason,
            rejectedAt: rejectedAt.toISOString(),
            decision: isApprovedAbandonment
              ? "PRE_PROVIDER_ABANDONMENT"
              : "PENDING_REJECTION",
            preservedApproverUserId: withdrawal.approvedBy,
          },
          userId: rejectedBy,
          organizationId: withdrawal.publisher.organizationId,
        },
        tx,
      )
      const updated = await tx.withdrawal.findUniqueOrThrow({
        where: { id },
      })
      return { updated, withdrawal }
    })

    await this.notifyPublisherMembers(
      result.withdrawal.publisherId,
      result.withdrawal.publisher.organizationId,
      "WITHDRAWAL_REJECTED",
      `Withdrawal of ${result.withdrawal.amount} was rejected. Contact support if you need more information.`,
    )
    return result.updated
  }

  // Compatibility boundary for the former FAILED -> REVERSED shortcut.
  // Local failure is not proof that no provider/bank movement occurred, so
  // this endpoint now reports the evidence requirement without changing
  // withdrawal state or restoring publisher liability.
  async reverseFailedWithdrawal(
    id: string,
    _reversedBy: string,
    reason: string,
  ) {
    const normalizedReason = reason?.trim()
    if (
      !normalizedReason ||
      normalizedReason.length < 10 ||
      normalizedReason.length > 2_000
    ) {
      throw new BadRequestException(
        "A reversal reason between 10 and 2000 characters is required",
      )
    }
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
      include: {
        executions: {
          select: {
            id: true,
            status: true,
            providerExecutionId: true,
            providerPayoutId: true,
            stage: true,
          },
        },
      },
    })
    if (!withdrawal) throw new NotFoundException("Withdrawal not found")
    throw new ConflictException({
      code: "PAYOUT_REVERSAL_EVIDENCE_REQUIRED",
      message:
        "Automatic failed-withdrawal reversal is disabled. Durable provider-confirmed failure or cancellation evidence must be revalidated atomically before reserved funds can be restored.",
      withdrawalStatus: withdrawal.status,
      executionIds: withdrawal.executions.map((item) => item.id),
    })
  }

  async listWithdrawals(
    publisherId?: string,
    take = 50,
    skip = 0,
    statuses?: WithdrawalStatus[],
  ) {
    const where: Prisma.WithdrawalWhereInput = {
      ...(publisherId ? { publisherId } : {}),
      ...(statuses?.length ? { status: { in: statuses } } : {}),
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          publisherId: true,
          amount: true,
          currency: true,
          publicReference: true,
          payoutFee: true,
          netAmount: true,
          feePolicyVersion: true,
          method: true,
          status: true,
          availableAt: true,
          createdAt: true,
          publisher: true,
          payoutMethod: { select: { id: true, type: true, label: true } },
          allocations: {
            where: { releasedAt: null },
            orderBy: { sequence: "asc" },
            select: {
              amount: true,
              currency: true,
              sourceType: true,
              serviceType: true,
              orderId: true,
            },
          },
        },
        take,
        skip,
      }),
      this.prisma.withdrawal.count({ where }),
    ])
    return { items, total, take, skip }
  }
}
