import { Prisma } from "@guestpost/database"
import {
  orderEventMetadata,
  UnknownServiceTypeError,
  validateBrief,
} from "@guestpost/shared"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { ZodError } from "zod"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { QueueService } from "../queues/queue.service"
import { RefundService } from "./services/refund.service"

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    readonly _queue: QueueService,
    private readonly refund: RefundService,
  ) {}

  async createOrder(
    data: {
      type: string
      title?: string
      instructions?: string
      customerId: string
      organizationId: string
      campaignId?: string
      idempotencyKey?: string
      targetUrl?: string
      anchorText?: string
      // Phase 2 preferred: the customer's locked pick from the listing detail
      // page. When set, the server snapshots its serviceType / price /
      // turnaroundDays / fulfillmentChannel onto the order; downstream code
      // never re-reads the listing for pricing or routing.
      listingServiceId?: string
      // Phase 6: structured per-service brief. Server validates against the
      // shared Zod registry keyed on the resolved serviceType (snapshot).
      briefData?: Record<string, unknown>
      items?: Array<{
        websiteId?: string
        targetUrl?: string
        anchorText?: string
      }>
    },
    userId: string,
  ) {
    // INVARIANT: one website per order. Settlement, refund clawback, and
    // publisher fulfillment all resolve a single publisher from the order's
    // website — items on different websites would pay the wrong publisher.
    // Multi-website purchases are modeled as multiple orders in a campaign.
    const websiteIds = new Set(
      (data.items ?? []).map((i) => i.websiteId ?? null),
    )
    if (websiteIds.size > 1) {
      throw new BadRequestException(
        "All items in an order must target the same website. Create separate orders (within one campaign) for multiple websites.",
      )
    }

    return this.prisma.$transaction(async (tx: any) => {
      if (data.idempotencyKey) {
        // Tenant-scoped replay — a key-only lookup let any organization replay
        // another tenant's key and read their order. The composite unique
        // [organizationId, idempotencyKey] makes the scoping a DB guarantee.
        const existing = await tx.order.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: data.organizationId,
              idempotencyKey: data.idempotencyKey,
            },
          },
        })
        if (existing) return existing
      }

      // ── Phase 2 snapshot: resolve listingService → listing → website ────
      //
      // Preferred path: the client passed listingServiceId from the
      // listing-detail picker. We validate AVAILABLE inside the txn — a
      // publisher pausing the service in the same instant loses the race and
      // the order fails fast rather than silently selling a paused row.
      //
      // Legacy fallback: items[0].websiteId + data.type. We look up the
      // matching (listingId, serviceType) and snapshot if found, otherwise
      // leave the snapshot columns NULL (Phase 4 will require them).
      const firstItem = data.items?.find((i) => i.websiteId)
      let snapshot: {
        listingId: string | null
        listingServiceId: string | null
        fulfillmentChannel: "PUBLISHER" | "PLATFORM" | null
        turnaroundDays: number | null
        snapshotPrice: number | null
        snapshotServiceType: string | null
        websiteId: string | null
        // Phase 6.5: carry the site's default Ops owner through so we can
        // auto-create a FulfillmentAssignment after the order lands.
        managedByUserId: string | null
      } = {
        listingId: null,
        listingServiceId: null,
        fulfillmentChannel: null,
        turnaroundDays: null,
        snapshotPrice: null,
        snapshotServiceType: null,
        websiteId: firstItem?.websiteId ?? null,
        managedByUserId: null,
      }

      if (data.listingServiceId) {
        const ls = await tx.listingService.findUnique({
          where: { id: data.listingServiceId },
          include: {
            listing: {
              include: {
                website: {
                  select: {
                    id: true,
                    ownershipType: true,
                    verificationStatus: true,
                    managedByUserId: true,
                  },
                },
              },
            },
          },
        })
        if (!ls)
          throw new BadRequestException(
            `Listing service ${data.listingServiceId} not found`,
          )
        if (ls.availability !== "AVAILABLE") {
          throw new ConflictException({
            code: "SERVICE_UNAVAILABLE",
            message: `Service ${ls.serviceType} is ${ls.availability} on this listing`,
          })
        }
        if (ls.listing.status !== "APPROVED") {
          throw new BadRequestException("Listing is not approved")
        }
        const site = ls.listing.website
        if (
          site?.ownershipType === "PUBLISHER" &&
          site.verificationStatus === "REVOKED"
        ) {
          throw new BadRequestException({
            code: "WEBSITE_REVOKED",
            message: "Website ownership is revoked and cannot take new orders",
          })
        }
        // The item's websiteId (if present) must agree with the listing's.
        // Mismatches indicate a tampered client payload — reject outright.
        if (
          firstItem?.websiteId &&
          site?.id &&
          firstItem.websiteId !== site.id
        ) {
          throw new BadRequestException(
            "Item websiteId does not match the listing's website",
          )
        }
        snapshot = {
          listingId: ls.listingId,
          listingServiceId: ls.id,
          fulfillmentChannel:
            ls.listing.ownerType === "PLATFORM" ? "PLATFORM" : "PUBLISHER",
          turnaroundDays: ls.turnaroundDays,
          snapshotPrice: Number(ls.price),
          snapshotServiceType: ls.serviceType,
          websiteId: site?.id ?? firstItem?.websiteId ?? null,
          managedByUserId: site?.managedByUserId ?? null,
        }
      } else if (firstItem?.websiteId) {
        // Legacy fallback — try to find a ListingService row matching
        // (websiteId, type) so historical clients still get snapshot columns.
        const listing = await tx.marketplaceListing.findFirst({
          where: { websiteId: firstItem.websiteId, status: "APPROVED" },
          select: {
            id: true,
            ownerType: true,
            website: { select: { managedByUserId: true } },
          },
        })
        if (listing) {
          const ls = await tx.listingService.findUnique({
            where: {
              listingId_serviceType: {
                listingId: listing.id,
                serviceType: data.type as any,
              },
            },
          })
          if (ls && ls.availability === "AVAILABLE") {
            snapshot = {
              listingId: listing.id,
              listingServiceId: ls.id,
              fulfillmentChannel:
                listing.ownerType === "PLATFORM" ? "PLATFORM" : "PUBLISHER",
              turnaroundDays: ls.turnaroundDays,
              snapshotPrice: Number(ls.price),
              snapshotServiceType: ls.serviceType,
              websiteId: firstItem.websiteId,
              managedByUserId: listing.website?.managedByUserId ?? null,
            }
          }
        }
      }

      // Phase 4 hard-switch: every new order must resolve to a ListingService
      // snapshot. The customer's locked pick is the source of truth for
      // serviceType, price, TAT, and fulfillmentChannel — no order can sneak
      // through without one now that the historical backfill is complete.
      //
      // Backwards-compat fallback above STILL resolves the snapshot from
      // (websiteId, type) when the client passes only those — so old clients
      // keep working as long as their (websiteId, type) maps to an
      // AVAILABLE ListingService row. If it doesn't, fail fast here rather
      // than silently writing an unsnapshotted order.
      if (!snapshot.listingServiceId) {
        throw new BadRequestException({
          code: "LISTING_SERVICE_REQUIRED",
          message:
            "Order requires a listingServiceId (or a websiteId+type that maps to an AVAILABLE ListingService).",
        })
      }

      // ── Phase 6: validate the per-service brief ────────────────────────
      // The snapshot serviceType is the authoritative discriminator — we
      // refuse to validate against a different serviceType than the one
      // the customer's listing pick locked in. If the client omitted
      // briefData entirely we accept that (Phase 6 keeps it optional);
      // shape/typing validation happens via Zod and any ZodError surfaces
      // as a 400 with the field path.
      let validatedBrief: Prisma.InputJsonValue | null = null
      if (data.briefData !== undefined && data.briefData !== null) {
        const serviceTypeForBrief = snapshot.snapshotServiceType ?? data.type
        try {
          validatedBrief = validateBrief(
            serviceTypeForBrief,
            data.briefData,
          ) as Prisma.InputJsonValue
        } catch (err) {
          if (err instanceof ZodError) {
            throw new BadRequestException({
              code: "BRIEF_INVALID",
              message: "Brief failed validation",
              issues: err.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            })
          }
          if (err instanceof UnknownServiceTypeError) {
            throw new BadRequestException({
              code: "BRIEF_SERVICE_UNKNOWN",
              message: err.message,
            })
          }
          throw err
        }
      }

      // Order-level website link is required for publisher fulfillment
      // (acceptOrder matches on order.website.publisherId)
      const order = await tx.order.create({
        data: {
          type: snapshot.snapshotServiceType ?? data.type,
          title: data.title,
          instructions: data.instructions,
          customerId: data.customerId,
          organizationId: data.organizationId,
          campaignId: data.campaignId,
          idempotencyKey: data.idempotencyKey ?? null,
          websiteId: snapshot.websiteId,
          targetUrl: data.targetUrl ?? firstItem?.targetUrl ?? null,
          anchorText: data.anchorText ?? firstItem?.anchorText ?? null,
          status: "DRAFT",
          paymentStatus: "PENDING",
          amount: 0,
          // Phase 2 snapshot columns — see the resolveSnapshot block above.
          listingId: snapshot.listingId,
          listingServiceId: snapshot.listingServiceId,
          fulfillmentChannel: snapshot.fulfillmentChannel,
          turnaroundDays: snapshot.turnaroundDays,
          // Phase 6: structured brief, validated above against the registry.
          briefData: validatedBrief ?? Prisma.JsonNull,
        },
      })

      if (data.items && data.items.length > 0) {
        let total = 0
        for (const item of data.items) {
          let price: number
          // Use tx (not this.prisma) — a separate connection here while the
          // transaction holds its own deadlocks the pool under concurrency.
          if (item.websiteId) {
            // Block orders on a revoked domain — defence in depth beyond listing
            // pause (a REVOKED publisher site may never take new orders).
            const site = await tx.website.findUnique({
              where: { id: item.websiteId },
              select: { verificationStatus: true, ownershipType: true },
            })
            if (
              site?.ownershipType === "PUBLISHER" &&
              site.verificationStatus === "REVOKED"
            ) {
              throw new BadRequestException({
                code: "WEBSITE_REVOKED",
                message: `Website ${item.websiteId} ownership is revoked and cannot take new orders`,
              })
            }
            // Post-Phase-4: snapshot.snapshotPrice is always set (the order
            // already failed if listingServiceId was unresolvable above), so
            // the listing-level fallback is gone.
            if (snapshot.snapshotPrice == null) {
              throw new BadRequestException(
                "Internal: order snapshot missing price",
              )
            }
            price = snapshot.snapshotPrice
          } else {
            // Orders without a website are no longer accepted — the
            // listingServiceId snapshot always implies a website.
            throw new BadRequestException(
              "Order items must reference a website",
            )
          }

          await tx.orderItem.create({
            data: {
              orderId: order.id,
              websiteId: item.websiteId,
              targetUrl: item.targetUrl,
              anchorText: item.anchorText,
              price,
              status: "PENDING_PAYMENT",
            },
          })
          total += price
        }
        await tx.order.update({
          where: { id: order.id },
          data: { amount: total },
        })
      }

      // ── Phase 6.5: auto-assign PLATFORM orders to the site's Ops owner ──
      //
      // When fulfillmentChannel resolves to PLATFORM and the site has a
      // managedByUserId, create exactly one ASSIGNED FulfillmentAssignment
      // inside the same txn — the Ops owner sees the order in their "Mine"
      // inbox immediately, no manual claim required. Sites without an owner
      // fall back to the shared unassigned-Ops queue (no row written).
      let autoAssignedToUserId: string | null = null
      if (
        snapshot.fulfillmentChannel === "PLATFORM" &&
        snapshot.managedByUserId
      ) {
        await tx.fulfillmentAssignment.create({
          data: {
            orderId: order.id,
            assignedToUserId: snapshot.managedByUserId,
            // Phase 7.12 (#18): self-assignment by the system. Previously
            // wrote `userId` (the order's customer), which falsely said in
            // audit reads "the customer assigned the order to the Ops
            // staffer." Now points at the same staffer who's receiving the
            // assignment — semantically "self-assigned by the system."
            // The `auto: true` metadata flag on the OrderEvent below still
            // disambiguates this from a manual human claim.
            assignedByUserId: snapshot.managedByUserId,
            status: "ASSIGNED",
          },
        })
        autoAssignedToUserId = snapshot.managedByUserId
      }

      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: "ORDER_CREATED",
          actorId: userId,
          message: `Order created as DRAFT`,
          metadata: {
            type: data.type,
            listingId: snapshot.listingId,
            listingServiceId: snapshot.listingServiceId,
            fulfillmentChannel: snapshot.fulfillmentChannel,
            autoAssignedToUserId,
            auto: autoAssignedToUserId !== null,
          },
        },
      })

      return order
    })
  }

  async addOrderItem(
    orderId: string,
    organizationId: string,
    data: {
      websiteId?: string
      targetUrl?: string
      anchorText?: string
    },
    userId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DRAFT") {
      throw new BadRequestException("Can only add items to draft orders")
    }

    // Backfill websiteId from the order if not provided
    const websiteId = data.websiteId ?? order.websiteId
    if (!websiteId) {
      throw new BadRequestException("websiteId is required — the order has no associated website")
    }

    // One-website-per-order invariant (see createOrder)
    const existingItems = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { websiteId: true },
    })
    const existingWebsiteId =
      order.websiteId ??
      existingItems.find((i) => i.websiteId)?.websiteId ??
      null
    if (existingItems.length > 0 && websiteId !== existingWebsiteId) {
      throw new BadRequestException(
        "All items in an order must target the same website. Create a separate order for a different website.",
      )
    }

    // addOrderItem is a back-end-only helper used to bolt items onto a DRAFT
    // order. Post-Phase-4 it reads the order's snapshotted listingServiceId
    // for pricing — the legacy listing-level / Service-table fallbacks are
    // removed.
    if (!order.listingServiceId) {
      throw new BadRequestException(
        "Order has no listingServiceId — recreate with the new flow",
      )
    }
    const ls = await this.prisma.listingService.findUnique({
      where: { id: order.listingServiceId },
      select: { price: true, availability: true },
    })
    if (!ls)
      throw new BadRequestException("Order's listing service no longer exists")
    if (ls.availability !== "AVAILABLE")
      throw new BadRequestException("Order's service is not available")
    const price: number = Number(ls.price)

    const item = await this.prisma.orderItem.create({
      data: {
        orderId,
        websiteId,
        targetUrl: data.targetUrl,
        anchorText: data.anchorText,
        price,
        status: "PENDING_PAYMENT",
      },
    })

    const total = await this.prisma.orderItem.aggregate({
      where: { orderId },
      _sum: { price: true },
    })
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        amount: total._sum.price ?? 0,
        // First website item must back-fill the order-level website link —
        // publisher fulfillment matches on order.website.publisherId, so an
        // order without it can never be accepted.
        ...(data.websiteId && !order.websiteId
          ? {
              websiteId: data.websiteId,
              targetUrl: order.targetUrl ?? data.targetUrl,
              anchorText: order.anchorText ?? data.anchorText,
            }
          : {}),
      },
    })

    await this.prisma.orderEvent.create({
      data: {
        orderId,
        eventType: "ITEM_ADDED",
        actorId: userId,
        message: `Item added to order`,
        metadata: { itemId: item.id, websiteId: data.websiteId, price },
      },
    })

    return item
  }

  async removeOrderItem(
    orderId: string,
    itemId: string,
    organizationId: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")
    if (order.status !== "DRAFT")
      throw new BadRequestException("Can only remove items from draft orders")

    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId },
    })
    if (!item) throw new NotFoundException("Item not found")

    await this.prisma.orderItem.delete({ where: { id: itemId } })

    const total = await this.prisma.orderItem.aggregate({
      where: { orderId },
      _sum: { price: true },
    })
    const remaining = await this.prisma.orderItem.findFirst({
      where: { orderId, websiteId: { not: null } },
      select: { websiteId: true },
    })
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        amount: total._sum.price ?? 0,
        websiteId: remaining?.websiteId ?? null,
      },
    })

    return { success: true }
  }

  async cancelOrder(orderId: string, organizationId: string, userId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId },
    })
    if (!order) throw new NotFoundException("Order not found")

    const cancellableStatuses = [
      "DRAFT",
      "PENDING_PAYMENT",
      "SUBMITTED",
      "ACCEPTED",
      "CONTENT_REQUESTED",
      "CONTENT_CREATION",
      "CONTENT_READY",
      "CUSTOMER_REVIEW",
      "APPROVED",
      "PUBLISHED",
      "VERIFIED",
    ]
    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Order cannot be cancelled in ${order.status} status`,
      )
    }

    const amount = order.amount ? Number(order.amount) : 0

    // PAID orders: delegate to RefundService for canonical refund path
    // (settlement cancel + clawback + wallet credit + transaction + event + audit)
    if (order.paymentStatus === "PAID") {
      await this.refund.refundOrder(
        orderId,
        "Order cancelled by customer",
        userId,
      )
      return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    }

    // NON-PAID orders: release reservation + cancel order
    return this.prisma.$transaction(async (tx: any) => {
      // Release reserved funds if any
      if (
        order.paymentStatus === "PENDING" &&
        order.status === "PENDING_PAYMENT"
      ) {
        const wallet = await tx.wallet.findFirst({ where: { organizationId } })
        if (wallet && amount > 0) {
          const released = await tx.wallet.updateMany({
            where: { id: wallet.id, version: wallet.version },
            data: {
              reservedBalance: { decrement: amount },
              availableBalance: { increment: amount },
              version: { increment: 1 },
            },
          })
          if (released.count === 0) {
            throw new ConflictException(
              "Wallet was modified by another request. Retry.",
            )
          }
        }
      }

      const cancelled = await tx.order.updateMany({
        where: { id: orderId, version: order.version },
        data: {
          status: "CANCELLED",
          version: { increment: 1 },
        },
      })
      if (cancelled.count === 0) {
        throw new ConflictException(
          "Order was modified by another request. Retry.",
        )
      }
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      })

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ORDER_CANCELLED",
          actorId: userId,
          message: `Order cancelled by customer`,
        },
      })

      await this.audit.log({
        action: "ORDER_CANCELLED",
        entityType: "Order",
        entityId: orderId,
        // Phase 6.9 — uniform snapshot trio across every Order-scoped audit.
        metadata: { ...orderEventMetadata(order), fromStatus: order.status },
        userId,
        organizationId,
      })

      return updated
    })
  }

  // organizationId is null for publisher callers — OrderOwnershipGuard has
  // already verified the order's website belongs to their publisher account,
  // and a null org filter is a Prisma validation error (500), not a no-op.
  async getOrder(id: string, organizationId?: string | null) {
    const order = await this.prisma.order.findFirst({
      where: organizationId ? { id, organizationId } : { id },
      include: {
        items: { include: { publications: true } },
        events: { orderBy: { createdAt: "desc" } },
        contentOrder: true,
        revisions: true,
        reports: true,
        website: true,
        settlements: { include: { approvals: true } },
        dispute: true,
      },
    })
    if (!order) throw new NotFoundException(`Order ${id} not found`)
    return order
  }

  async listOrders(
    organizationId: string,
    campaignId?: string,
    take = 50,
    skip = 0,
  ) {
    const where: any = { organizationId }
    if (campaignId) where.campaignId = campaignId
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          items: true,
          website: true,
          campaign: true,
          settlements: { include: { approvals: true } },
          dispute: true,
        },
      }),
      this.prisma.order.count({ where }),
    ])
    return { items, total, take, skip }
  }

  async listPublisherOrders(publisherId: string, take = 50, skip = 0) {
    const where = { website: { publisherId } }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: {
          items: true,
          website: true,
          campaign: true,
          settlements: { include: { approvals: true } },
          dispute: true,
        },
      }),
      this.prisma.order.count({ where }),
    ])
    return { items, total, take, skip }
  }
}
