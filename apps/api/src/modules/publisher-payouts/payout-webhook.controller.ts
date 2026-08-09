import {
  createHash,
  createHmac,
  createVerify,
  timingSafeEqual,
} from "node:crypto"
import {
  assertWebhookTimestampFresh,
  normalizeProviderWebhook,
  WebhookTimestampError,
} from "@guestpost/shared"
import { isPrismaUniqueConstraintError } from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  Logger,
  Param,
  Post,
  type RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { Request } from "express"
import { Public } from "../../common/decorators/public.decorator"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import { PrismaService } from "../../common/prisma.service"
import { assertStripeObjectMode } from "../../common/stripe-client"
import { WorkerWakeupService } from "../queues/worker-wakeup.service"
import { StripeConnectService } from "./stripe-connect.service"

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300
const ACCOUNT_SYNC_LEASE_MS = 15 * 60 * 1000
const ACCOUNT_SYNC_RETRY_DELAY_MS = 30 * 1000
const STRIPE_PLATFORM_PAYOUT_EVENT_TYPES = new Set([
  "transfer.created",
  "transfer.updated",
  "transfer.reversed",
])
const STRIPE_CONNECTED_PAYOUT_EVENT_TYPES = new Set([
  "account.updated",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
])

type StripePayoutWebhookChannel = "platform" | "connected"

@Controller("payout-webhooks")
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly workerWakeup: WorkerWakeupService,
    private readonly stripeConnect?: StripeConnectService,
  ) {}

  // Stripe platform and connected-account destinations are separate trust
  // domains. Never accept both signing secrets on one route: an event's
  // untrusted `account` field cannot be allowed to widen signature authority.
  @Public()
  @Post("stripe_connect/platform")
  handleStripePlatformWebhook(
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.handleVerifiedWebhook(
      "stripe_connect",
      headers,
      req,
      "platform",
    )
  }

  @Public()
  @Post("stripe_connect/connected")
  handleStripeConnectedWebhook(
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.handleVerifiedWebhook(
      "stripe_connect",
      headers,
      req,
      "connected",
    )
  }

  // Public: providers cannot authenticate with a session — the cryptographic
  // signature check below is the authentication for this route. The legacy
  // one-segment Stripe route is intentionally retired; Wise retains it.
  @Public()
  @Post(":provider")
  handleWebhook(
    @Param("provider") provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (provider === "stripe_connect") {
      throw new BadRequestException("Stripe payout webhook channel is required")
    }
    return this.handleVerifiedWebhook(provider, headers, req)
  }

  private async handleVerifiedWebhook(
    provider: string,
    headers: Record<string, string>,
    req: RawBodyRequest<Request>,
    stripeChannel?: StripePayoutWebhookChannel,
  ) {
    // The generated Prisma client is intentionally gitignored and regenerated
    // during the database build. Keep this controller compilable in a fresh
    // checkout before generation while the schema remains authoritative.
    const payoutWebhookEvent = (this.prisma as any).payoutWebhookEvent
    if (!["wise", "stripe_connect"].includes(provider)) {
      throw new BadRequestException("Unsupported provider")
    }

    const rawBody = req.rawBody
    if (!rawBody) {
      throw new BadRequestException("Missing request body")
    }

    // Fail closed: a payload that cannot be cryptographically attributed to
    // the provider never reaches the queue. Forged callbacks must not be able
    // to flip payout state (COMPLETED inflates lifetimePaid; FAILED invites a
    // manual retry and a second real transfer).
    if (provider === "stripe_connect") {
      if (!stripeChannel) {
        throw new BadRequestException(
          "Stripe payout webhook channel is required",
        )
      }
      this.verifyStripeSignature(
        rawBody,
        headers["stripe-signature"],
        stripeChannel,
      )
    } else {
      this.verifyWiseSignature(rawBody, headers["x-signature-sha256"])
    }

    let body: any
    try {
      body = JSON.parse(rawBody.toString("utf8"))
    } catch {
      throw new BadRequestException("Invalid JSON body")
    }

    const eventType = body.type ?? body.event_type ?? body.event ?? "unknown"

    if (provider === "stripe_connect") {
      this.validateStripeChannelEnvelope(body, stripeChannel!)
      try {
        assertStripeObjectMode(body.livemode, "Stripe payout webhook Event")
      } catch {
        throw new BadRequestException(
          "Stripe event mode does not match API key",
        )
      }
    }

    const isStripeAccountUpdated =
      provider === "stripe_connect" && eventType === "account.updated"
    const stripeAccountId = isStripeAccountUpdated
      ? this.validStripeAccountId(body.data?.object?.id)
      : null
    if (isStripeAccountUpdated && (!stripeAccountId || !this.stripeConnect)) {
      throw new BadRequestException("Invalid Stripe account event")
    }

    // Wise webhook timestamp replay protection — mirrors Stripe's 5-minute
    // tolerance, checked after body parse because Wise puts the timestamp
    // in the body (occurred_at) rather than a header.
    if (provider === "wise") {
      const ts = body.occurred_at ?? body.timestamp ?? body.event_time
      try {
        assertWebhookTimestampFresh(ts, STRIPE_TIMESTAMP_TOLERANCE_SECONDS)
      } catch (err) {
        const msg =
          err instanceof WebhookTimestampError
            ? err.message
            : "Wise webhook timestamp outside tolerance"
        throw new UnauthorizedException(msg)
      }
    }

    // Normalize once at the trust boundary and persist only allow-listed
    // fields. Raw payout payloads/signature headers never enter Redis or the
    // database. The database commit, not a best-effort worker wake-up, is the
    // acknowledgement boundary returned to the provider.
    const normalized = normalizeProviderWebhook(provider, body)
    const providerExecutionId = isStripeAccountUpdated
      ? null
      : this.boundedText(normalized.providerExecutionId, 191)
    const providerAccountExternalId =
      provider === "stripe_connect"
        ? isStripeAccountUpdated
          ? stripeAccountId
          : this.boundedText(body.account, 191)
        : null

    if (
      !providerExecutionId &&
      !isStripeAccountUpdated &&
      (provider === "stripe_connect" || provider === "wise")
    ) {
      // Signature already passed, so retain the normalized event for audit and
      // drift visibility. The inbox processor will mark it ignored safely.
      this.logger.warn(
        `unable to derive payout webhook dedup key (provider=${provider} eventType=${eventType})`,
      )
    }

    const providerEventId = body.id ?? body.event_id ?? body.eventId ?? null
    const dedupSource = providerEventId
      ? `event:${String(providerEventId)}`
      : `payload:${createHash("sha256").update(rawBody).digest("hex")}`
    const dedupKey = createHash("sha256").update(dedupSource).digest("hex")
    const safeEventType = this.boundedText(eventType, 191) ?? "unknown"
    const safeRawStatus = this.boundedText(normalized.rawStatus, 100)

    const immutableEnvelope = {
      eventType: safeEventType,
      providerExecutionId,
      providerAccountExternalId,
      livemode: provider === "stripe_connect" ? body.livemode : null,
      payoutAmountMinor: isStripeAccountUpdated
        ? null
        : normalized.payoutAmountMinor,
      payoutCurrency: isStripeAccountUpdated ? null : normalized.payoutCurrency,
      providerStatus: isStripeAccountUpdated ? null : normalized.status,
      rawStatus: isStripeAccountUpdated ? null : safeRawStatus,
    }
    const immutableEnvelopeSelect = {
      id: true,
      eventType: true,
      providerExecutionId: true,
      providerAccountExternalId: true,
      livemode: true,
      payoutAmountMinor: true,
      payoutCurrency: true,
      providerStatus: true,
      rawStatus: true,
    } as const
    let inboxEvent: { id: string }
    let duplicate = false
    try {
      inboxEvent = await payoutWebhookEvent.create({
        data: {
          provider,
          dedupKey,
          ...immutableEnvelope,
        },
        select: { id: true },
      })
    } catch (error: any) {
      if (!isPrismaUniqueConstraintError(error)) throw error
      duplicate = true
      const existing = await payoutWebhookEvent.findUnique({
        where: { provider_dedupKey: { provider, dedupKey } },
        select: immutableEnvelopeSelect,
      })
      if (!existing) throw error
      if (!this.sameImmutableEnvelope(existing, immutableEnvelope)) {
        await this.quarantineIdentityCollision({
          eventId: existing.id,
          provider,
          dedupKey,
          incoming: immutableEnvelope,
        })
        throw new ConflictException(
          "Provider event identity conflicts with previously verified evidence",
        )
      }
      inboxEvent = existing
    }

    if (isStripeAccountUpdated) {
      await this.processStripeAccountUpdatedEvent(
        inboxEvent.id,
        stripeAccountId!,
      )
      this.logger.log(
        `Verified Stripe account webhook durably processed (duplicate=${duplicate})`,
      )
      return {
        received: true,
        eventId: inboxEvent.id,
        duplicate,
        accountSynced: true,
      }
    }

    // Do not await external orchestration before returning 2xx. The committed
    // inbox row is durable and the 10-minute catch-up job guarantees recovery.
    void this.workerWakeup.wake("payout-webhook")
    this.logger.log(
      `Verified payout webhook durably accepted (provider=${provider} duplicate=${duplicate})`,
    )
    return { received: true, eventId: inboxEvent.id, duplicate }
  }

  private validStripeAccountId(value: unknown): string | null {
    if (
      typeof value !== "string" ||
      value.length > 191 ||
      !/^acct_[A-Za-z0-9]+$/.test(value)
    ) {
      return null
    }
    return value
  }

  private validateStripeChannelEnvelope(
    body: any,
    channel: StripePayoutWebhookChannel,
  ): void {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("Invalid Stripe event envelope")
    }
    const eventType = typeof body.type === "string" ? body.type : ""
    const object = body.data?.object
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      throw new BadRequestException("Invalid Stripe event object")
    }

    if (channel === "platform") {
      if (!STRIPE_PLATFORM_PAYOUT_EVENT_TYPES.has(eventType)) {
        throw new BadRequestException(
          "Unsupported Stripe platform payout event",
        )
      }
      if (Object.hasOwn(body, "account")) {
        throw new BadRequestException(
          "Stripe platform payout events must not include an account",
        )
      }
      if (
        typeof object.id !== "string" ||
        !/^tr_[A-Za-z0-9]+$/.test(object.id)
      ) {
        throw new BadRequestException("Invalid Stripe transfer event")
      }
      return
    }

    if (!STRIPE_CONNECTED_PAYOUT_EVENT_TYPES.has(eventType)) {
      throw new BadRequestException(
        "Unsupported Stripe connected-account payout event",
      )
    }
    const accountId = this.validStripeAccountId(body.account)
    if (!accountId) {
      throw new BadRequestException(
        "Stripe connected-account event requires a valid account",
      )
    }
    if (eventType === "account.updated") {
      if (object.id !== accountId) {
        throw new BadRequestException(
          "Stripe account event does not match its connected account",
        )
      }
      return
    }
    if (typeof object.id !== "string" || !/^po_[A-Za-z0-9]+$/.test(object.id)) {
      throw new BadRequestException("Invalid Stripe payout event")
    }
    const requiredStatus =
      eventType === "payout.paid"
        ? "paid"
        : eventType === "payout.failed"
          ? "failed"
          : eventType === "payout.canceled"
            ? "canceled"
            : null
    if (requiredStatus && object.status !== requiredStatus) {
      throw new BadRequestException(
        "Stripe payout event type does not match object status",
      )
    }
  }

  /**
   * Account metadata changes are not payout-completion evidence, but they can
   * change routing eligibility and the provider's payout schedule. Persist the
   * signed envelope first, then claim it under the recovery gate before making
   * any Stripe or local routing mutation. A non-2xx response deliberately asks
   * Stripe to redeliver; the durable row makes every failed/stuck delivery
   * visible without letting the generic payout-completion worker consume it.
   */
  private async processStripeAccountUpdatedEvent(
    eventId: string,
    accountId: string,
  ): Promise<void> {
    // A fully processed exact replay is inbound evidence only and must remain
    // a 2xx no-op even during an incident lock. Every nonterminal state can
    // cause provider/local mutation and therefore crosses the recovery gate.
    const snapshot = await (this.prisma as any).payoutWebhookEvent.findUnique({
      where: { id: eventId },
      select: { status: true },
    })
    if (snapshot?.status === "PROCESSED") return

    assertApiFinanceOperationAllowed("recovery")

    const now = new Date()
    const leaseCutoff = new Date(now.getTime() - ACCOUNT_SYNC_LEASE_MS)
    const claim = await this.prisma.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
          eventId,
        )
        let current = await tx.payoutWebhookEvent.findUnique({
          where: { id: eventId },
          select: {
            status: true,
            attempts: true,
            availableAt: true,
            lockedAt: true,
          },
        })
        if (!current) {
          throw new ServiceUnavailableException(
            "Stripe account event evidence is unavailable",
          )
        }
        if (current.status === "PROCESSED") return null
        if (current.status === "IGNORED" || current.status === "QUARANTINED") {
          throw new ConflictException(
            "Stripe account event is in a terminal evidence state",
          )
        }
        if (current.status === "PROCESSING") {
          if (current.lockedAt && current.lockedAt >= leaseCutoff) {
            throw new ServiceUnavailableException(
              "Stripe account event is already processing",
            )
          }
          await tx.payoutWebhookEvent.update({
            where: { id: eventId },
            data: {
              status: "FAILED",
              lockedAt: null,
              processedAt: null,
              availableAt: now,
              lastError: "StaleAccountSyncLeaseRecovered",
            },
          })
          current = {
            ...current,
            status: "FAILED",
            availableAt: now,
            lockedAt: null,
          }
        }
        if (
          current.status === "FAILED" &&
          current.availableAt instanceof Date &&
          current.availableAt > now
        ) {
          throw new ServiceUnavailableException(
            "Stripe account event retry is not ready",
          )
        }
        if (!Number.isSafeInteger(current.attempts) || current.attempts < 0) {
          throw new ServiceUnavailableException(
            "Stripe account event attempt state is invalid",
          )
        }

        const result = await tx.payoutWebhookEvent.updateMany({
          where: {
            id: eventId,
            status: { in: ["PENDING", "FAILED"] },
            availableAt: { lte: now },
          },
          data: {
            status: "PROCESSING",
            lockedAt: now,
            processedAt: null,
            attempts: { increment: 1 },
            lastError: null,
          },
        })
        if (result.count !== 1) {
          throw new ServiceUnavailableException(
            "Stripe account event claim was lost",
          )
        }
        return {
          attempt: current.attempts + 1,
          lockedAt: now,
        }
      },
      { isolationLevel: "Serializable" },
    )
    if (!claim) return

    try {
      await this.stripeConnect!.syncAccount(accountId, {
        source: "webhook",
        payoutWebhookEventId: eventId,
        claimAttempt: claim.attempt,
        claimLockedAt: claim.lockedAt.toISOString(),
      })
      await this.prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
          eventId,
        )
        const completed = await tx.payoutWebhookEvent.updateMany({
          where: {
            id: eventId,
            status: "PROCESSING",
            attempts: claim.attempt,
            lockedAt: claim.lockedAt,
          },
          data: {
            status: "PROCESSED",
            lockedAt: null,
            processedAt: new Date(),
            lastError: null,
          },
        })
        if (completed.count === 1) return
        throw new Error("Stripe account event completion claim was lost")
      })
    } catch (error) {
      await (this.prisma as any).payoutWebhookEvent.updateMany({
        where: {
          id: eventId,
          status: "PROCESSING",
          attempts: claim.attempt,
          lockedAt: claim.lockedAt,
        },
        data: {
          status: "FAILED",
          lockedAt: null,
          processedAt: null,
          availableAt: new Date(Date.now() + ACCOUNT_SYNC_RETRY_DELAY_MS),
          lastError: this.safeErrorName(error),
        },
      })
      this.logger.error("Stripe account webhook processing failed", {
        eventId,
        error: this.safeErrorName(error),
      })
      throw new ServiceUnavailableException(
        "Stripe account update could not be applied; retry delivery",
      )
    }
  }

  private safeErrorName(error: unknown): string {
    return (error instanceof Error ? error.name : "UnknownError").slice(0, 100)
  }

  private boundedText(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null
    return value.slice(0, maxLength)
  }

  private sameImmutableEnvelope(
    existing: {
      eventType: string
      providerExecutionId: string | null
      providerAccountExternalId: string | null
      livemode: boolean | null
      payoutAmountMinor: bigint | null
      payoutCurrency: string | null
      providerStatus: string | null
      rawStatus: string | null
    },
    incoming: {
      eventType: string
      providerExecutionId: string | null
      providerAccountExternalId: string | null
      livemode: boolean | null
      payoutAmountMinor: bigint | null
      payoutCurrency: string | null
      providerStatus: string | null
      rawStatus: string | null
    },
  ): boolean {
    return (
      existing.eventType === incoming.eventType &&
      existing.providerExecutionId === incoming.providerExecutionId &&
      existing.providerAccountExternalId ===
        incoming.providerAccountExternalId &&
      existing.livemode === incoming.livemode &&
      existing.payoutAmountMinor === incoming.payoutAmountMinor &&
      existing.payoutCurrency === incoming.payoutCurrency &&
      existing.providerStatus === incoming.providerStatus &&
      existing.rawStatus === incoming.rawStatus
    )
  }

  private async quarantineIdentityCollision(params: {
    eventId: string
    provider: string
    dedupKey: string
    incoming: {
      eventType: string
      providerExecutionId: string | null
      providerAccountExternalId: string | null
      livemode: boolean | null
      payoutAmountMinor: bigint | null
      payoutCurrency: string | null
      providerStatus: string | null
      rawStatus: string | null
    }
  }) {
    await this.prisma.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
          params.eventId,
        )
        const existing = await tx.payoutWebhookEvent.findUnique({
          where: { id: params.eventId },
          select: {
            id: true,
            status: true,
            processedAt: true,
            lastError: true,
            eventType: true,
            providerExecutionId: true,
            providerAccountExternalId: true,
            livemode: true,
            payoutAmountMinor: true,
            payoutCurrency: true,
            providerStatus: true,
            rawStatus: true,
            completedExecution: {
              select: {
                id: true,
                status: true,
                completionSource: true,
              },
            },
          },
        })
        if (!existing) {
          throw new Error(
            "Payout webhook evidence disappeared during collision quarantine",
          )
        }
        if (this.sameImmutableEnvelope(existing, params.incoming)) return
        if (
          existing.status === "QUARANTINED" &&
          existing.lastError === "DuplicateIdentityPayloadMismatch"
        ) {
          return
        }

        // A processed event linked to a completed execution is immutable
        // settlement evidence. A later verified payload collision is an
        // incident signal, but must not rewrite the canonical event and make
        // its completion link fail at commit.
        const canonicalCompletionRetained =
          existing.status === "PROCESSED" &&
          existing.completedExecution?.status === "COMPLETED" &&
          existing.completedExecution.completionSource === "PROVIDER_WEBHOOK"

        if (!canonicalCompletionRetained && existing.status !== "QUARANTINED") {
          await tx.payoutWebhookEvent.update({
            where: { id: existing.id },
            data: {
              status: "QUARANTINED",
              lockedAt: null,
              processedAt: ["PROCESSED", "IGNORED"].includes(existing.status)
                ? existing.processedAt
                : new Date(),
              lastError: "DuplicateIdentityPayloadMismatch",
            },
          })
        }
        const staff = await tx.staffMembership.findMany({
          where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
          select: { userId: true },
        })
        if (staff.length > 0) {
          await tx.notification.createMany({
            data: staff.map((member: { userId: string }) => ({
              userId: member.userId,
              organizationId: null,
              type: "PAYOUT_WEBHOOK_IDENTITY_CONFLICT",
              message: `Verified payout webhook identity conflict for inbox event ${existing.id}`,
              dedupKey: `payout-webhook-identity-conflict:${existing.id}:${member.userId}`,
            })),
            skipDuplicates: true,
          })
        }
        await tx.auditLog.create({
          data: {
            action: canonicalCompletionRetained
              ? "PAYOUT_WEBHOOK_IDENTITY_CONFLICT_DETECTED"
              : "PAYOUT_WEBHOOK_IDENTITY_CONFLICT_QUARANTINED",
            entityType: "PayoutWebhookEvent",
            entityId: existing.id,
            userId: null,
            organizationId: null,
            metadata: {
              provider: params.provider,
              dedupKey: params.dedupKey,
              canonicalCompletionRetained,
              completedExecutionId: existing.completedExecution?.id ?? null,
              existingEventType: existing.eventType,
              incomingEventType: params.incoming.eventType,
              existingProviderExecutionId: existing.providerExecutionId,
              incomingProviderExecutionId: params.incoming.providerExecutionId,
              existingProviderAccountExternalId:
                existing.providerAccountExternalId,
              incomingProviderAccountExternalId:
                params.incoming.providerAccountExternalId,
              existingLivemode: existing.livemode,
              incomingLivemode: params.incoming.livemode,
              existingPayoutAmountMinor:
                existing.payoutAmountMinor?.toString() ?? null,
              incomingPayoutAmountMinor:
                params.incoming.payoutAmountMinor?.toString() ?? null,
              existingPayoutCurrency: existing.payoutCurrency,
              incomingPayoutCurrency: params.incoming.payoutCurrency,
              existingProviderStatus: existing.providerStatus,
              incomingProviderStatus: params.incoming.providerStatus,
              existingRawStatus: existing.rawStatus,
              incomingRawStatus: params.incoming.rawStatus,
            },
          },
        })
      },
      { isolationLevel: "Serializable" },
    )
  }

  private verifyStripeSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    channel: StripePayoutWebhookChannel,
  ) {
    const secret =
      channel === "platform"
        ? process.env.STRIPE_PAYOUT_WEBHOOK_SECRET?.trim()
        : process.env.STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET?.trim()
    if (!secret) {
      this.logger.error(
        `Stripe ${channel} payout webhook secret not configured — rejecting webhook (fail closed)`,
      )
      throw new ServiceUnavailableException(
        "Webhook verification not configured",
      )
    }
    if (!signatureHeader) {
      throw new UnauthorizedException("Missing stripe-signature header")
    }

    const parts = new Map<string, string[]>()
    for (const pair of signatureHeader.split(",")) {
      const [k, v] = pair.split("=", 2)
      if (!k || !v) continue
      const list = parts.get(k.trim()) ?? []
      list.push(v.trim())
      parts.set(k.trim(), list)
    }
    const timestamp = parts.get("t")?.[0]
    const candidates = parts.get("v1") ?? []
    if (!timestamp || candidates.length === 0) {
      throw new UnauthorizedException("Malformed stripe-signature header")
    }

    try {
      assertWebhookTimestampFresh(timestamp, STRIPE_TIMESTAMP_TOLERANCE_SECONDS)
    } catch (err) {
      const msg =
        err instanceof WebhookTimestampError
          ? err.message
          : "Stripe webhook timestamp outside tolerance"
      throw new UnauthorizedException(msg)
    }

    const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`
    const expected = createHmac("sha256", secret)
      .update(signedPayload)
      .digest("hex")
    const expectedBuf = Buffer.from(expected, "utf8")
    const valid = candidates.some((candidate) => {
      const candidateBuf = Buffer.from(candidate, "utf8")
      return (
        candidateBuf.length === expectedBuf.length &&
        timingSafeEqual(candidateBuf, expectedBuf)
      )
    })
    if (!valid) {
      throw new UnauthorizedException("Invalid Stripe webhook signature")
    }
  }

  // Wise signs the raw body with RSA-SHA256; signature arrives base64-encoded
  // in X-Signature-SHA256 and verifies against Wise's published public key.
  private verifyWiseSignature(rawBody: Buffer, signatureHeader?: string) {
    const publicKey = process.env.WISE_WEBHOOK_PUBLIC_KEY
    if (!publicKey) {
      this.logger.error(
        "WISE_WEBHOOK_PUBLIC_KEY not configured — rejecting webhook (fail closed)",
      )
      throw new ServiceUnavailableException(
        "Webhook verification not configured",
      )
    }
    if (!signatureHeader) {
      throw new UnauthorizedException("Missing x-signature-sha256 header")
    }

    let valid: boolean
    try {
      const verifier = createVerify("RSA-SHA256")
      verifier.update(rawBody)
      valid = verifier.verify(
        publicKey.replace(/\\n/g, "\n"),
        signatureHeader,
        "base64",
      )
    } catch {
      throw new UnauthorizedException("Invalid Wise webhook signature")
    }
    if (!valid) {
      throw new UnauthorizedException("Invalid Wise webhook signature")
    }
  }
}
