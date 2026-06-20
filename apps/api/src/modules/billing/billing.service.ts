import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { isUniqueViolation } from "@guestpost/shared"
import { Decimal } from "@prisma/client/runtime/client"
import Stripe from "stripe"

// Thrown inside an interactive transaction to force a ROLLBACK when a
// concurrent duplicate is detected via P2002. Returning normally from the
// transaction callback would COMMIT everything done before the constraint
// violation (e.g. a wallet increment) — minting money on duplicate webhooks.
class DuplicateEventError extends Error {
  constructor(reference: string) {
    super(`Duplicate event: ${reference}`)
  }
}

@Injectable()
export class BillingService {
  private stripe: any = null
  private readonly logger = new Logger(BillingService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (stripeKey && stripeKey.trim() !== "") {
      this.stripe = new Stripe(stripeKey, { apiVersion: "2025-01-27.acacia" as any })
      this.logger.log("Stripe initialized")
    } else {
      this.logger.warn("Stripe secret key not found — set STRIPE_SECRET_KEY in .env.development")
    }
  }

  private assertWalletOwned(wallet: { organizationId: string | null; userId: string | null }, user: { id: string; organizationId?: string | null }) {
    const owned = (
      (wallet.organizationId && wallet.organizationId === user.organizationId) ||
      (!wallet.organizationId && wallet.userId === user.id)
    )
    if (!owned) throw new ForbiddenException("Wallet does not belong to this account")
  }

  async createCheckoutSession(walletId: string, amount: number, user: any) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } })
    if (!wallet) throw new NotFoundException("Wallet not found")

    this.assertWalletOwned(wallet, user)

    if (this.stripe) {
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: wallet.currency.toLowerCase(),
              product_data: {
                name: "Wallet Deposit",
              },
              unit_amount: Math.round(amount * 100), // Amount in cents (Stripe requires integer)
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3001"}/dashboard/billing?success=true`,
        cancel_url: `${process.env.NEXT_PUBLIC_PORTAL_URL || "http://localhost:3001"}/dashboard/billing?canceled=true`,
        client_reference_id: walletId,
        metadata: {
          walletId,
          userId: user.id,
          amount: amount.toString(),
          organizationId: user.organizationId || "",
        },
      })
      return { url: session.url }
    } else {
      throw new BadRequestException("Payment service not configured — set STRIPE_SECRET_KEY in .env.development")
    }
  }

  async handleWebhook(signature: string, payload: Buffer) {
    if (!this.stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      this.logger.error("Stripe webhook received without STRIPE_WEBHOOK_SECRET set")
      throw new BadRequestException("Webhook not configured — set STRIPE_WEBHOOK_SECRET in .env.development (run `stripe listen --forward-to localhost:4000/api/v1/billing/webhook/stripe`)")
    }

    let event: any
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET)
    } catch (err: any) {
      throw new BadRequestException(`Webhook Error: ${err.message}`)
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as any
      await this.processSuccessfulPayment(session)
    } else if (event.type === "charge.dispute.created") {
      await this.handleChargeback(event.data.object as any)
    } else if (event.type === "charge.dispute.closed") {
      await this.handleChargebackClosed(event.data.object as any)
    }

    return { received: true }
  }

  // Cardholder opened a chargeback at their bank. Stripe will pull the money
  // regardless of what we do — so the disputed amount must stop being
  // spendable NOW: move it available -> reserved on the originating wallet
  // (found via the deposit's payment_intent), audit everything, and alert
  // every staff member so finance can respond within the evidence window.
  private async handleChargeback(dispute: any) {
    this.logger.error(
      `Stripe chargeback received: dispute ${dispute.id}, charge ${dispute.charge}, amount ${dispute.amount} ${dispute.currency}`,
    )

    const disputedAmount = new Decimal(dispute.amount ?? 0).div(100)
    const paymentIntent: string | null = dispute.payment_intent ?? null

    // Link dispute -> originating deposit -> wallet
    const depositTx = paymentIntent
      ? await this.prisma.transaction.findFirst({
          where: { providerRef: paymentIntent, type: "DEPOSIT" },
          select: { id: true, walletId: true, amount: true, reference: true },
        })
      : null

    let holdResult: { held: string; shortfall: string; walletId: string } | null = null

    if (depositTx?.walletId && disputedAmount.greaterThan(0)) {
      try {
        holdResult = await this.prisma.$transaction(async (tx: any) => {
          // Idempotency: one hold per dispute. Unique Transaction.reference is
          // the hard guarantee; this read is the fast path.
          const existingHold = await tx.transaction.findFirst({
            where: { reference: `chargeback-hold-${dispute.id}` },
          })
          if (existingHold) throw new DuplicateEventError(`chargeback-hold-${dispute.id}`)

          const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: depositTx.walletId } })
          const available = new Decimal(wallet.availableBalance)
          // Hold what is still there — the org may have spent part of the
          // deposit already. The shortfall is recorded for finance.
          const held = Decimal.min(available, disputedAmount)
          const shortfall = disputedAmount.minus(held)

          if (held.greaterThan(0)) {
            const updated = await tx.wallet.updateMany({
              where: { id: wallet.id, version: wallet.version },
              data: {
                availableBalance: { decrement: held },
                reservedBalance: { increment: held },
                version: { increment: 1 },
              },
            })
            if (updated.count === 0) {
              throw new ConflictException("Wallet was modified by another request. Retry.")
            }
          }

          // Hold row is written even for a zero hold so duplicate webhooks
          // and the dispute-closed handler have a single source of truth.
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              amount: held.negated(),
              type: "RESERVATION",
              reference: `chargeback-hold-${dispute.id}`,
              providerRef: paymentIntent,
              description: `Chargeback hold of ${held.toFixed(2)} for dispute ${dispute.id}` +
                (shortfall.greaterThan(0) ? ` (${shortfall.toFixed(2)} already spent — uncovered exposure)` : ""),
            },
          })

          return { held: held.toFixed(2), shortfall: shortfall.toFixed(2), walletId: wallet.id }
        })
      } catch (err: any) {
        if (err instanceof DuplicateEventError || err?.code === "P2002") {
          this.logger.warn(`Chargeback hold for dispute ${dispute.id} already placed — duplicate webhook ignored`)
          return
        }
        throw err
      }
    }

    await this.audit.log({
      action: holdResult ? "STRIPE_CHARGEBACK_HOLD_PLACED" : "STRIPE_CHARGEBACK_UNLINKED",
      entityType: "StripeDispute",
      entityId: dispute.id,
      metadata: {
        charge: dispute.charge,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: dispute.status,
        paymentIntent,
        depositTransactionId: depositTx?.id ?? null,
        walletId: holdResult?.walletId ?? null,
        heldAmount: holdResult?.held ?? "0.00",
        uncoveredExposure: holdResult?.shortfall ?? disputedAmount.toFixed(2),
      },
      userId: null,
      organizationId: null,
    })

    const summary = holdResult
      ? `${holdResult.held} held${Number(holdResult.shortfall) > 0 ? `, ${holdResult.shortfall} uncovered` : ""}`
      : "NO WALLET LINK — manual review required"
    await this.notifyStaff(
      "STRIPE_CHARGEBACK",
      `Chargeback ${dispute.id} for ${disputedAmount.toFixed(2)} ${String(dispute.currency).toUpperCase()} — ${summary}. Respond in Stripe dashboard.`,
      `chargeback:${dispute.id}:opened`,
    )
  }

  // Dispute resolved at the bank. won -> release the hold back to available.
  // lost -> the money left the platform: consume the hold permanently and
  // write a CHARGEBACK ledger row so reconciliation stays balanced.
  private async handleChargebackClosed(dispute: any) {
    const hold = await this.prisma.transaction.findFirst({
      where: { reference: `chargeback-hold-${dispute.id}` },
      select: { id: true, walletId: true, amount: true },
    })

    if (!hold?.walletId) {
      await this.audit.log({
        action: "STRIPE_CHARGEBACK_CLOSED_UNLINKED",
        entityType: "StripeDispute",
        entityId: dispute.id,
        metadata: { status: dispute.status, paymentIntent: dispute.payment_intent ?? null },
        userId: null,
        organizationId: null,
      })
      await this.notifyStaff(
        "STRIPE_CHARGEBACK",
        `Chargeback ${dispute.id} closed (${dispute.status}) — no hold on record, reconcile manually`,
        `chargeback:${dispute.id}:closed-unlinked`,
      )
      return
    }

    const held = new Decimal(hold.amount).negated() // hold row is negative

    // Money is debited ONLY on an explicit "lost". "won" and "warning_closed"
    // (inquiry closed, no chargeback ever filed) both release the hold.
    // Any unrecognized terminal status must not move money — alert instead.
    const won = dispute.status === "won" || dispute.status === "warning_closed"
    const lost = dispute.status === "lost"
    if (!won && !lost) {
      await this.audit.log({
        action: "STRIPE_CHARGEBACK_CLOSED_UNRECOGNIZED",
        entityType: "StripeDispute",
        entityId: dispute.id,
        metadata: { status: dispute.status, walletId: hold.walletId, heldAmount: held.toFixed(2) },
        userId: null,
        organizationId: null,
      })
      await this.notifyStaff(
        "STRIPE_CHARGEBACK",
        `Chargeback ${dispute.id} closed with unrecognized status "${dispute.status}" — hold of ${held.toFixed(2)} left in place, resolve manually`,
        `chargeback:${dispute.id}:closed-unrecognized`,
      )
      return
    }
    const reference = won ? `chargeback-release-${dispute.id}` : `chargeback-lost-${dispute.id}`

    try {
      await this.prisma.$transaction(async (tx: any) => {
        const existing = await tx.transaction.findFirst({ where: { reference } })
        if (existing) throw new DuplicateEventError(reference)

        if (held.greaterThan(0)) {
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } })
          const updated = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: won
              ? {
                  reservedBalance: { decrement: held },
                  availableBalance: { increment: held },
                  version: { increment: 1 },
                }
              : {
                  reservedBalance: { decrement: held },
                  version: { increment: 1 },
                },
          })
          if (updated.count === 0) {
            throw new ConflictException("Wallet was modified by another request. Retry.")
          }
        }

        await tx.transaction.create({
          data: {
            walletId: hold.walletId,
            // won: RESERVATION offset (+) nets the hold to zero, excluded from
            // wallet sums. lost: CHARGEBACK (-) is counted — money left.
            amount: won ? held : held.negated(),
            type: won ? "RESERVATION" : "CHARGEBACK",
            reference,
            description: won
              ? `Chargeback ${dispute.id} won — hold of ${held.toFixed(2)} released`
              : `Chargeback ${dispute.id} lost — ${held.toFixed(2)} debited permanently`,
          },
        })
      })
    } catch (err: any) {
      if (err instanceof DuplicateEventError || err?.code === "P2002") {
        this.logger.warn(`Chargeback close for dispute ${dispute.id} already processed — duplicate webhook ignored`)
        return
      }
      throw err
    }

    await this.audit.log({
      action: won ? "STRIPE_CHARGEBACK_WON_RELEASED" : "STRIPE_CHARGEBACK_LOST_DEBITED",
      entityType: "StripeDispute",
      entityId: dispute.id,
      metadata: { walletId: hold.walletId, amount: held.toFixed(2), disputeStatus: dispute.status },
      userId: null,
      organizationId: null,
    })

    await this.notifyStaff(
      "STRIPE_CHARGEBACK",
      won
        ? `Chargeback ${dispute.id} WON — ${held.toFixed(2)} released back to the wallet`
        : `Chargeback ${dispute.id} LOST — ${held.toFixed(2)} debited`,
      `chargeback:${dispute.id}:${won ? "won" : "lost"}`,
    )
  }

  // Phase 7.4 (audit #12) — optional `dedupKeyPrefix` enables per-(event, staff)
  // idempotency. Callers that have a stable identifier for the event (chargeback
  // dispute id, etc.) supply the prefix; per-staff suffix is added automatically.
  // Callers without a stable identifier omit it — legacy NULL dedup applies.
  private async notifyStaff(type: string, message: string, dedupKeyPrefix?: string) {
    const staff = await this.prisma.staffMembership.findMany({ select: { userId: true } })
    for (const s of staff) {
      const dedupKey = dedupKeyPrefix ? `${dedupKeyPrefix}:${s.userId}` : null
      try {
        await this.prisma.notification.create({
          data: { userId: s.userId, organizationId: null, type, message, dedupKey },
        })
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Idempotent retry — another worker pod already wrote this notification.
          continue
        }
        this.logger.error(`Failed to notify staff ${s.userId}: ${err}`)
      }
    }
  }

  private async processSuccessfulPayment(session: any) {
    const walletId = session.metadata?.walletId || session.client_reference_id
    if (!walletId) return

    // Amount from Stripe authoritative source (amount_total is in cents).
    // Exact Decimal division — Math.round(cents/100) would round $10.50 to
    // $11 and mint money on every non-whole-dollar deposit.
    const amountCents = session.amount_total ?? 0
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      this.logger.warn(`Invalid amount_total ${amountCents} in webhook session ${session.id}`)
      return
    }
    const amount = new Decimal(amountCents).div(100)

    const orgId = session.metadata?.organizationId || null

    try {
      await this.prisma.$transaction(async (tx: any) => {
        // Idempotency: unique constraint on Transaction.reference prevents duplicates
        // Even if two webhooks arrive concurrently, only one tx.reference = session.id commits
        const existingTx = await tx.transaction.findFirst({
          where: { reference: session.id },
        })
        if (existingTx) throw new DuplicateEventError(session.id)

        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
        const updated = await tx.wallet.updateMany({
          where: { id: walletId, version: wallet.version },
          data: {
            availableBalance: { increment: amount },
            version: { increment: 1 },
          },
        })
        if (updated.count === 0) {
          throw new ConflictException("Wallet was modified by another request. Retry.")
        }

        // P2002 here MUST propagate and roll the transaction back — catching
        // it and returning would commit the wallet increment above without a
        // ledger row (double credit). The unique constraint is the idempotency
        // guarantee; the findFirst above is only the fast path.
        await tx.transaction.create({
          data: {
            walletId,
            amount,
            type: "DEPOSIT",
            reference: session.id,
            // payment_intent linkage lets chargeback webhooks find this deposit
            providerRef: session.payment_intent ?? null,
            description: `Stripe deposit of ${amount.toFixed(2)}`,
          },
        })
      })
    } catch (err: any) {
      if (err instanceof DuplicateEventError || err?.code === "P2002") {
        this.logger.warn(`Duplicate webhook: session ${session.id} already processed — rolled back`)
        return
      }
      throw err
    }

    await this.audit.log({
      action: "WALLET_DEPOSIT",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount: amount.toNumber(), reference: session.id, method: "stripe" },
      userId: session.metadata?.userId || null,
      organizationId: orgId,
    })
  }

  async getWallet(organizationId: string | null, userId: string) {
    const include = { transactions: { orderBy: { createdAt: "desc" as const }, take: 50 } }

    if (organizationId) {
      // @@unique([organizationId]) makes upsert race-safe
      return this.prisma.wallet.upsert({
        where: { organizationId },
        create: { availableBalance: 0, reservedBalance: 0, currency: "USD", organizationId, userId },
        update: {},
        include,
      })
    }

    // userId has no unique constraint — fall back to find/create with conflict retry
    let wallet = await this.prisma.wallet.findFirst({ where: { userId }, include })
    if (!wallet) {
      try {
        wallet = await this.prisma.wallet.create({
          data: { availableBalance: 0, reservedBalance: 0, currency: "USD", userId },
          include,
        })
      } catch (err) {
        wallet = await this.prisma.wallet.findFirst({ where: { userId }, include })
        if (!wallet) throw err
      }
    }
    return wallet
  }

  async deposit(walletId: string, amount: number, user: any, reference?: string) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      if (reference) {
        const existing = await tx.transaction.findFirst({
          where: { reference, type: "DEPOSIT" },
        })
        if (existing) {
          this.logger.warn(`Duplicate deposit detected: ${reference}`)
          throw new BadRequestException("Deposit with this reference already exists")
        }
      }
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      this.assertWalletOwned(wallet, user)

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Wallet was modified by another request. Retry.")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })

      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "DEPOSIT",
          reference,
          description: `Deposit of ${amount}`,
        },
      })
      return fresh
    })

    await this.audit.log({
      action: "WALLET_DEPOSIT",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount, reference },
      userId: user.id,
      organizationId: user.organizationId,
    })

    return result
  }

  async withdraw(walletId: string, amount: number, user: any, idempotencyKey?: string) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      if (idempotencyKey) {
        const existing = await tx.transaction.findFirst({
          where: { reference: idempotencyKey, type: "WITHDRAWAL" },
        })
        if (existing) {
          this.logger.warn(`Duplicate withdrawal detected: ${idempotencyKey}`)
          throw new BadRequestException("Withdrawal with this idempotency key already exists")
        }
      }
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      this.assertWalletOwned(wallet, user)

      const available = new Decimal(wallet.availableBalance)
      if (available.lessThan(amount)) {
        throw new BadRequestException("Insufficient available balance")
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { decrement: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Wallet was modified by another request. Retry.")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "WITHDRAWAL",
          reference: idempotencyKey ?? null,
          description: `Withdrawal of ${amount}`,
        },
      })

      return fresh
    })

    await this.audit.log({
      action: "WALLET_WITHDRAWAL",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount },
      userId: user.id,
      organizationId: user.organizationId,
    })

    return result
  }

  async listTransactions(organizationId: string | null, userId: string) {
    const wallet = await this.getWallet(organizationId, userId)
    if (!wallet) throw new NotFoundException("Wallet not found")

    return this.prisma.transaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
  }

  // `existingTx`: when the caller already holds a transaction (e.g. order
  // payment capture), run inside it so the wallet movement commits or rolls
  // back atomically with the caller's state change. Passing a separate
  // transaction here would let a debit survive a rolled-back order capture —
  // the double-charge bug under concurrent submit-payment.
  async reserve(walletId: string, amount: number, orderId: string, user: any, existingTx?: any) {
    const run = async (tx: any) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      this.assertWalletOwned(wallet, user)

      const available = new Decimal(wallet.availableBalance)
      if (available.lessThan(amount)) {
        throw new BadRequestException("Insufficient available balance to reserve")
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { decrement: amount },
          reservedBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Wallet was modified by another request. Retry.")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "RESERVATION",
          orderId,
          description: `Reservation of ${amount} for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
  }

  async payFromReserved(walletId: string, amount: number, orderId: string, user: any, existingTx?: any) {
    const run = async (tx: any) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      this.assertWalletOwned(wallet, user)

      const reserved = new Decimal(wallet.reservedBalance)
      if (reserved.lessThan(amount)) {
        throw new BadRequestException("Insufficient reserved balance")
      }

      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          reservedBalance: { decrement: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Wallet was modified by another request. Retry.")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "PURCHASE",
          orderId,
          description: `Payment of ${amount} from reserved funds for order ${orderId}`,
        },
      })

      return fresh
    }
    return existingTx ? run(existingTx) : this.prisma.$transaction(run)
  }

  async refund(walletId: string, amount: number, orderId: string, user: any) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      this.assertWalletOwned(wallet, user)

      // Idempotency check using unique reference — database-level @@unique prevents race
      const existingRefund = await tx.transaction.findFirst({
        where: { orderId, type: "REFUND" },
      })
      if (existingRefund) {
        throw new BadRequestException("Order already refunded")
      }

      // Refund is for CAPTURED payments only (callers enforce paymentStatus=PAID).
      // Capture already consumed this order's reservation, so reservedBalance must
      // NOT be touched here — any reserved funds belong to other orders. The full
      // amount returns from the platform to availableBalance.
      const updated = await tx.wallet.updateMany({
        where: { id: walletId, version: wallet.version },
        data: {
          availableBalance: { increment: amount },
          version: { increment: 1 },
        },
      })
      if (updated.count === 0) {
        throw new ConflictException("Concurrent wallet modification")
      }

      const fresh = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })

      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "REFUND",
          orderId,
          reference: `refund-${orderId}`,
          description: `Refund of ${amount} for order ${orderId}`,
        },
      })

      return fresh
    })

    await this.audit.log({
      action: "WALLET_REFUND",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount, orderId },
      userId: user.id,
      organizationId: user.organizationId,
    })

    return result
  }
}
