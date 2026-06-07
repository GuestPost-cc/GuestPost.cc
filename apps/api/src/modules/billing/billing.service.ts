import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from "@nestjs/common"
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
      this.logger.warn("Stripe secret key not found, running in dummy mode")
    }
  }

  async createCheckoutSession(walletId: string, amount: number, user: any) {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } })
    if (!wallet) throw new NotFoundException("Wallet not found")

    const owned = (
      (wallet.organizationId && wallet.organizationId === user.organizationId) ||
      (!wallet.organizationId && wallet.userId === user.id)
    )
    if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

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
              unit_amount: amount * 100, // Amount in cents
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
      // Dummy mode
      this.logger.log(`Dummy checkout session created for wallet ${walletId}, amount ${amount}`)
      return { url: `/dummy-checkout?walletId=${walletId}&amount=${amount}` }
    }
  }

  async handleWebhook(signature: string, payload: Buffer) {
    if (!this.stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      // In dummy mode, we might want to manually trigger this or ignore it
      // Since it's dummy mode, let's accept a JSON payload directly if signature is "dummy"
      const data = JSON.parse(payload.toString("utf8"))
      if (data.type === "checkout.session.completed") {
        await this.processSuccessfulPayment(data.data.object)
      }
      return { received: true, dummy: true }
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
    }

    return { received: true }
  }

  private async processSuccessfulPayment(session: any) {
    const walletId = session.metadata?.walletId || session.client_reference_id
    if (!walletId) return

    const amount = parseInt(session.metadata?.amount || "0", 10)
    if (!amount) return

    // Prevent double processing by checking if reference already exists
    const existingTx = await this.prisma.transaction.findFirst({
      where: { reference: session.id },
    })

    if (existingTx) {
      this.logger.warn(`Transaction for session ${session.id} already processed`)
      return
    }

    await this.prisma.$transaction(async (tx: any) => {
      await tx.wallet.update({
        where: { id: walletId },
        data: { availableBalance: { increment: amount } },
      })
      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "DEPOSIT",
          reference: session.id,
          description: `Stripe deposit of ${amount}`,
        },
      })
    })

    const orgId = session.metadata?.organizationId || "system"

    await this.audit.log({
      action: "WALLET_DEPOSIT",
      entityType: "Wallet",
      entityId: walletId,
      metadata: { amount, reference: session.id, method: "stripe" },
      userId: session.metadata?.userId || "system",
      organizationId: orgId,
    })
  }

  async getWallet(organizationId: string | null, userId: string) {
    const where = organizationId ? { organizationId } : { userId }
    let wallet = await this.prisma.wallet.findFirst({
      where,
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 50 } },
    })

    if (!wallet) {
      try {
        const data = organizationId
          ? { availableBalance: 0, reservedBalance: 0, currency: "USD", organizationId, userId }
          : { availableBalance: 0, reservedBalance: 0, currency: "USD", userId }
        wallet = await this.prisma.wallet.create({
          data,
          include: { transactions: { orderBy: { createdAt: "desc" }, take: 50 } },
        })
      } catch (err) {
        wallet = await this.prisma.wallet.findFirst({
          where,
          include: { transactions: { orderBy: { createdAt: "desc" }, take: 50 } },
        })
        if (!wallet) throw err
      }
    }
    return wallet
  }

  async deposit(walletId: string, amount: number, user: any, reference?: string) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } })
      if (!wallet) throw new NotFoundException("Wallet not found")
      const owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId) ||
        (!wallet.organizationId && wallet.userId === user.id)
      )
      if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: { availableBalance: { increment: amount } },
      })
      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "DEPOSIT",
          reference,
          description: `Deposit of ${amount}`,
        },
      })
      return updated
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

  async withdraw(walletId: string, amount: number, user: any) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } })
      if (!wallet) throw new NotFoundException("Wallet not found")
      const owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId) ||
        (!wallet.organizationId && wallet.userId === user.id)
      )
      if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

      const current = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } })
      const available = new Decimal(current.availableBalance)
      if (available.lessThan(amount)) {
        throw new BadRequestException("Insufficient available balance")
      }

      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: { availableBalance: { decrement: amount } },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "WITHDRAWAL",
          description: `Withdrawal of ${amount}`,
        },
      })

      return updated
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
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } })
      if (!wallet) throw new NotFoundException("Wallet not found")
      const owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId) ||
        (!wallet.organizationId && wallet.userId === user.id)
      )
      if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

      const available = new Decimal(wallet.availableBalance)
      if (available.lessThan(amount)) {
        throw new BadRequestException("Insufficient available balance to reserve")
      }

      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: {
          availableBalance: { decrement: amount },
          reservedBalance: { increment: amount },
        },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "RESERVATION",
          orderId,
          description: `Reservation of ${amount} for order ${orderId}`,
        },
      })

      return updated
    })
  }

  async release(walletId: string, amount: number, orderId: string, user: any) {
    return this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } })
      if (!wallet) throw new NotFoundException("Wallet not found")
      const owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId) ||
        (!wallet.organizationId && wallet.userId === user.id)
      )
      if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

      const reserved = new Decimal(wallet.reservedBalance)
      if (reserved.lessThan(amount)) {
        throw new BadRequestException("Insufficient reserved balance to release")
      }

      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: {
          reservedBalance: { decrement: amount },
          availableBalance: { increment: amount },
        },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount,
          type: "RELEASE",
          orderId,
          description: `Release of ${amount} reservation for order ${orderId}`,
        },
      })

      return updated
    })
  }

  async payFromReserved(walletId: string, amount: number, orderId: string, user: any) {
    return this.prisma.$transaction(async (tx: any) => {
      const wallet = await tx.wallet.findUnique({ where: { id: walletId } })
      if (!wallet) throw new NotFoundException("Wallet not found")
      const owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId) ||
        (!wallet.organizationId && wallet.userId === user.id)
      )
      if (!owned) throw new ForbiddenException("Wallet does not belong to this account")

      const reserved = new Decimal(wallet.reservedBalance)
      if (reserved.lessThan(amount)) {
        throw new BadRequestException("Insufficient reserved balance")
      }

      const updated = await tx.wallet.update({
        where: { id: walletId },
        data: {
          reservedBalance: { decrement: amount },
        },
      })

      await tx.transaction.create({
        data: {
          walletId,
          amount: -amount,
          type: "PURCHASE",
          orderId,
          description: `Payment of ${amount} from reserved funds for order ${orderId}`,
        },
      })

      return updated
    })
  }
}
