import { createHash } from "node:crypto"
import { runLockedOrderSerializableTransaction } from "@guestpost/shared"
import { lockWalletForUpdate } from "@guestpost/shared/dist/payment-dispute-core"
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { CommunicationsService } from "../communications/communications.service"
import { ProposeRefundCreditRepairDto } from "./dto/reconciliation-repair.dto"
import { isStagingSingleActorRepairDatabaseEnabled } from "./reconciliation-repair.gates"

const SUPPORTED_FINDINGS = [
  "REFUND_PARTIAL",
  "REFUND_PUBLISHER_COMPENSATION_INVALID",
].sort()
const PROPOSAL_TTL_MS = 15 * 60 * 1000
const money = (value: unknown) => new Decimal(String(value))
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

type RepairContext = {
  caseRow: any
  order: any
  source: any
  wallet: any
  compensation: any
  blockers: string[]
  evidenceDigest: string
}

@Injectable()
export class ReconciliationRepairService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly communications: CommunicationsService,
  ) {}

  private assertEnabled() {
    if (process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED !== "true") {
      throw new ServiceUnavailableException({
        code: "RECONCILIATION_REPAIRS_DISABLED",
        message: "Financial reconciliation repairs are not enabled.",
      })
    }
    if (process.env.FINANCE_RUNTIME_MODE !== "recovery_only") {
      throw new ServiceUnavailableException({
        code: "FINANCE_RECOVERY_MODE_REQUIRED",
        message:
          "This repair is available only during an approved recovery window.",
      })
    }
    if (
      process.env.DEPLOYMENT_ENVIRONMENT !== "staging" ||
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS !== "true"
    ) {
      throw new ServiceUnavailableException({
        code: "RECONCILIATION_REPAIR_STEP_UP_REQUIRED",
        message:
          "Repairs are staging-only until verified staff step-up authentication is available.",
      })
    }
    assertApiFinanceOperationAllowed("recovery")
  }

  private mutationsEnabled() {
    return (
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED === "true" &&
      process.env.FINANCE_RUNTIME_MODE === "recovery_only" &&
      process.env.DEPLOYMENT_ENVIRONMENT === "staging" &&
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS === "true"
    )
  }

  private async load(
    caseId: string,
    tx: any = this.prisma,
  ): Promise<RepairContext> {
    const caseRow = await tx.reconciliationCase.findUnique({
      where: { id: caseId },
      include: {
        snapshots: { orderBy: { createdAt: "desc" }, take: 1 },
        order: {
          include: {
            transactions: { orderBy: { createdAt: "asc" } },
            events: { where: { eventType: "REFUND_ISSUED" } },
            website: { select: { publisherId: true, ownershipType: true } },
            settlements: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { publisherId: true, publisherAmount: true },
            },
            publisherCompensation: {
              include: {
                compensationTransaction: true,
                debtRepaymentTransaction: true,
              },
            },
            dispute: true,
            fraudFindings: { take: 1 },
          },
        },
      },
    })
    if (!caseRow) throw new NotFoundException("Reconciliation case not found")
    const findings = caseRow.snapshots[0]?.findingCodes ?? []
    const order = caseRow.order
    const refunds =
      order?.transactions.filter((item: any) => item.type === "REFUND") ?? []
    const reversals =
      order?.transactions.filter(
        (item: any) => item.type === "REFUND_REVERSAL",
      ) ?? []
    const source = refunds.length === 1 ? refunds[0] : null
    const purchases =
      order?.transactions.filter((item: any) => item.type === "PURCHASE") ?? []
    const wallet = source?.walletId
      ? await tx.wallet.findUnique({ where: { id: source.walletId } })
      : null
    const compensation = order?.publisherCompensation
    const blockers: string[] = []

    if (caseRow.aggregateType !== "Order" || caseRow.orderId !== order?.id)
      blockers.push("CASE_NOT_ORDER_BOUND")
    if (
      !["DETECTED", "NEEDS_EVIDENCE", "BLOCKED", "AWAITING_APPROVAL"].includes(
        caseRow.status,
      )
    )
      blockers.push("CASE_NOT_PROPOSABLE")
    if (
      JSON.stringify([...findings].sort()) !==
      JSON.stringify(SUPPORTED_FINDINGS)
    )
      blockers.push("UNSUPPORTED_FINDINGS")
    if (order?.status !== "REFUNDED" || order.paymentStatus !== "REFUNDED")
      blockers.push("ORDER_NOT_TERMINAL_REFUNDED")
    if (!order?.amount || order.currency !== "USD")
      blockers.push("ORDER_CURRENCY_OR_AMOUNT_INVALID")
    if (
      order?.fulfillmentChannel !== "PUBLISHER" &&
      order?.website?.ownershipType !== "PUBLISHER"
    )
      blockers.push("NOT_A_PUBLISHER_ORDER")
    if (refunds.length !== 1 || !source || reversals.length > 0)
      blockers.push("REFUND_SOURCE_NOT_UNIQUE_OR_ALREADY_REVERSED")
    if (
      purchases.length !== 1 ||
      !order ||
      purchases[0]?.amount?.toString() !== `-${order.amount?.toString()}` ||
      purchases[0]?.currency !== "USD" ||
      purchases[0]?.walletId !== source?.walletId ||
      purchases[0]?.provider ||
      purchases[0]?.providerRef
    )
      blockers.push("PURCHASE_EVIDENCE_INVALID")
    if (
      source &&
      (source.amount?.toString() !== order.amount?.toString() ||
        source.currency !== "USD" ||
        source.provider ||
        source.providerRef ||
        !source.reference?.startsWith(`force-cancel:${order.id}:`))
    )
      blockers.push("REFUND_SOURCE_NOT_SUPPORTED_INTERNAL_CREDIT")
    if (
      wallet?.currency !== "USD" ||
      wallet.organizationId !== order?.organizationId
    )
      blockers.push("CUSTOMER_WALLET_INVALID")
    if (
      compensation?.disposition !== "EXACT_AMOUNT" ||
      compensation.amount?.toString() !== order?.amount?.toString() ||
      compensation.currency !== "USD" ||
      compensation.refundTransactionId !== source?.id ||
      compensation.responsibility !== order?.refundResponsibility ||
      ["UNDETERMINED", "PUBLISHER"].includes(compensation.responsibility) ||
      !["PUBLISHED", "VERIFIED", "DELIVERED", "COMPLETED"].includes(
        compensation.effectiveOrderStatus,
      ) ||
      (compensation.reason?.trim().length ?? 0) < 20
    )
      blockers.push("COMPENSATION_EVIDENCE_INVALID")
    if (
      compensation?.compensationTransaction?.type !==
        "PUBLISHER_COMPENSATION" ||
      compensation.compensationTransaction.orderId !== order?.id ||
      compensation.compensationTransaction.publisherId !==
        compensation.publisherId ||
      compensation.compensationTransaction.currency !== "USD" ||
      compensation.compensationTransaction.amount?.toString() !==
        compensation.amount?.toString()
    )
      blockers.push("COMPENSATION_LEDGER_INVALID")
    const authoritativePublisherId =
      order?.settlements[0]?.publisherId ?? order?.website?.publisherId
    if (
      !authoritativePublisherId ||
      compensation?.publisherId !== authoritativePublisherId ||
      (order?.settlements[0] &&
        compensation?.amount?.toString() !==
          order.settlements[0].publisherAmount?.toString()) ||
      compensation?.debtRepaymentTransactionId ||
      compensation?.debtRepaymentTransaction
    )
      blockers.push("COMPENSATION_AUTHORITY_OR_DEBT_EVIDENCE_INVALID")
    if (
      source &&
      !order.events.some(
        (event: any) =>
          event.metadata?.refundTransactionId === source.id &&
          event.metadata?.responsibility === order.refundResponsibility,
      )
    )
      blockers.push("REFUND_DECISION_EVENT_MISSING")
    if (order?.dispute?.status === "OPEN" || order?.fraudFindings?.length)
      blockers.push("ORDER_DISPUTE_OR_FRAUD_REVIEW_OPEN")
    if (
      wallet &&
      (await tx.paymentDispute.count({
        where: {
          walletId: wallet.id,
          OR: [{ status: "OPEN" }, { currentExposureAmount: { gt: 0 } }],
        },
      }))
    )
      blockers.push("WALLET_PAYMENT_DISPUTE_OPEN")
    // Wallet funds are fungible: a historical debit does not make an exact
    // reversal unsafe when the current spendable balance covers it. Reserved
    // funds are excluded because only availableBalance can fund the debit.
    // This condition is revalidated under the wallet/order locks at proposal
    // and execution, so concurrent spending cannot create an overdraft.
    if (
      wallet &&
      source &&
      money(wallet.availableBalance).lessThan(source.amount)
    )
      blockers.push("INSUFFICIENT_AVAILABLE_FUNDS")
    if (findings.length === 0) blockers.push("CASE_EVIDENCE_MISSING")

    // Digest only stable, allowlisted evidence. Private provider payloads and notes are excluded.
    const evidenceDigest = hash({
      caseId: caseRow.id,
      fingerprint: caseRow.currentFingerprint,
      findings: [...findings].sort(),
      order: order && {
        id: order.id,
        amount: String(order.amount),
        currency: order.currency,
        status: order.status,
        paymentStatus: order.paymentStatus,
        version: order.version,
        refundResponsibility: order.refundResponsibility,
      },
      source: source && {
        id: source.id,
        amount: String(source.amount),
        currency: source.currency,
        reference: source.reference,
        walletId: source.walletId,
        createdAt: source.createdAt.toISOString(),
      },
      purchase: purchases.length === 1 && {
        id: purchases[0].id,
        amount: String(purchases[0].amount),
        currency: purchases[0].currency,
        walletId: purchases[0].walletId,
        provider: purchases[0].provider,
        providerRef: purchases[0].providerRef,
      },
      compensation: compensation && {
        id: compensation.id,
        amount: String(compensation.amount),
        currency: compensation.currency,
        responsibility: compensation.responsibility,
        refundTransactionId: compensation.refundTransactionId,
        publisherId: compensation.publisherId,
        compensationTransactionId: compensation.compensationTransactionId,
        compensationTransactionAmount: String(
          compensation.compensationTransaction?.amount ?? "",
        ),
        debtRepaymentTransactionId: compensation.debtRepaymentTransactionId,
        reason: compensation.reason,
      },
      publisherEvidence: {
        websitePublisherId: order?.website?.publisherId ?? null,
        settlement: order?.settlements[0]
          ? {
              publisherId: order.settlements[0].publisherId,
              publisherAmount: String(order.settlements[0].publisherAmount),
            }
          : null,
      },
      wallet: wallet && {
        id: wallet.id,
        availableBalance: String(wallet.availableBalance),
        reservedBalance: String(wallet.reservedBalance),
        currency: wallet.currency,
        version: wallet.version,
      },
      reversals: reversals.map((item: any) => item.id),
    })
    return {
      caseRow,
      order,
      source,
      wallet,
      compensation,
      blockers: [...new Set(blockers)],
      evidenceDigest,
    }
  }

  async preview(caseId: string) {
    const context = await this.load(caseId)
    return {
      eligible: context.blockers.length === 0,
      blockers: context.blockers,
      evidenceDigest: context.evidenceDigest,
      expectedCaseVersion: context.caseRow.version,
      expectedOrderVersion: context.order?.version ?? null,
      expectedWalletVersion: context.wallet?.version ?? null,
      entry: context.source
        ? {
            type: "REFUND_REVERSAL",
            amount: `-${context.source.amount.toString()}`,
            currency: "USD",
            reversesTransactionId: context.source.id,
          }
        : null,
      balance:
        context.wallet && context.source
          ? {
              availableBefore: context.wallet.availableBalance.toString(),
              availableAfter: money(context.wallet.availableBalance)
                .minus(context.source.amount)
                .toString(),
              reservedUnchanged: context.wallet.reservedBalance.toString(),
            }
          : null,
      immutableEvidence:
        "The original refund and decision records remain unchanged.",
      featureEnabled: this.mutationsEnabled(),
    }
  }

  async propose(
    caseId: string,
    userId: string,
    input: ProposeRefundCreditRepairDto,
  ) {
    this.assertEnabled()
    if (!input.providerRefundConfirmedAbsent) {
      throw new ConflictException({
        code: "PROVIDER_REFUND_EVIDENCE_UNCONFIRMED",
        message:
          "A provider-free internal wallet credit must be confirmed from independent payment-provider evidence before proposing a repair.",
      })
    }
    const context = await this.load(caseId)
    if (
      context.blockers.length ||
      context.caseRow.version !== input.expectedCaseVersion ||
      context.evidenceDigest !== input.evidenceDigest
    ) {
      throw new ConflictException({
        code: "REPAIR_PREVIEW_STALE_OR_BLOCKED",
        blockers: context.blockers,
      })
    }
    const proposalDigest = hash({
      caseId,
      evidenceDigest: context.evidenceDigest,
      amount: String(context.source.amount),
      source: context.source.id,
      incidentReference: input.incidentReference,
      providerRefundConfirmedAbsent: input.providerRefundConfirmedAbsent,
      reason: input.reason.trim(),
      caseVersion: context.caseRow.version,
      orderVersion: context.order.version,
      walletVersion: context.wallet.version,
    })
    const created = await runLockedOrderSerializableTransaction(
      this.prisma,
      context.order.id,
      async (tx) => {
        await lockWalletForUpdate(tx, context.wallet.id)
        const current = await this.load(caseId, tx)
        if (
          current.blockers.length ||
          current.caseRow.version !== input.expectedCaseVersion ||
          current.evidenceDigest !== input.evidenceDigest
        )
          throw new ConflictException(
            "Repair evidence changed; create a fresh preview",
          )
        const activeProposal = await tx.reconciliationRepairProposal.findFirst({
          where: { caseId, expiresAt: { gt: new Date() } },
          select: { id: true },
        })
        if (activeProposal)
          throw new ConflictException(
            "An unexpired repair proposal already exists for this case",
          )
        const proposal = await tx.reconciliationRepairProposal.create({
          data: {
            caseId,
            orderId: current.order.id,
            sourceRefundTransactionId: current.source.id,
            providerRefundConfirmedAbsent: input.providerRefundConfirmedAbsent,
            walletId: current.wallet.id,
            evidenceFingerprint: current.caseRow.currentFingerprint,
            evidenceDigest: current.evidenceDigest,
            proposalDigest,
            amount: current.source.amount,
            currency: "USD",
            incidentReference: input.incidentReference,
            reason: input.reason.trim(),
            expectedCaseVersion: current.caseRow.version,
            expectedOrderVersion: current.order.version,
            expectedWalletVersion: current.wallet.version,
            initiatedByUserId: userId,
            expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
          },
        })
        await tx.reconciliationCase.update({
          where: { id: caseId },
          data: { status: "AWAITING_APPROVAL", version: { increment: 1 } },
        })
        await this.audit.log(
          {
            action: "FINANCIAL_RECONCILIATION_REPAIR_PROPOSED",
            entityType: "ReconciliationRepairProposal",
            entityId: proposal.id,
            userId,
            organizationId: null,
            metadata: {
              caseId,
              proposalDigest,
              evidenceDigest: current.evidenceDigest,
              sourceRefundTransactionId: current.source.id,
              amount: current.source.amount.toString(),
              currency: "USD",
              incidentReference: input.incidentReference,
              providerRefundConfirmedAbsent:
                input.providerRefundConfirmedAbsent,
            },
          },
          tx,
        )
        return proposal
      },
    )
    return {
      id: created.id,
      proposalDigest: created.proposalDigest,
      expiresAt: created.expiresAt,
      status: "AWAITING_APPROVAL",
    }
  }

  async approve(
    caseId: string,
    proposalId: string,
    userId: string,
    proposalDigest: string,
  ) {
    this.assertEnabled()
    return this.prisma.$transaction(
      async (tx: any) => {
        const proposal = await tx.reconciliationRepairProposal.findFirst({
          where: { id: proposalId, caseId },
        })
        if (!proposal) throw new NotFoundException("Repair proposal not found")
        if (
          proposal.proposalDigest !== proposalDigest ||
          proposal.expiresAt <= new Date()
        )
          throw new ConflictException("Repair proposal is stale")
        if (
          proposal.initiatedByUserId === userId &&
          !(await isStagingSingleActorRepairDatabaseEnabled(tx))
        )
          throw new ForbiddenException(
            "A different Finance user must approve this proposal",
          )
        const existingApproval =
          await tx.reconciliationRepairApproval.findUnique({
            where: { proposalId },
          })
        if (existingApproval) {
          if (existingApproval.proposalDigest !== proposalDigest)
            throw new ConflictException("Repair proposal is stale")
          return {
            id: existingApproval.id,
            proposalId,
            status: "APPROVED",
            replayed: true,
          }
        }
        const current = await this.load(caseId, tx)
        if (
          current.blockers.length ||
          current.caseRow.status !== "AWAITING_APPROVAL" ||
          current.evidenceDigest !== proposal.evidenceDigest ||
          current.order.version !== proposal.expectedOrderVersion ||
          current.wallet.version !== proposal.expectedWalletVersion
        )
          throw new ConflictException("Repair proposal evidence is stale")
        const approval = await tx.reconciliationRepairApproval.create({
          data: { proposalId, proposalDigest, approvedByUserId: userId },
        })
        await this.audit.log(
          {
            action: "FINANCIAL_RECONCILIATION_REPAIR_APPROVED",
            entityType: "ReconciliationRepairProposal",
            entityId: proposalId,
            userId,
            organizationId: null,
            metadata: { caseId, proposalDigest },
          },
          tx,
        )
        return {
          id: approval.id,
          proposalId,
          status: "APPROVED",
          replayed: false,
        }
      },
      { isolationLevel: "Serializable" },
    )
  }

  async execute(
    caseId: string,
    proposalId: string,
    userId: string,
    proposalDigest: string,
    idempotencyKey: string,
  ) {
    const prior = await (
      this.prisma as any
    ).reconciliationRepairExecution.findUnique({
      where: { caseId_idempotencyKey: { caseId, idempotencyKey } },
    })
    if (prior) {
      if (
        prior.proposalId !== proposalId ||
        prior.requestFingerprint !== hash({ proposalDigest, idempotencyKey })
      )
        throw new ConflictException(
          "Idempotency key was used for a different repair",
        )
      return {
        id: prior.id,
        reversalTransactionId: prior.reversalTransactionId,
        status: "APPLIED",
        replayed: true,
      }
    }
    this.assertEnabled()
    const proposal = await (
      this.prisma as any
    ).reconciliationRepairProposal.findFirst({
      where: { id: proposalId, caseId },
    })
    if (!proposal) throw new NotFoundException("Repair proposal not found")
    const approval = await (
      this.prisma as any
    ).reconciliationRepairApproval.findUnique({ where: { proposalId } })
    if (
      !approval ||
      approval.proposalDigest !== proposalDigest ||
      proposal.proposalDigest !== proposalDigest ||
      (approval.approvedByUserId === userId &&
        !(await isStagingSingleActorRepairDatabaseEnabled(this.prisma))) ||
      proposal.expiresAt <= new Date()
    )
      throw new ConflictException("A current independent approval is required")
    const requestFingerprint = hash({ proposalDigest, idempotencyKey })
    const result = await runLockedOrderSerializableTransaction(
      this.prisma,
      proposal.orderId,
      async (tx) => {
        await lockWalletForUpdate(tx, proposal.walletId)
        const current = await this.load(caseId, tx)
        const freshProposal = await tx.reconciliationRepairProposal.findUnique({
          where: { id: proposalId },
        })
        const freshApproval = await tx.reconciliationRepairApproval.findUnique({
          where: { proposalId },
        })
        if (
          !freshApproval ||
          freshApproval.proposalDigest !== proposalDigest ||
          (freshApproval.approvedByUserId === userId &&
            !(await isStagingSingleActorRepairDatabaseEnabled(tx))) ||
          freshProposal.proposalDigest !== proposalDigest ||
          freshProposal.expiresAt <= new Date() ||
          current.blockers.length ||
          current.caseRow.status !== "AWAITING_APPROVAL" ||
          current.evidenceDigest !== freshProposal.evidenceDigest ||
          current.order.version !== freshProposal.expectedOrderVersion ||
          current.wallet.version !== freshProposal.expectedWalletVersion ||
          current.source.id !== freshProposal.sourceRefundTransactionId ||
          money(current.wallet.availableBalance).lessThan(freshProposal.amount)
        )
          throw new ConflictException(
            "Approved repair evidence is stale or no longer eligible",
          )
        const before = money(current.wallet.availableBalance)
        const after = before.minus(freshProposal.amount)
        await tx.wallet.update({
          where: { id: current.wallet.id },
          data: { availableBalance: after, version: { increment: 1 } },
        })
        const reversal = await tx.transaction.create({
          data: {
            type: "REFUND_REVERSAL",
            amount: money(freshProposal.amount).negated(),
            currency: "USD",
            walletId: current.wallet.id,
            orderId: current.order.id,
            reversalOfTransactionId: current.source.id,
            reference: `reconciliation-refund-reversal:${proposalDigest}`,
            description:
              "Approved reversal of an erroneous internal refund wallet credit",
          },
        })
        const execution = await tx.reconciliationRepairExecution.create({
          data: {
            proposalId,
            caseId,
            orderId: current.order.id,
            sourceRefundTransactionId: current.source.id,
            reversalTransactionId: reversal.id,
            walletId: current.wallet.id,
            amount: freshProposal.amount,
            currency: "USD",
            beforeAvailableBalance: before,
            afterAvailableBalance: after,
            beforeWalletVersion: current.wallet.version,
            afterWalletVersion: current.wallet.version + 1,
            executedByUserId: userId,
            approverUserId: freshApproval.approvedByUserId,
            idempotencyKey,
            requestFingerprint,
          },
        })
        await tx.reconciliationCase.update({
          where: { id: caseId },
          data: { status: "APPLIED", version: { increment: 1 } },
        })
        await this.audit.log(
          {
            action: "FINANCIAL_RECONCILIATION_REPAIR_APPLIED",
            entityType: "ReconciliationRepairExecution",
            entityId: execution.id,
            userId,
            organizationId: null,
            metadata: {
              caseId,
              proposalId,
              proposalDigest,
              evidenceDigest: freshProposal.evidenceDigest,
              sourceRefundTransactionId: current.source.id,
              reversalTransactionId: reversal.id,
              amount: freshProposal.amount.toString(),
              currency: "USD",
              beforeAvailableBalance: before.toString(),
              afterAvailableBalance: after.toString(),
              approverUserId: freshApproval.approvedByUserId,
            },
          },
          tx,
        )
        const recipients = await this.communications.customerOrderRecipients(
          current.order.id,
          tx,
        )
        await this.communications.record(
          {
            type: "ORDER_REFUND_CREDIT_REVERSED",
            aggregateType: "Order",
            aggregateId: current.order.id,
            organizationId: current.order.organizationId,
            title: "Wallet refund credit corrected",
            message: `A credit of $${money(freshProposal.amount).toFixed(2)} applied to your account on ${current.source.createdAt.toISOString().slice(0, 10)} due to an order cancellation error has been reversed. Your order cancellation remains in effect, and the publisher has been compensated. If you have questions, please contact support with reference case #${caseId}.`,
            actionPath: `/dashboard/orders/${current.order.id}`,
            dedupKey: `reconciliation-repair:${proposalId}:customer-notice`,
            recipientUserIds: recipients,
            actorUserId: null,
          },
          tx,
        )
        return {
          id: execution.id,
          reversalTransactionId: reversal.id,
          status: "APPLIED",
          replayed: false,
        }
      },
    )
    this.communications.dispatchByDedupKeyBestEffort(
      `reconciliation-repair:${proposalId}:customer-notice`,
    )
    return result
  }
}
