import { createHash } from "node:crypto"
import { OrderStatus, Prisma, ServiceType } from "@guestpost/database"
import {
  isSupportedMoneyCurrency,
  isUniqueViolation,
  normalizePositiveUsdMoney,
  runLockedOrderSerializableTransaction,
  UnknownServiceTypeError,
  USD_CURRENCY,
  validateBrief,
} from "@guestpost/shared"
import { isRetryablePrismaTransactionError } from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { ZodError } from "zod"
import { canCustomerViewWebsite } from "../../common/customer-website-access"
import { PrismaService } from "../../common/prisma.service"
import { projectExternalOrder } from "./order-visibility"
import { assertOwnerOrCreator } from "./services/owner-or-creator"

const CREATE_ORDER_RESULT_INCLUDE = {
  items: true,
  articleVersions: true,
} satisfies Prisma.OrderInclude

function assertUsdOrderCurrency(
  currency: unknown,
  source: string,
): asserts currency is typeof USD_CURRENCY {
  if (!isSupportedMoneyCurrency(currency)) {
    throw new ConflictException({
      code: "ORDER_CURRENCY_UNSUPPORTED",
      message: `${source} is not available for USD-only checkout`,
    })
  }
}

function requirePositiveUsdDecimal(
  value: unknown,
  source: string,
): Prisma.Decimal {
  const normalized = normalizePositiveUsdMoney(value)
  if (!normalized) {
    throw new ConflictException({
      code: "ORDER_PRICE_INVALID",
      message: `${source} is not a positive whole-cent USD amount`,
    })
  }
  return new Prisma.Decimal(normalized)
}

function canonicalizeFingerprintValue(
  value: unknown,
  state = { remainingNodes: 10_000 },
  depth = 0,
): unknown {
  state.remainingNodes -= 1
  if (state.remainingNodes < 0 || depth > 32) {
    throw new BadRequestException({
      code: "ORDER_PAYLOAD_TOO_COMPLEX",
      message: "Order payload exceeds the supported structure complexity",
    })
  }
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Prisma.Decimal.isDecimal(value)) return value.toString()
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined
        ? null
        : canonicalizeFingerprintValue(item, state, depth + 1),
    )
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        // Persisted fingerprint contract: compare Unicode code points directly
        // rather than process-locale collation.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [
          key,
          canonicalizeFingerprintValue(entry, state, depth + 1),
        ]),
    )
  }
  return String(value)
}

function createOrderRequestFingerprint(
  data: Parameters<OrdersService["createOrder"]>[0],
  actorUserId: string,
): string {
  const payload = canonicalizeFingerprintValue({
    actorUserId,
    customerId: data.customerId,
    organizationId: data.organizationId,
    type: data.type,
    title: data.title,
    instructions: data.instructions,
    campaignId: data.campaignId,
    expectedListingServiceVersion: data.expectedListingServiceVersion,
    expectedPrice: data.expectedPrice,
    expectedCurrency: data.expectedCurrency,
    articleTitle: data.articleTitle,
    articleBody: data.articleBody,
    articleFormat: data.articleFormat,
    targetUrl: data.targetUrl,
    anchorText: data.anchorText,
    listingServiceId: data.listingServiceId,
    briefData: data.briefData,
    items: data.items ?? [],
  })
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex")
}

function throwIdempotencyPayloadConflict() {
  throw new ConflictException({
    code: "IDEMPOTENCY_KEY_REUSED",
    message:
      "This idempotency key is already bound to a different or unverifiable order request",
  })
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  private async runLockedCartTransaction<T>(
    orderId: string,
    operation: (tx: any) => Promise<T>,
  ): Promise<T> {
    try {
      return await runLockedOrderSerializableTransaction(
        this.prisma,
        orderId,
        operation,
      )
    } catch (error: unknown) {
      if (isRetryablePrismaTransactionError(error)) {
        throw new ConflictException({
          code: "ORDER_CART_CONCURRENCY_CONFLICT",
          message:
            "Order state changed concurrently. Refresh and retry the cart update.",
        })
      }
      throw error
    }
  }

  async createOrder(
    data: {
      type: string
      title?: string
      instructions?: string
      customerId: string
      organizationId: string
      campaignId?: string
      idempotencyKey?: string
      expectedListingServiceVersion?: unknown
      expectedPrice?: unknown
      expectedCurrency?: unknown
      articleTitle?: unknown
      articleBody?: unknown
      articleFormat?: unknown
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
    if (
      data.idempotencyKey !== undefined &&
      (data.idempotencyKey.trim().length === 0 ||
        data.idempotencyKey !== data.idempotencyKey.trim() ||
        data.idempotencyKey.length > 200)
    ) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message:
          "Idempotency key must contain 1 to 200 characters without surrounding whitespace",
      })
    }
    const requestFingerprint = data.idempotencyKey
      ? createOrderRequestFingerprint(data, userId)
      : null

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

    try {
      return await this.prisma.$transaction(async (tx: any) => {
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
            include: CREATE_ORDER_RESULT_INCLUDE,
          })
          if (existing) {
            if (existing.requestFingerprint !== requestFingerprint) {
              throwIdempotencyPayloadConflict()
            }
            assertUsdOrderCurrency(existing.currency, "Existing order")
            return projectExternalOrder(existing, "CUSTOMER")
          }
        }

        if (data.campaignId) {
          const campaign = await tx.campaign.findFirst({
            where: {
              id: data.campaignId,
              organizationId: data.organizationId,
            },
            select: { id: true },
          })
          if (!campaign) {
            throw new BadRequestException({
              code: "CAMPAIGN_NOT_FOUND",
              message: "Campaign is unavailable for this organization",
            })
          }
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
          warrantyDays: number | null
          revisionRounds: number | null
          snapshotPrice: Prisma.Decimal | null
          snapshotCurrency: string | null
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
          warrantyDays: null,
          revisionRounds: null,
          snapshotPrice: null,
          snapshotCurrency: null,
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
              message:
                "Website ownership is revoked and cannot take new orders",
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
          const quoteFields = [
            data.expectedListingServiceVersion,
            data.expectedPrice,
            data.expectedCurrency,
          ]
          if (quoteFields.some((value) => value !== undefined)) {
            const expectedVersion = Number(data.expectedListingServiceVersion)
            const normalizedExpectedPrice = normalizePositiveUsdMoney(
              data.expectedPrice,
            )
            if (!normalizedExpectedPrice) {
              throw new BadRequestException({
                code: "QUOTE_INVALID",
                message: "The reviewed service quote is invalid",
              })
            }
            const expectedPrice = new Prisma.Decimal(normalizedExpectedPrice)
            const expectedCurrency = data.expectedCurrency
            if (
              !Number.isInteger(expectedVersion) ||
              !isSupportedMoneyCurrency(expectedCurrency)
            ) {
              throw new BadRequestException({
                code: "QUOTE_INVALID",
                message: "The reviewed service quote is invalid",
              })
            }
            if (
              expectedVersion !== ls.version ||
              !expectedPrice.equals(ls.price) ||
              expectedCurrency !== ls.currency
            ) {
              throw new ConflictException({
                code: "REQUOTE_REQUIRED",
                message:
                  "The service price or terms changed. Review the updated quote before ordering.",
                quote: {
                  version: ls.version,
                  price: ls.price.toString(),
                  currency: ls.currency,
                },
              })
            }
          }
          snapshot = {
            listingId: ls.listingId,
            listingServiceId: ls.id,
            fulfillmentChannel:
              ls.listing.ownerType === "PLATFORM" ? "PLATFORM" : "PUBLISHER",
            turnaroundDays: ls.turnaroundDays,
            warrantyDays: ls.warrantyDays,
            revisionRounds: ls.revisionRounds,
            snapshotPrice: requirePositiveUsdDecimal(
              ls.price,
              "Selected listing service price",
            ),
            snapshotCurrency: ls.currency,
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
                warrantyDays: ls.warrantyDays,
                revisionRounds: ls.revisionRounds,
                snapshotPrice: requirePositiveUsdDecimal(
                  ls.price,
                  "Selected listing service price",
                ),
                snapshotCurrency: ls.currency,
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
        // through without one. Pre-snapshot database rows intentionally remain
        // unverified rather than being reconstructed from today's catalog.
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
        assertUsdOrderCurrency(
          snapshot.snapshotCurrency,
          "Selected listing service",
        )

        // ── Phase 6: validate the per-service brief ────────────────────────
        // The snapshot serviceType is the authoritative discriminator — we
        // refuse to validate against a different serviceType than the one
        // the customer's listing pick locked in. If the client omitted
        // briefData entirely we accept that (Phase 6 keeps it optional);
        // shape/typing validation happens via Zod and any ZodError surfaces
        // as a 400 with the field path.
        let validatedBrief: Prisma.InputJsonValue | null = null
        if (data.briefData === undefined || data.briefData === null) {
          throw new BadRequestException({
            code: "BRIEF_REQUIRED",
            message: "A structured service brief is required",
          })
        } else {
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

        const briefRecord =
          validatedBrief && typeof validatedBrief === "object"
            ? (validatedBrief as Record<string, unknown>)
            : {}
        const canonicalTargetUrl =
          typeof briefRecord.targetUrl === "string"
            ? briefRecord.targetUrl
            : (data.targetUrl ?? firstItem?.targetUrl ?? null)
        const canonicalAnchorText =
          typeof briefRecord.anchorText === "string"
            ? briefRecord.anchorText
            : (data.anchorText ?? firstItem?.anchorText ?? null)

        let article:
          | {
              title: string | null
              body: string
              format: "PLAIN_TEXT" | "MARKDOWN"
            }
          | undefined
        if (data.articleBody !== undefined && data.articleBody !== null) {
          if (snapshot.snapshotServiceType !== "GUEST_POST") {
            throw new BadRequestException({
              code: "ARTICLE_NOT_SUPPORTED",
              message:
                "Customer-supplied articles are supported only for guest-post orders",
            })
          }
          if (typeof data.articleBody !== "string") {
            throw new BadRequestException("Article body must be text")
          }
          const body = data.articleBody.trim()
          if (body.length === 0 || body.length > 200_000) {
            throw new BadRequestException(
              "Article body must be between 1 and 200,000 characters",
            )
          }
          const title =
            data.articleTitle === undefined || data.articleTitle === null
              ? null
              : typeof data.articleTitle === "string"
                ? data.articleTitle.trim()
                : null
          if (data.articleTitle != null && title === null) {
            throw new BadRequestException("Article title must be text")
          }
          if (title && title.length > 200) {
            throw new BadRequestException(
              "Article title must be 200 characters or fewer",
            )
          }
          const format =
            data.articleFormat === undefined
              ? "MARKDOWN"
              : data.articleFormat === "MARKDOWN" ||
                  data.articleFormat === "PLAIN_TEXT"
                ? data.articleFormat
                : null
          if (!format) {
            throw new BadRequestException("Unsupported article format")
          }
          article = { title: title || null, body, format }
        }

        // A listing-service purchase always represents at least one placement.
        // Keep the full calculation in Decimal space: converting a catalog
        // Decimal to a JavaScript number can silently introduce sub-cent drift.
        const orderItems =
          data.items && data.items.length > 0 ? data.items : [{}]
        const itemPrice = requirePositiveUsdDecimal(
          snapshot.snapshotPrice,
          "Selected listing service price",
        )
        const total = itemPrice.mul(orderItems.length)

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
            requestFingerprint,
            websiteId: snapshot.websiteId,
            targetUrl: canonicalTargetUrl,
            anchorText: canonicalAnchorText,
            status: "DRAFT",
            paymentStatus: "PENDING",
            amount: total,
            currency: USD_CURRENCY,
            // Phase 2 snapshot columns — see the resolveSnapshot block above.
            listingId: snapshot.listingId,
            listingServiceId: snapshot.listingServiceId,
            fulfillmentChannel: snapshot.fulfillmentChannel,
            turnaroundDays: snapshot.turnaroundDays,
            warrantyDays: snapshot.warrantyDays,
            revisionRoundsSnapshot: snapshot.revisionRounds,
            // Phase 6: structured brief, validated above against the registry.
            briefData: validatedBrief ?? Prisma.JsonNull,
          },
        })

        const articleVersion = article
          ? await tx.orderArticleVersion.create({
              data: {
                orderId: order.id,
                version: 1,
                source: "CUSTOMER",
                purpose: "SOURCE_ARTICLE",
                title: article.title,
                body: article.body,
                format: article.format,
                checksum: createHash("sha256")
                  .update(article.body, "utf8")
                  .digest("hex"),
                wordCount: article.body.split(/\s+/).filter(Boolean).length,
                createdByUserId: userId,
              },
            })
          : null

        for (const item of orderItems) {
          if (
            item.websiteId &&
            snapshot.websiteId &&
            item.websiteId !== snapshot.websiteId
          ) {
            throw new BadRequestException(
              "Item websiteId does not match the selected service",
            )
          }
          // Use tx (not this.prisma) — a separate connection here while the
          // transaction holds its own deadlocks the pool under concurrency.
          if (snapshot.websiteId) {
            // Block orders on a revoked domain — defence in depth beyond listing
            // pause (a REVOKED publisher site may never take new orders).
            const site = await tx.website.findUnique({
              where: { id: snapshot.websiteId },
              select: { verificationStatus: true, ownershipType: true },
            })
            if (
              site?.ownershipType === "PUBLISHER" &&
              site.verificationStatus === "REVOKED"
            ) {
              throw new BadRequestException({
                code: "WEBSITE_REVOKED",
                message: `Website ${snapshot.websiteId} ownership is revoked and cannot take new orders`,
              })
            }
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
              websiteId: snapshot.websiteId,
              targetUrl: canonicalTargetUrl,
              anchorText: canonicalAnchorText,
              price: itemPrice,
              status: "PENDING_PAYMENT",
            },
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
          await tx.order.update({
            where: { id: order.id },
            data: { assigneeId: snapshot.managedByUserId },
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

        if (articleVersion) {
          await tx.orderEvent.create({
            data: {
              orderId: order.id,
              eventType: "CONTENT_SUBMITTED",
              actorId: userId,
              message: "Customer supplied a source article with the order",
              metadata: {
                articleVersionId: articleVersion.id,
                source: "CUSTOMER",
                purpose: "SOURCE_ARTICLE",
                version: articleVersion.version,
                checksum: articleVersion.checksum,
                wordCount: articleVersion.wordCount,
              },
            },
          })
        }

        return projectExternalOrder(
          await tx.order.findUniqueOrThrow({
            where: { id: order.id },
            include: CREATE_ORDER_RESULT_INCLUDE,
          }),
          "CUSTOMER",
        )
      })
    } catch (error) {
      // Two requests can both miss the pre-read and race on the tenant-scoped
      // unique key. PostgreSQL chooses one winner; the loser re-reads that row
      // and may replay it only when the cryptographic payload binding matches.
      if (data.idempotencyKey && isUniqueViolation(error)) {
        const winner = await this.prisma.order.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: data.organizationId,
              idempotencyKey: data.idempotencyKey,
            },
          },
          include: CREATE_ORDER_RESULT_INCLUDE,
        })
        if (winner) {
          if (winner.requestFingerprint !== requestFingerprint) {
            throwIdempotencyPayloadConflict()
          }
          assertUsdOrderCurrency(winner.currency, "Existing order")
          return projectExternalOrder(winner, "CUSTOMER")
        }
      }
      throw error
    }
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
    actorRole: string | null | undefined,
  ) {
    return this.runLockedCartTransaction(orderId, async (tx: any) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, organizationId },
      })
      if (!order) throw new NotFoundException("Order not found")
      assertOwnerOrCreator({
        customerId: order.customerId,
        actorUserId: userId,
        actorRole,
        action: "add items to this order",
      })
      if (order.status !== "DRAFT" || order.paymentStatus !== "PENDING") {
        throw new BadRequestException(
          "Can only add items to an unpaid draft order",
        )
      }
      assertUsdOrderCurrency(order.currency, "Order")

      // Contract attribution is immutable from Order creation onward. The
      // previous legacy branch tried to fill websiteId during an item write,
      // which now (correctly) violates the database snapshot guard.
      if (!order.websiteId) {
        throw new ConflictException({
          code: "ORDER_WEBSITE_SNAPSHOT_MISSING",
          message:
            "Order has no immutable website snapshot. Recreate it from the marketplace listing.",
        })
      }

      const websiteId = data.websiteId ?? order.websiteId

      const existingItems = await tx.orderItem.findMany({
        where: { orderId },
        select: { websiteId: true },
      })
      const existingWebsiteId =
        order.websiteId ??
        existingItems.find((i: any) => i.websiteId)?.websiteId ??
        null
      if (existingItems.length > 0 && websiteId !== existingWebsiteId) {
        throw new BadRequestException(
          "All items in an order must target the same website. Create a separate order for a different website.",
        )
      }

      if (!order.listingServiceId) {
        throw new BadRequestException(
          "Order has no listingServiceId — recreate with the new flow",
        )
      }
      const ls = await tx.listingService.findUnique({
        where: { id: order.listingServiceId },
        select: { price: true, availability: true, currency: true },
      })
      if (!ls) {
        throw new BadRequestException(
          "Order's listing service no longer exists",
        )
      }
      if (ls.availability !== "AVAILABLE") {
        throw new BadRequestException("Order's service is not available")
      }
      assertUsdOrderCurrency(ls.currency, "Order's listing service")
      const price = requirePositiveUsdDecimal(
        ls.price,
        "Order's listing service price",
      )

      const item = await tx.orderItem.create({
        data: {
          orderId,
          websiteId,
          targetUrl: data.targetUrl,
          anchorText: data.anchorText,
          price,
          status: "PENDING_PAYMENT",
        },
      })

      const aggregate = await tx.orderItem.aggregate({
        where: { orderId },
        _sum: { price: true },
      })
      const total = requirePositiveUsdDecimal(
        aggregate._sum.price,
        "Order item total",
      )
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          version: order.version,
          status: "DRAFT",
          paymentStatus: "PENDING",
        },
        data: {
          amount: total,
          version: { increment: 1 },
        },
      })
      if (updated.count !== 1) {
        throw new ConflictException(
          "Order was modified by another request. Refresh and retry.",
        )
      }

      await tx.orderEvent.create({
        data: {
          orderId,
          eventType: "ITEM_ADDED",
          actorId: userId,
          message: "Item added to order",
          metadata: {
            itemId: item.id,
            websiteId,
            price: price.toFixed(2),
          },
        },
      })

      return item
    })
  }

  async removeOrderItem(
    orderId: string,
    itemId: string,
    organizationId: string,
    userId: string,
    actorRole: string | null | undefined,
  ) {
    return this.runLockedCartTransaction(orderId, async (tx: any) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, organizationId },
      })
      if (!order) throw new NotFoundException("Order not found")
      assertOwnerOrCreator({
        customerId: order.customerId,
        actorUserId: userId,
        actorRole,
        action: "remove items from this order",
      })
      if (order.status !== "DRAFT" || order.paymentStatus !== "PENDING") {
        throw new BadRequestException(
          "Can only remove items from an unpaid draft order",
        )
      }
      assertUsdOrderCurrency(order.currency, "Order")
      if (!order.websiteId) {
        throw new ConflictException({
          code: "ORDER_WEBSITE_SNAPSHOT_MISSING",
          message:
            "Order has no immutable website snapshot. Recreate it from the marketplace listing.",
        })
      }

      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: { id: true },
      })
      if (!items.some((item: any) => item.id === itemId)) {
        throw new NotFoundException("Item not found")
      }
      if (items.length <= 1) {
        throw new BadRequestException({
          code: "ORDER_REQUIRES_ITEM",
          message: "An order must retain at least one priced placement item",
        })
      }

      await tx.orderItem.delete({ where: { id: itemId } })

      const aggregate = await tx.orderItem.aggregate({
        where: { orderId },
        _sum: { price: true },
      })
      const total = requirePositiveUsdDecimal(
        aggregate._sum.price,
        "Order item total",
      )
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          version: order.version,
          status: "DRAFT",
          paymentStatus: "PENDING",
        },
        data: {
          amount: total,
          version: { increment: 1 },
        },
      })
      if (updated.count !== 1) {
        throw new ConflictException(
          "Order was modified by another request. Refresh and retry.",
        )
      }

      return { success: true }
    })
  }

  // organizationId is null for publisher callers — OrderOwnershipGuard has
  // already verified the order's website belongs to their publisher account,
  // and a null org filter is a Prisma validation error (500), not a no-op.
  async getOrder(
    id: string,
    organizationId?: string | null,
    actor: "CUSTOMER" | "PUBLISHER" = "CUSTOMER",
  ) {
    const order = await this.prisma.order.findFirst({
      where: organizationId ? { id, organizationId } : { id },
      include: {
        items: { include: { publications: true } },
        events: { orderBy: { createdAt: "desc" } },
        contentOrder: true,
        articleVersions: {
          orderBy: [{ purpose: "asc" }, { version: "desc" }],
          select: {
            id: true,
            version: true,
            source: true,
            purpose: true,
            title: true,
            body: true,
            format: true,
            checksum: true,
            wordCount: true,
            createdByUserId: true,
            supersedesId: true,
            createdAt: true,
          },
        },
        revisions: true,
        reports: true,
        website: true,
        settlements: { include: { approvals: true } },
        dispute: true,
        cancellationRequests: { orderBy: { createdAt: "desc" } },
      },
    })
    if (!order) throw new NotFoundException(`Order ${id} not found`)
    if (
      actor === "PUBLISHER" &&
      (order.status === "DRAFT" || order.status === "PENDING_PAYMENT")
    ) {
      throw new NotFoundException(`Order ${id} not found`)
    }
    const websiteUnlocked =
      actor === "PUBLISHER" ||
      (await canCustomerViewWebsite(this.prisma, organizationId))
    return projectExternalOrder(order, actor, websiteUnlocked)
  }

  async listOrders(
    organizationId: string,
    filters: {
      campaignId?: string
      serviceType?: ServiceType
      statuses?: OrderStatus[]
      search?: string
      needsAction?: boolean
      actionableCustomerId?: string
      sort?: "priority" | "deadline" | "newest" | "value"
      take?: number
      skip?: number
    } = {},
  ) {
    const take = filters.take ?? 50
    const skip = filters.skip ?? 0
    const where: Prisma.OrderWhereInput = {
      organizationId,
      ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      ...(filters.serviceType ? { type: filters.serviceType } : {}),
      ...(filters.statuses?.length ? { status: { in: filters.statuses } } : {}),
    }

    const constraints: Prisma.OrderWhereInput[] = []
    if (filters.search) {
      constraints.push({
        OR: [
          { id: { contains: filters.search, mode: "insensitive" } },
          { title: { contains: filters.search, mode: "insensitive" } },
          {
            website: {
              is: { url: { contains: filters.search, mode: "insensitive" } },
            },
          },
          {
            campaign: {
              is: { name: { contains: filters.search, mode: "insensitive" } },
            },
          },
        ],
      })
    }
    if (filters.needsAction) {
      constraints.push({
        ...(filters.actionableCustomerId
          ? { customerId: filters.actionableCustomerId }
          : {}),
        OR: [
          {
            status: {
              in: [
                OrderStatus.DRAFT,
                OrderStatus.PENDING_PAYMENT,
                OrderStatus.CUSTOMER_REVIEW,
                OrderStatus.VERIFIED,
              ],
            },
          },
          {
            cancellationRequests: {
              some: {
                status: "REQUESTED",
                requesterType: { not: "CUSTOMER" },
              },
            },
          },
        ],
      })
    }
    if (constraints.length) where.AND = constraints

    const orderBy: Prisma.OrderOrderByWithRelationInput[] =
      filters.sort === "deadline"
        ? [{ fulfillmentDueAt: "asc" }, { updatedAt: "desc" }]
        : filters.sort === "value"
          ? [{ amount: "desc" }, { createdAt: "desc" }]
          : filters.sort === "priority"
            ? [
                { autoAcceptAt: { sort: "asc", nulls: "last" } },
                { fulfillmentDueAt: { sort: "asc", nulls: "last" } },
                { updatedAt: "desc" },
              ]
            : [{ createdAt: "desc" }]
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy,
        take,
        skip,
        include: {
          items: true,
          website: true,
          campaign: true,
          settlements: { include: { approvals: true } },
          dispute: true,
          cancellationRequests: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      this.prisma.order.count({ where }),
    ])
    const websiteUnlocked = await canCustomerViewWebsite(
      this.prisma,
      organizationId,
    )
    return {
      items: items.map((order) =>
        projectExternalOrder(order, "CUSTOMER", websiteUnlocked),
      ),
      total,
      take,
      skip,
    }
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
          cancellationRequests: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      this.prisma.order.count({ where }),
    ])
    return {
      items: items.map((order) => projectExternalOrder(order, "PUBLISHER")),
      total,
      take,
      skip,
    }
  }
}
