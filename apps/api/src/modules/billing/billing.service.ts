import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, ConflictException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { Decimal } from "@prisma/client/runtime/library"
import Stripe from "stripe"

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
    }

    return { received: true }
  }

  // Cardholder opened a chargeback at their bank. Money will be pulled by
  // Stripe regardless — this must never pass silently: audit + alert every
  // staff member so finance can respond within the evidence window.
  private async handleChargeback(dispute: any) {
    this.logger.error(
      `Stripe chargeback received: dispute ${dispute.id}, charge ${dispute.charge}, amount ${dispute.amount} ${dispute.currency}`,
    )

    await this.audit.log({
      action: "STRIPE_CHARGEBACK_RECEIVED",
      entityType: "StripeDispute",
      entityId: dispute.id,
      metadata: {
        charge: dispute.charge,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: dispute.status,
        paymentIntent: dispute.payment_intent ?? null,
      },
      userId: null,
      organizationId: null,
    })

    const staff = await this.prisma.staffMembership.findMany({ select: { userId: true } })
    for (const s of staff) {
      await this.prisma.notification.create({
        data: {
          userId: s.userId,
          organizationId: null,
          type: "STRIPE_CHARGEBACK",
          message: `Chargeback ${dispute.id} for ${(dispute.amount / 100).toFixed(2)} ${String(dispute.currency).toUpperCase()} — respond in Stripe dashboard`,
        },
      }).catch((err: any) => this.logger.error(`Failed to notify staff ${s.userId} of chargeback: ${err}`))
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

    await this.prisma.$transaction(async (tx: any) => {
      // Idempotency: unique constraint on Transaction.reference prevents duplicates
      // Even if two webhooks arrive concurrently, only one tx.reference = session.id commits
      const existingTx = await tx.transaction.findFirst({
        where: { reference: session.id },
      })
      if (existingTx) {
        this.logger.warn(`Transaction for session ${session.id} already processed`)
        return
      }

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

      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "DEPOSIT",
          reference: session.id,
          description: `Stripe deposit of ${amount.toFixed(2)}`,
        },
      })
    })

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

  async reserve(walletId: string, amount: number, orderId: string, user: any) {
    return this.prisma.$transaction(async (tx: any) => {
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
    })
  }

  async payFromReserved(walletId: string, amount: number, orderId: string, user: any) {
    return this.prisma.$transaction(async (tx: any) => {
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
    })
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
