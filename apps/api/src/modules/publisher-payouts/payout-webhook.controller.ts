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
import {
  BadRequestException,
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
import { PrismaService } from "../../common/prisma.service"
import { stripeKeyMode } from "../../common/stripe-client"
import { WorkerWakeupService } from "../queues/worker-wakeup.service"
import { StripeConnectService } from "./stripe-connect.service"

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300

@Controller("payout-webhooks")
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly workerWakeup: WorkerWakeupService,
    private readonly stripeConnect?: StripeConnectService,
  ) {}

  // Public: providers cannot authenticate with a session — the cryptographic
  // signature check below is the authentication for this route.
  @Public()
  @Post(":provider")
  async handleWebhook(
    @Param("provider") provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
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
      this.verifyStripeSignature(rawBody, headers["stripe-signature"])
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
    const data = body.data ?? body

    if (provider === "stripe_connect") {
      if (
        typeof body.livemode !== "boolean" ||
        body.livemode !== (stripeKeyMode() === "live")
      ) {
        throw new BadRequestException(
          "Stripe event mode does not match API key",
        )
      }
    }

    if (provider === "stripe_connect" && eventType === "account.updated") {
      const accountId = body.data?.object?.id
      if (typeof accountId !== "string" || !this.stripeConnect) {
        throw new BadRequestException("Invalid Stripe account event")
      }
      await this.stripeConnect.syncAccount(accountId)
      return { received: true, accountSynced: true }
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
    const normalized = normalizeProviderWebhook(provider, data)
    const providerExecutionId = this.boundedText(
      normalized.providerExecutionId,
      191,
    )

    if (
      !providerExecutionId &&
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

    let inboxEvent: { id: string }
    let duplicate = false
    try {
      inboxEvent = await payoutWebhookEvent.create({
        data: {
          provider,
          dedupKey,
          eventType: safeEventType,
          providerExecutionId,
          providerStatus: normalized.status,
          rawStatus: safeRawStatus,
        },
        select: { id: true },
      })
    } catch (error: any) {
      if (error?.code !== "P2002") throw error
      duplicate = true
      const existing = await payoutWebhookEvent.findUnique({
        where: { provider_dedupKey: { provider, dedupKey } },
        select: { id: true },
      })
      if (!existing) throw error
      inboxEvent = existing
    }

    // Do not await external orchestration before returning 2xx. The committed
    // inbox row is durable and the 10-minute catch-up job guarantees recovery.
    void this.workerWakeup.wake("payout-webhook")
    this.logger.log(
      `Verified payout webhook durably accepted (provider=${provider} duplicate=${duplicate})`,
    )
    return { received: true, eventId: inboxEvent.id, duplicate }
  }

  private boundedText(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null
    return value.slice(0, maxLength)
  }

  // Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the
  // endpoint's webhook secret; header format `t=...,v1=...`.
  private verifyStripeSignature(rawBody: Buffer, signatureHeader?: string) {
    const secret = process.env.STRIPE_PAYOUT_WEBHOOK_SECRET
    if (!secret) {
      this.logger.error(
        "STRIPE_PAYOUT_WEBHOOK_SECRET not configured — rejecting webhook (fail closed)",
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

    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex")
    const expectedBuf = Buffer.from(expected, "utf8")
    const valid = candidates.some((c) => {
      const candidateBuf = Buffer.from(c, "utf8")
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
