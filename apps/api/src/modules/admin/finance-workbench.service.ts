import { ForbiddenException, Injectable, Logger } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PrismaService } from "../../common/prisma.service"
import { RevenueService } from "./finance/revenue.service"
import { ReconciliationService } from "./reconciliation.service"

const ACTIVE_SETTLEMENT_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "CUSTOMER_APPROVED",
  "ADMIN_APPROVED",
] as const
const ACTIVE_WITHDRAWAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "FAILED",
] as const
const ACTIVE_PAYOUT_STATUSES = ["PENDING", "PROCESSING", "FAILED"] as const
const ACTIVE_DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW"] as const
const ACTIVE_SUPPORT_STATUSES = ["OPEN", "IN_PROGRESS"] as const

const FINANCE_AUDIT_ACTIONS = [
  "SETTLEMENT_ADMIN_APPROVED",
  "SETTLEMENT_FUNDS_RELEASED",
  "SETTLEMENT_CANCELLED",
  "WITHDRAWAL_APPROVED",
  "WITHDRAWAL_REJECTED",
  "WITHDRAWAL_COMPLETED",
  "WITHDRAWAL_REVERSED",
  "PAYOUT_EXECUTION_STARTED",
  "PAYOUT_EXECUTION_FAILED",
  "PAYOUT_EXECUTION_CANCELLED",
  "ORDER_CANCELLATION_FINANCE_APPROVED",
  "DISPUTE_REFUND",
  "ORDER_REFUNDED",
] as const

export type FinanceWorkbenchPriority = "CRITICAL" | "HIGH" | "MEDIUM"
export type FinanceWorkbenchActionType =
  | "RECONCILIATION"
  | "SUPPORT"
  | "PAYOUT"
  | "WITHDRAWAL"
  | "CANCELLATION"
  | "DISPUTE"
  | "SETTLEMENT"

export interface FinanceWorkbenchAction {
  id: string
  type: FinanceWorkbenchActionType
  priority: FinanceWorkbenchPriority
  title: string
  description: string
  href: string
  createdAt: Date | string
  deadlineAt: Date | string | null
  amount: string | null
  currency: string | null
}

const priorityRank: Record<FinanceWorkbenchPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
}

// Support is deliberately first within a severity band. It prevents an old
// publisher question from disappearing behind a long list of equally-ranked
// ledger work while still keeping critical integrity failures at the top.
const actionTypeRank: Record<FinanceWorkbenchActionType, number> = {
  SUPPORT: 0,
  RECONCILIATION: 1,
  PAYOUT: 2,
  WITHDRAWAL: 3,
  CANCELLATION: 4,
  DISPUTE: 5,
  SETTLEMENT: 6,
}

export function sortFinanceWorkbenchActions(
  left: FinanceWorkbenchAction,
  right: FinanceWorkbenchAction,
) {
  const priorityDifference =
    priorityRank[left.priority] - priorityRank[right.priority]
  if (priorityDifference !== 0) return priorityDifference

  const typeDifference = actionTypeRank[left.type] - actionTypeRank[right.type]
  if (typeDifference !== 0) return typeDifference

  const deadline = (value: Date | string | null) =>
    value ? new Date(value).getTime() : Number.POSITIVE_INFINITY
  const leftDeadline = deadline(left.deadlineAt)
  const rightDeadline = deadline(right.deadlineAt)
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline

  return (
    new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
}

function asDecimal(value: unknown) {
  if (value === null || value === undefined) return new Decimal(0)
  return value instanceof Decimal ? value : new Decimal(String(value))
}

function money(value: unknown): string {
  return asDecimal(value).toFixed(2)
}

function sumMoney(...values: unknown[]): string {
  return values
    .reduce<Decimal>(
      (total, value) => total.add(asDecimal(value)),
      new Decimal(0),
    )
    .toFixed(2)
}

function olderThan(value: Date | string, hours: number, now: Date) {
  return now.getTime() - new Date(value).getTime() >= hours * 60 * 60 * 1000
}

function overdue(value: Date | string | null | undefined, now: Date) {
  return Boolean(value && new Date(value).getTime() < now.getTime())
}

function hasAmount(value: unknown) {
  return value !== null && value !== undefined
}

function statusRows(
  rows: Array<{
    status: string
    _count: { _all: number }
    _sum: Record<string, unknown>
  }>,
  amountKey: string,
) {
  return rows.map((row) => ({
    status: row.status,
    count: row._count._all,
    amount: money(row._sum[amountKey]),
  }))
}

function auditHref(entityType: string) {
  if (entityType === "Settlement") return "/dashboard/finance?tab=settlements"
  if (entityType === "Withdrawal" || entityType === "PayoutExecution") {
    return "/dashboard/finance?tab=payouts"
  }
  if (entityType === "OrderCancellationRequest") {
    return "/dashboard/cancellations?status=PENDING_FINANCE"
  }
  if (entityType === "Dispute") return "/dashboard/disputes"
  return "/dashboard/finance"
}

@Injectable()
export class FinanceWorkbenchService {
  private readonly logger = new Logger(FinanceWorkbenchService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    private readonly revenue: RevenueService,
  ) {}

  async getWorkbench(staffRole: string) {
    // Controller metadata is the HTTP boundary. Keep the service fail-closed as
    // well so a future internal caller cannot accidentally widen this view.
    if (staffRole !== "SUPER_ADMIN" && staffRole !== "FINANCE") {
      throw new ForbiddenException("Finance workbench access required")
    }

    const now = new Date()
    const supportTarget = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const reconciliationPromise = this.reconciliation.run().catch(() => {
      this.logger.warn("Finance-workbench reconciliation scan unavailable")
      return null
    })
    const revenuePromise = this.revenue
      .getRevenue({
        from: from.toISOString(),
        to: now.toISOString(),
        groupBy: "channel",
      })
      .catch(() => {
        this.logger.warn("Finance-workbench revenue summary unavailable")
        return null
      })

    const [
      settlementPipelineRows,
      withdrawalPipelineRows,
      payoutPipelineRows,
      eligibleWithdrawalCount,
      financeCancellationCount,
      activeDisputeCount,
      supportCount,
      overdueSupportCount,
      failedWithdrawalCount,
      failedPayoutCount,
      settlementFunds,
      withdrawalFunds,
      cancellations,
      disputes,
      settlements,
      withdrawals,
      failedExecutions,
      tickets,
      publisherDebt,
      debtPublishers,
      auditRows,
      reconciliation,
      revenue,
    ] = await Promise.all([
      this.prisma.settlement.groupBy({
        by: ["status"],
        where: { status: { in: [...ACTIVE_SETTLEMENT_STATUSES] } },
        _count: { _all: true },
        _sum: { publisherAmount: true },
      }),
      this.prisma.withdrawal.groupBy({
        by: ["status"],
        where: { status: { in: [...ACTIVE_WITHDRAWAL_STATUSES] } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.payoutExecution.groupBy({
        by: ["status"],
        where: { status: { in: [...ACTIVE_PAYOUT_STATUSES] } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.withdrawal.count({
        where: {
          status: "PENDING",
          OR: [{ availableAt: null }, { availableAt: { lte: now } }],
        },
      }),
      this.prisma.orderCancellationRequest.count({
        where: { status: "PENDING_FINANCE" },
      }),
      this.prisma.orderDispute.count({
        where: { status: { in: [...ACTIVE_DISPUTE_STATUSES] } },
      }),
      this.prisma.ticket.count({
        where: { status: { in: [...ACTIVE_SUPPORT_STATUSES] } },
      }),
      this.prisma.ticket.count({
        where: {
          status: { in: [...ACTIVE_SUPPORT_STATUSES] },
          updatedAt: { lt: supportTarget },
        },
      }),
      this.prisma.withdrawal.count({ where: { status: "FAILED" } }),
      this.prisma.payoutExecution.count({ where: { status: "FAILED" } }),
      this.prisma.settlement.aggregate({
        where: { status: { in: [...ACTIVE_SETTLEMENT_STATUSES] } },
        _sum: { publisherAmount: true },
      }),
      this.prisma.withdrawal.aggregate({
        where: { status: { in: ["PENDING", "APPROVED", "PROCESSING"] } },
        _sum: { amount: true },
      }),
      this.prisma.orderCancellationRequest.findMany({
        where: { status: "PENDING_FINANCE" },
        orderBy: [{ responseDeadlineAt: "asc" }, { createdAt: "asc" }],
        take: 5,
        select: {
          id: true,
          reasonCode: true,
          responseDeadlineAt: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              title: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.orderDispute.findMany({
        where: { status: { in: [...ACTIVE_DISPUTE_STATUSES] } },
        orderBy: { createdAt: "asc" },
        take: 4,
        select: {
          id: true,
          status: true,
          reason: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              title: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.settlement.findMany({
        where: { status: { in: [...ACTIVE_SETTLEMENT_STATUSES] } },
        orderBy: [{ reviewEndsAt: "asc" }, { createdAt: "asc" }],
        take: 5,
        select: {
          id: true,
          status: true,
          publisherAmount: true,
          reviewEndsAt: true,
          createdAt: true,
          publisher: { select: { name: true, email: true } },
          order: { select: { id: true, title: true, currency: true } },
        },
      }),
      this.prisma.withdrawal.findMany({
        where: { status: { in: [...ACTIVE_WITHDRAWAL_STATUSES] } },
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        take: 6,
        select: {
          id: true,
          status: true,
          amount: true,
          availableAt: true,
          createdAt: true,
          publisher: { select: { name: true, email: true } },
        },
      }),
      this.prisma.payoutExecution.findMany({
        where: { status: "FAILED" },
        orderBy: { createdAt: "asc" },
        take: 5,
        select: {
          id: true,
          withdrawalId: true,
          amount: true,
          createdAt: true,
          provider: { select: { displayName: true } },
          withdrawal: {
            select: {
              publisher: { select: { name: true, email: true } },
            },
          },
        },
      }),
      this.prisma.ticket.findMany({
        where: { status: { in: [...ACTIVE_SUPPORT_STATUSES] } },
        orderBy: { updatedAt: "asc" },
        take: 8,
        select: {
          id: true,
          subject: true,
          status: true,
          fulfillmentChannel: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { name: true } },
          assignedPublisher: { select: { name: true } },
          order: {
            select: {
              id: true,
              title: true,
              status: true,
              amount: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.publisherBalance.aggregate({
        where: { debtBalance: { gt: 0 } },
        _count: { _all: true },
        _sum: { debtBalance: true },
      }),
      this.prisma.publisherBalance.findMany({
        where: { debtBalance: { gt: 0 } },
        orderBy: { debtBalance: "desc" },
        take: 5,
        select: {
          publisherId: true,
          debtBalance: true,
          publisher: { select: { name: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { action: { in: [...FINANCE_AUDIT_ACTIONS] } },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          createdAt: true,
          // Finance does not have the staff directory. A display name is
          // sufficient context without turning activity into an email roster.
          user: { select: { name: true } },
        },
      }),
      reconciliationPromise,
      revenuePromise,
    ])

    const actions: FinanceWorkbenchAction[] = []

    if (reconciliation && reconciliation.summary.totalIssues > 0) {
      actions.push({
        id: "reconciliation",
        type: "RECONCILIATION",
        priority: reconciliation.summary.critical > 0 ? "CRITICAL" : "HIGH",
        title: "Financial integrity needs review",
        description: `${reconciliation.summary.totalIssues} reconciliation issue${reconciliation.summary.totalIssues === 1 ? "" : "s"} detected`,
        href: "/dashboard/finance?tab=reconciliation",
        createdAt: reconciliation.ranAt,
        deadlineAt: null,
        amount: null,
        currency: null,
      })
    }

    for (const ticket of tickets) {
      const old = olderThan(ticket.updatedAt, 24, now)
      actions.push({
        id: ticket.id,
        type: "SUPPORT",
        priority: old ? "HIGH" : "MEDIUM",
        title: ticket.subject,
        description:
          ticket.fulfillmentChannel === "PLATFORM"
            ? "Platform ticket · Finance can add internal notes"
            : ticket.fulfillmentChannel === "PUBLISHER"
              ? `Publisher ticket · ${ticket.assignedPublisher?.name ?? ticket.user.name ?? "Reply needed"}`
              : `General support ticket · ${ticket.user.name ?? "Reply needed"}`,
        href: `/dashboard/support/${ticket.id}`,
        createdAt: ticket.createdAt,
        deadlineAt: null,
        amount: hasAmount(ticket.order?.amount)
          ? money(ticket.order?.amount)
          : null,
        currency: hasAmount(ticket.order?.amount)
          ? (ticket.order?.currency ?? null)
          : null,
      })
    }

    for (const execution of failedExecutions) {
      actions.push({
        id: execution.id,
        type: "PAYOUT",
        priority: "CRITICAL",
        title:
          execution.withdrawal.publisher.name ??
          execution.withdrawal.publisher.email,
        description: `${execution.provider.displayName} payout execution failed`,
        href: "/dashboard/finance?tab=payouts",
        createdAt: execution.createdAt,
        deadlineAt: null,
        amount: money(execution.amount),
        currency: "USD",
      })
    }

    const failedExecutionWithdrawalIds = new Set(
      failedExecutions.map((item) => item.withdrawalId),
    )
    for (const withdrawal of withdrawals) {
      if (
        withdrawal.status === "FAILED" &&
        failedExecutionWithdrawalIds.has(withdrawal.id)
      ) {
        continue
      }
      const isEligible =
        withdrawal.status === "PENDING" &&
        (!withdrawal.availableAt || withdrawal.availableAt <= now)
      if (withdrawal.status !== "FAILED" && !isEligible) continue

      actions.push({
        id: withdrawal.id,
        type: "WITHDRAWAL",
        priority: withdrawal.status === "FAILED" ? "CRITICAL" : "MEDIUM",
        title: withdrawal.publisher.name ?? withdrawal.publisher.email,
        description:
          withdrawal.status === "FAILED"
            ? "Withdrawal failed and needs recovery review"
            : "Withdrawal hold has cleared and is ready for review",
        href: "/dashboard/finance?tab=withdrawals",
        createdAt: withdrawal.createdAt,
        deadlineAt: withdrawal.availableAt,
        amount: money(withdrawal.amount),
        currency: "USD",
      })
    }

    for (const cancellation of cancellations) {
      actions.push({
        id: cancellation.id,
        type: "CANCELLATION",
        priority: overdue(cancellation.responseDeadlineAt, now)
          ? "CRITICAL"
          : "HIGH",
        title:
          cancellation.order.title ||
          `Order #${cancellation.order.id.slice(0, 8)}`,
        description: `Refund decision · ${cancellation.reasonCode.replaceAll("_", " ")}`,
        href: "/dashboard/cancellations?status=PENDING_FINANCE",
        createdAt: cancellation.createdAt,
        deadlineAt: cancellation.responseDeadlineAt,
        amount: hasAmount(cancellation.order.amount)
          ? money(cancellation.order.amount)
          : null,
        currency: hasAmount(cancellation.order.amount)
          ? cancellation.order.currency
          : null,
      })
    }

    for (const dispute of disputes) {
      actions.push({
        id: dispute.id,
        type: "DISPUTE",
        priority: olderThan(dispute.createdAt, 48, now) ? "HIGH" : "MEDIUM",
        title: dispute.order.title || `Order #${dispute.order.id.slice(0, 8)}`,
        description: `${dispute.status.replaceAll("_", " ")} · Review refund exposure`,
        href: `/dashboard/disputes/${dispute.id}/evidence`,
        createdAt: dispute.createdAt,
        deadlineAt: null,
        amount: hasAmount(dispute.order.amount)
          ? money(dispute.order.amount)
          : null,
        currency: hasAmount(dispute.order.amount)
          ? dispute.order.currency
          : null,
      })
    }

    for (const settlement of settlements) {
      const ready = settlement.status === "CUSTOMER_APPROVED"
      actions.push({
        id: settlement.id,
        type: "SETTLEMENT",
        priority:
          ready || overdue(settlement.reviewEndsAt, now) ? "HIGH" : "MEDIUM",
        title:
          settlement.order.title ||
          `Settlement for order #${settlement.order.id.slice(0, 8)}`,
        description: `${settlement.status.replaceAll("_", " ")} · ${settlement.publisher.name ?? settlement.publisher.email}`,
        href: "/dashboard/finance/settlement-review",
        createdAt: settlement.createdAt,
        deadlineAt: settlement.reviewEndsAt,
        amount: money(settlement.publisherAmount),
        currency: settlement.order.currency,
      })
    }

    const sortedActions = actions.sort(sortFinanceWorkbenchActions)
    const actionQueue = sortedActions.slice(0, 12)
    const firstSupport = sortedActions.find((item) => item.type === "SUPPORT")
    if (
      firstSupport &&
      !actionQueue.some((item) => item.type === "SUPPORT") &&
      actionQueue.length === 12
    ) {
      actionQueue[actionQueue.length - 1] = firstSupport
      actionQueue.sort(sortFinanceWorkbenchActions)
    }

    const settlementPipeline = statusRows(
      settlementPipelineRows as any,
      "publisherAmount",
    )
    const withdrawalPipeline = statusRows(
      withdrawalPipelineRows as any,
      "amount",
    )
    const payoutPipeline = statusRows(payoutPipelineRows as any, "amount")
    const readySettlementCount =
      settlementPipeline.find((item) => item.status === "CUSTOMER_APPROVED")
        ?.count ?? 0

    const reconciliationSummary = reconciliation
      ? {
          available: true,
          ok: reconciliation.ok,
          critical: reconciliation.summary.critical,
          warning: reconciliation.summary.warning,
          totalIssues: reconciliation.summary.totalIssues,
          ranAt: reconciliation.ranAt,
        }
      : {
          available: false,
          ok: false,
          critical: 0,
          warning: 0,
          totalIssues: 0,
          ranAt: null,
        }

    return {
      generatedAt: now.toISOString(),
      currency: "USD",
      overview: {
        readyForDecision:
          readySettlementCount +
          eligibleWithdrawalCount +
          financeCancellationCount,
        activeSupport: supportCount,
        fundsInFlight: sumMoney(
          settlementFunds._sum.publisherAmount,
          withdrawalFunds._sum.amount,
        ),
        financialExceptions:
          failedWithdrawalCount +
          failedPayoutCount +
          reconciliationSummary.totalIssues,
        netRevenue30d: revenue?.totals.current.netRevenue ?? "0.00",
      },
      actionQueue,
      support: {
        active: supportCount,
        overdue: overdueSupportCount,
        items: tickets.map((ticket) => ({
          id: ticket.id,
          subject: ticket.subject,
          status: ticket.status,
          channel: ticket.fulfillmentChannel,
          replyMode:
            staffRole !== "SUPER_ADMIN" &&
            ticket.fulfillmentChannel === "PLATFORM"
              ? ("INTERNAL_ONLY" as const)
              : ("PUBLIC_AND_INTERNAL" as const),
          requesterName: ticket.user.name,
          publisherName: ticket.assignedPublisher?.name ?? null,
          order: ticket.order
            ? {
                id: ticket.order.id,
                title: ticket.order.title,
                status: ticket.order.status,
                amount: hasAmount(ticket.order.amount)
                  ? money(ticket.order.amount)
                  : null,
                currency: ticket.order.currency,
              }
            : null,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          overdue: olderThan(ticket.updatedAt, 24, now),
        })),
      },
      pipeline: {
        settlements: settlementPipeline,
        withdrawals: withdrawalPipeline,
        payouts: payoutPipeline,
      },
      decisions: {
        settlementsReady: readySettlementCount,
        withdrawalsEligible: eligibleWithdrawalCount,
        cancellationsPendingFinance: financeCancellationCount,
        activeDisputes: activeDisputeCount,
      },
      reconciliation: reconciliationSummary,
      revenue: revenue
        ? {
            available: true,
            current: revenue.totals.current,
            previous: revenue.totals.previous,
            deltaPct: revenue.totals.deltaPct,
            currencyMismatch: revenue.meta.currencyMismatch,
          }
        : {
            available: false,
            current: null,
            previous: null,
            deltaPct: null,
            currencyMismatch: null,
          },
      publisherRisk: {
        publishersWithDebt: publisherDebt._count._all,
        totalDebt: money(publisherDebt._sum.debtBalance),
        items: debtPublishers.map((balance) => ({
          publisherId: balance.publisherId,
          publisherName: balance.publisher.name,
          debtBalance: money(balance.debtBalance),
        })),
      },
      recentActivity: auditRows.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entityType,
        entityId: row.entityId,
        actorName: row.user ? (row.user.name ?? "Staff member") : "System",
        href: auditHref(row.entityType),
        createdAt: row.createdAt,
      })),
    }
  }
}
