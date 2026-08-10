import {
  isSupportedMoneyCurrency,
  lockOrderAggregate,
  normalizePositiveUsdMoney,
  orderEventMetadata,
} from "@guestpost/shared"
import {
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { notificationThreshold } from "../../../common/notification-config"
import { PrismaService } from "../../../common/prisma.service"
import { AuditService } from "../../audit/audit.service"
import { BillingService } from "../../billing/billing.service"
import { CommunicationsService } from "../../communications/communications.service"
import { projectExternalOrder } from "../order-visibility"
import { assertOwnerOrCreator } from "./owner-or-creator"

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function assertUsdFinancialRow(
  currency: unknown,
  code: string,
  message: string,
) {
  if (!isSupportedMoneyCurrency(currency)) {
    throw new ConflictException({ code, message })
  }
}

export interface SubmitPaymentCommand {
  expectedVersion: number
  expectedAmount: string
  expectedCurrency: string
}

function validateSubmitPaymentCommand(command?: SubmitPaymentCommand) {
  const expectedAmount = normalizePositiveUsdMoney(command?.expectedAmount)
  if (
    !command ||
    !Number.isInteger(command.expectedVersion) ||
    command.expectedVersion < 0 ||
    command.expectedVersion > 2_147_483_647 ||
    typeof command.expectedAmount !== "string" ||
    expectedAmount !== command.expectedAmount ||
    !isSupportedMoneyCurrency(command.expectedCurrency)
  ) {
    throw new BadRequestException({
      code: "CHECKOUT_EVIDENCE_INVALID",
      message:
        "Payment requires the exact canonical order version, USD amount, and currency that were reviewed",
    })
  }
  return expectedAmount
}

@Injectable()
export class OrderPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    @Optional() private readonly communications?: CommunicationsService,
  ) {}

  private async runSerializable<T>(operation: (tx: any) => Promise<T>) {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: "Serializable",
        })
      } catch (error: unknown) {
        if (!isRetryablePrismaTransactionError(error)) throw error
        if (attempt === maxAttempts) {
          throw new ConflictException({
            code: "ORDER_PAYMENT_CONCURRENCY_CONFLICT",
            message:
              "Financial state changed concurrently. Refresh and retry payment.",
          })
        }
        await sleep(prismaTransactionRetryDelayMs(attempt))
      }
    }
    throw new ConflictException({
      code: "ORDER_PAYMENT_CONCURRENCY_CONFLICT",
      message:
        "Financial state changed concurrently. Refresh and retry payment.",
    })
  }

  // Capture is bound to the exact cart state the buyer reviewed. A stale
  // request may never adopt a concurrent re-price or item mutation.
  async submitPayment(
    orderId: string,
    userId: string,
    userOrgId: string,
    actorRole: string | null | undefined,
    command: SubmitPaymentCommand,
  ) {
    const expectedAmount = validateSubmitPaymentCommand(command)
    const result = await this.runSerializable(async (tx: any) => {
      const communicationEventIds: string[] = []
      // Every cart mutation and capture takes the parent Order first. This is
      // the aggregate serialization boundary shared with the database trigger.
      await lockOrderAggregate(tx, orderId)
      const order = await tx.order.findFirst({
        where: { id: orderId, organizationId: userOrgId },
      })
      if (!order) throw new NotFoundException("Order not found")
      // Phase 6.9 — Audit finding #3. Block non-creator MEMBERs from draining
      // the wallet via someone else's DRAFT order. OWNER can always submit;
      // a MEMBER can submit only on THEIR OWN draft (customerId === userId).
      assertOwnerOrCreator({
        customerId: order.customerId,
        actorUserId: userId,
        actorRole,
        action: "submit payment",
      })
      const currentAmount = normalizePositiveUsdMoney(order.amount)
      if (
        order.version !== command?.expectedVersion ||
        currentAmount !== expectedAmount ||
        order.currency !== command?.expectedCurrency
      ) {
        throw new ConflictException({
          code: "ORDER_CHECKOUT_STATE_CHANGED",
          message:
            "Order price or contents changed after review. Refresh checkout and confirm the current total.",
        })
      }
      if (order.status !== "DRAFT" || order.paymentStatus !== "PENDING")
        throw new BadRequestException("Order must be DRAFT to submit payment")
      assertUsdFinancialRow(
        order.currency,
        "ORDER_CURRENCY_UNSUPPORTED",
        "Order currency is not supported by USD-only checkout",
      )

      const wallet = await tx.wallet.findFirst({
        where: { organizationId: userOrgId },
      })
      if (!wallet)
        throw new BadRequestException("No wallet found for organization")
      assertUsdFinancialRow(
        wallet.currency,
        "WALLET_CURRENCY_MISMATCH",
        "Organization wallet is not a canonical USD wallet",
      )

      const amount = new Decimal(order.amount ?? 0)
      if (!amount.isFinite() || amount.lessThanOrEqualTo(0))
        throw new BadRequestException("Order has zero amount — add items first")
      if (!normalizePositiveUsdMoney(amount)) {
        throw new ConflictException({
          code: "ORDER_AMOUNT_INVALID",
          message: "Order amount is not a valid USD amount",
        })
      }

      const items = await tx.orderItem.findMany({ where: { orderId } })
      if (items.length === 0) {
        throw new ConflictException({
          code: "ORDER_ITEMS_INVALID",
          message: "Order has no priced placement items",
        })
      }

      let itemTotal = new Decimal(0)
      for (const item of items) {
        const itemPrice = normalizePositiveUsdMoney(item.price)
        if (!itemPrice || item.status !== "PENDING_PAYMENT") {
          throw new ConflictException({
            code: "ORDER_ITEMS_INVALID",
            message:
              "Every checkout item must be pending payment with a positive whole-cent price",
          })
        }
        if (!order.websiteId || item.websiteId !== order.websiteId) {
          throw new ConflictException({
            code: "ORDER_ITEM_WEBSITE_MISMATCH",
            message: "Order item website identity does not match its order",
          })
        }
        itemTotal = itemTotal.plus(itemPrice)
      }
      if (!itemTotal.equals(amount)) {
        throw new ConflictException({
          code: "ORDER_TOTAL_MISMATCH",
          message:
            "Order total does not match its immutable placement-item total",
        })
      }

      if (new Decimal(wallet.availableBalance).lessThan(amount)) {
        throw new BadRequestException("Insufficient available balance")
      }

      // Verify the selected catalog row only after proving the persisted cart
      // is internally exact. A price change commits an atomic DRAFT re-price
      // and returns 409 outside the transaction so the buyer must reconfirm.
      if (!order.listingServiceId) {
        throw new BadRequestException(
          "Order has no listingServiceId snapshot — cannot price",
        )
      }
      // Lock the complete catalog attribution chain. FOR SHARE conflicts with
      // pause/archive/revoke writers, so a SERIALIZABLE retry observes the
      // winner instead of capturing from a stale availability snapshot.
      await tx.$queryRaw`
        SELECT service."id"
        FROM "ListingService" service
        JOIN "MarketplaceListing" listing
          ON listing."id" = service."listingId"
        JOIN "Website" website
          ON website."id" = listing."websiteId"
        WHERE service."id" = ${order.listingServiceId}
        FOR SHARE OF service, listing, website
      `
      const listingService = await tx.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: {
          id: true,
          listingId: true,
          serviceType: true,
          price: true,
          availability: true,
          currency: true,
          listing: {
            select: {
              id: true,
              status: true,
              currency: true,
              websiteId: true,
              website: {
                select: {
                  id: true,
                  isActive: true,
                  verificationStatus: true,
                },
              },
            },
          },
        },
      })
      if (!listingService) {
        throw new BadRequestException("Listing service no longer available")
      }
      if (listingService.availability !== "AVAILABLE") {
        throw new ConflictException({
          code: "SERVICE_UNAVAILABLE",
          message: "Service is no longer available — refresh and try again",
        })
      }
      if (
        !order.listingId ||
        listingService.listingId !== order.listingId ||
        listingService.listing.id !== order.listingId ||
        !order.websiteId ||
        listingService.listing.websiteId !== order.websiteId ||
        listingService.listing.website?.id !== order.websiteId ||
        listingService.serviceType !== order.type
      ) {
        throw new ConflictException({
          code: "CATALOG_CONTRACT_MISMATCH",
          message:
            "Order catalog and website attribution do not match the selected service",
        })
      }
      if (listingService.listing.status !== "APPROVED") {
        throw new ConflictException({
          code: "LISTING_UNAVAILABLE",
          message: "Marketplace listing is no longer approved for checkout",
        })
      }
      if (
        !listingService.listing.website.isActive ||
        listingService.listing.website.verificationStatus !== "VERIFIED"
      ) {
        throw new ConflictException({
          code: "WEBSITE_UNAVAILABLE",
          message:
            "Marketplace website is inactive or no longer ownership-verified",
        })
      }
      assertUsdFinancialRow(
        listingService.currency,
        "LISTING_SERVICE_CURRENCY_MISMATCH",
        "Listing service is not priced in canonical USD",
      )
      assertUsdFinancialRow(
        listingService.listing.currency,
        "MARKETPLACE_LISTING_CURRENCY_MISMATCH",
        "Marketplace listing is not priced in canonical USD",
      )
      const serverPriceText = normalizePositiveUsdMoney(listingService.price)
      if (!serverPriceText) {
        throw new ConflictException({
          code: "LISTING_SERVICE_PRICE_INVALID",
          message: "Listing service price is not a valid USD amount",
        })
      }
      const serverPrice = new Decimal(serverPriceText)
      const driftedItems: Array<{
        itemId: string
        oldPrice: number
        newPrice: number
      }> = []
      for (const item of items) {
        if (!new Decimal(item.price ?? 0).equals(serverPrice)) {
          driftedItems.push({
            itemId: item.id,
            oldPrice: Number(item.price),
            newPrice: Number(serverPrice),
          })
        }
      }

      if (driftedItems.length > 0) {
        const repriced = await tx.orderItem.updateMany({
          where: {
            orderId,
            id: { in: driftedItems.map((item) => item.itemId) },
            status: "PENDING_PAYMENT",
          },
          data: { price: serverPrice },
        })
        if (repriced.count !== driftedItems.length) {
          throw new ConflictException(
            "Order items were modified by another request. Refresh and retry.",
          )
        }
        const newTotal = serverPrice.mul(items.length)
        const updated = await tx.order.updateMany({
          where: {
            id: orderId,
            version: order.version,
            status: "DRAFT",
            paymentStatus: "PENDING",
          },
          data: { amount: newTotal, version: { increment: 1 } },
        })
        if (updated.count !== 1) {
          throw new ConflictException(
            "Order was modified by another request. Refresh and retry.",
          )
        }
        return {
          kind: "REQUOTE" as const,
          driftedItems,
        }
      }

      // Claim the order BEFORE any money moves. Under concurrent
      // submit-payment, only one request wins this version-guarded transition;
      // losers throw here and never touch the wallet. (Previously the wallet
      // debit happened first, so every parallel request debited and only the
      // order guard deduped — a double-charge.)
      const captured = await tx.order.updateMany({
        where: {
          id: orderId,
          version: order.version,
          status: "DRAFT",
          paymentStatus: "PENDING",
        },
        data: {
          paymentStatus: "PAID",
          status: "PAID",
          version: { increment: 1 },
        },
      })
      if (captured.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }

      // Reserve + capture inside THIS transaction so the debit commits or rolls
      // back atomically with the order claim above.
      await this.billing.reserve(
        wallet.id,
        amount,
        orderId,
        { id: userId, organizationId: userOrgId },
        tx,
      )
      await this.billing.payFromReserved(
        wallet.id,
        amount,
        orderId,
        { id: userId, organizationId: userOrgId },
        tx,
      )

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "PAYMENT_CAPTURED",
          actorId: userId,
          message: `Payment captured — order submitted`,
          metadata: { capturedAmount: amount.toFixed(2) },
        },
      })

      // Auto-submit
      await tx.order.update({
        where: { id: orderId },
        data: { status: "SUBMITTED", submittedAt: new Date() },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_SUBMITTED",
          actorId: userId,
          message: `Order submitted after payment capture`,
        },
      })

      // Pass tx — an un-scoped audit.log would grab a SECOND pooled connection
      // while this transaction still holds its own. Under concurrency that
      // exhausts the pool and every in-flight payment deadlocks until timeout.
      await this.audit.log(
        {
          action: "PAYMENT_CAPTURED",
          entityType: "Order",
          entityId: orderId,
          // Phase 6.9 — uniform snapshot trio across every Order-scoped audit.
          metadata: {
            ...orderEventMetadata(order),
            amount: amount.toFixed(2),
            from: "DRAFT",
            to: "SUBMITTED",
          },
          userId,
          organizationId: userOrgId,
        },
        tx,
      )

      if (this.communications) {
        const customerRecipients =
          await this.communications.customerOrderRecipients(orderId, tx)
        const customerEvent = await this.communications.record(
          {
            type: "ORDER_PAYMENT_CAPTURED",
            aggregateType: "Order",
            aggregateId: orderId,
            organizationId: userOrgId,
            title: "Payment received and order submitted",
            message: `Your payment of ${amount.toFixed(2)} USD was received. Order ${orderId} is now awaiting acceptance.`,
            actionPath: `/dashboard/orders/${orderId}`,
            dedupKey: `order:${orderId}:payment-captured`,
            recipientUserIds: customerRecipients,
            actorUserId: userId,
          },
          tx,
        )
        communicationEventIds.push(customerEvent.eventId)

        const website = order.websiteId
          ? await tx.website.findUnique({
              where: { id: order.websiteId },
              select: { publisherId: true },
            })
          : null
        const publisherRecipients =
          await this.communications.publisherRecipients(
            website?.publisherId,
            false,
            tx,
          )
        const publisherEvent = await this.communications.record(
          {
            type: "ORDER_SUBMITTED",
            aggregateType: "Order",
            aggregateId: orderId,
            organizationId: userOrgId,
            title: "New order awaiting acceptance",
            message: `Order ${orderId} has been paid and is ready for your review.`,
            actionPath: `/dashboard/orders/${orderId}`,
            dedupKey: `order:${orderId}:submitted:publisher`,
            recipientUserIds: publisherRecipients,
            actorUserId: userId,
          },
          tx,
        )
        communicationEventIds.push(publisherEvent.eventId)

        if (
          amount.greaterThan(
            notificationThreshold("ADMIN_HIGH_VALUE_ORDER_THRESHOLD", 500),
          )
        ) {
          const staffRecipients = await this.communications.staffRecipients(
            ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
            tx,
          )
          const staffEvent = await this.communications.record(
            {
              type: "STAFF_HIGH_VALUE_ORDER",
              aggregateType: "Order",
              aggregateId: orderId,
              organizationId: userOrgId,
              title: "High-value order paid",
              message: `Order ${orderId} was paid for ${amount.toFixed(2)} ${order.currency}.`,
              actionPath: `/dashboard/orders/${orderId}`,
              payload: {
                amount: amount.toNumber(),
                currency: order.currency,
              },
              dedupKey: `staff:order:${orderId}:high-value`,
              recipientUserIds: staffRecipients,
              actorUserId: userId,
            },
            tx,
          )
          communicationEventIds.push(staffEvent.eventId)
        }

        const lowBalanceThreshold = new Decimal(
          notificationThreshold("ADMIN_WALLET_LOW_BALANCE_THRESHOLD", 100),
        )
        const previousBalance = new Decimal(wallet.availableBalance)
        const remainingBalance = previousBalance.minus(amount)
        if (
          previousBalance.greaterThanOrEqualTo(lowBalanceThreshold) &&
          remainingBalance.lessThan(lowBalanceThreshold)
        ) {
          const staffRecipients = await this.communications.staffRecipients(
            ["SUPER_ADMIN", "FINANCE"],
            tx,
          )
          const staffEvent = await this.communications.record(
            {
              type: "STAFF_WALLET_LOW_BALANCE",
              aggregateType: "Wallet",
              aggregateId: wallet.id,
              organizationId: userOrgId,
              title: "Customer wallet balance is low",
              message: `Wallet ${wallet.id} fell below the configured balance threshold after order ${orderId}.`,
              actionPath: "/dashboard/finance",
              payload: {
                balance: remainingBalance.toNumber(),
                threshold: lowBalanceThreshold.toNumber(),
                currency: wallet.currency,
                orderId,
              },
              dedupKey: `staff:wallet:${wallet.id}:low-balance:order:${orderId}`,
              recipientUserIds: staffRecipients,
              actorUserId: userId,
            },
            tx,
          )
          communicationEventIds.push(staffEvent.eventId)
        }
      }

      return {
        kind: "CAPTURED" as const,
        order: await tx.order.findUnique({ where: { id: orderId } }),
        communicationEventIds,
      }
    })

    if (result.kind === "REQUOTE") {
      throw new ConflictException({
        code: "REQUOTE_REQUIRED",
        message:
          "Prices changed since the order was created. Review the updated total and submit payment again.",
        driftedItems: result.driftedItems,
      })
    }
    for (const eventId of result.communicationEventIds) {
      this.communications?.dispatchBestEffort(eventId)
    }
    return projectExternalOrder(result.order, "CUSTOMER")
  }
}
