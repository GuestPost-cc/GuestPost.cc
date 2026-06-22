import { Controller, Post, Param, Headers, Logger, UnauthorizedException, BadRequestException, Req, ServiceUnavailableException } from "@nestjs/common"
import type { RawBodyRequest } from "@nestjs/common"
import type { Request } from "express"
import { createHmac, createVerify, timingSafeEqual } from "crypto"
import { QueueService } from "../queues/queue.service"
import { QUEUES, normalizeProviderWebhook } from "@guestpost/shared"
import { Public } from "../../common/decorators/public.decorator"

const STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300

@Controller("payout-webhooks")
export class PayoutWebhookController {
  private readonly logger = new Logger(PayoutWebhookController.name)

  constructor(private readonly queue: QueueService) {}

  // Public: providers cannot authenticate with a session — the cryptographic
  // signature check below is the authentication for this route.
  @Public()
  @Post(":provider")
  async handleWebhook(
    @Param("provider") provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
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

    const eventType = body.type ?? body.event ?? "unknown"
    const data = body.data ?? body

    // Phase 8.3 (audit #3) — BullMQ-native dedup. Replay protection: two
    // identical webhook payloads (provider retry, ops re-trigger, network
    // duplicate) produce the same jobId and the second enqueue becomes a
    // no-op for the dedup window bounded by the PAYOUT queue's
    // removeOnComplete policy (`{ count: 100, age: 86400 }` → ~24h / 100
    // jobs whichever first). We reuse normalizeProviderWebhook from
    // @guestpost/shared rather than duplicating payload-shape extraction —
    // single source of truth means future provider-shape changes update
    // both the worker's status path AND our dedup keying together.
    const normalized = normalizeProviderWebhook(provider, data)
    const providerExecutionId = normalized.providerExecutionId

    if (!providerExecutionId && (provider === "stripe_connect" || provider === "wise")) {
      // Drift visibility: signature already passed, payload is genuine, but
      // we couldn't pull a transfer id. Probably a non-transfer event type
      // (account.updated, payout.created without object.id, etc.). Log so
      // drift is investigable; fall through with auto-id (current behavior).
      this.logger.warn(
        `unable to derive payout webhook dedup key (provider=${provider} eventType=${eventType})`,
      )
    }

    const jobIdOverride = providerExecutionId
      ? { jobId: `payout-webhook:${provider}:${providerExecutionId}` }
      : undefined

    const job = await this.queue.addJob(
      QUEUES.PAYOUT,
      "payout-webhook",
      {
        provider,
        event: eventType,
        data,
        verified: true,
        receivedAt: new Date().toISOString(),
      },
      jobIdOverride,
    )

    this.logger.log(`Verified webhook from ${provider} queued as job ${job.id}`)
    return { received: true, jobId: job.id }
  }

  // Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the
  // endpoint's webhook secret; header format `t=...,v1=...`.
  private verifyStripeSignature(rawBody: Buffer, signatureHeader?: string) {
    const secret = process.env.STRIPE_PAYOUT_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) {
      this.logger.error("STRIPE_PAYOUT_WEBHOOK_SECRET not configured — rejecting webhook (fail closed)")
      throw new ServiceUnavailableException("Webhook verification not configured")
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

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(ageSeconds) || ageSeconds > STRIPE_TIMESTAMP_TOLERANCE_SECONDS) {
      throw new UnauthorizedException("Stripe webhook timestamp outside tolerance")
    }

    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex")
    const expectedBuf = Buffer.from(expected, "utf8")
    const valid = candidates.some((c) => {
      const candidateBuf = Buffer.from(c, "utf8")
      return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)
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
      this.logger.error("WISE_WEBHOOK_PUBLIC_KEY not configured — rejecting webhook (fail closed)")
      throw new ServiceUnavailableException("Webhook verification not configured")
    }
    if (!signatureHeader) {
      throw new UnauthorizedException("Missing x-signature-sha256 header")
    }

    let valid: boolean
    try {
      const verifier = createVerify("RSA-SHA256")
      verifier.update(rawBody)
      valid = verifier.verify(publicKey.replace(/\\n/g, "\n"), signatureHeader, "base64")
    } catch {
      throw new UnauthorizedException("Invalid Wise webhook signature")
    }
    if (!valid) {
      throw new UnauthorizedException("Invalid Wise webhook signature")
    }
  }
}
