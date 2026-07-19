import { createHmac, createSign, generateKeyPairSync } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PayoutExecutionService } from "../payout-execution.service"
import { PayoutWebhookController } from "../payout-webhook.controller"
import { StripeConnectPayoutAdapter } from "../providers/stripe-connect-payout.adapter"
import {
  idempotencyKeyToUuid,
  WisePayoutAdapter,
} from "../providers/wise-payout.adapter"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  jest.useRealTimers()
  process.env = { ...ORIGINAL_ENV }
})

describe("PayoutWebhookController — signature verification", () => {
  let controller: PayoutWebhookController
  let prismaMock: any
  let wakeupMock: any

  // Default test payload — Wise-shape (data.id), used by both providers via
  // normalizeProviderWebhook's envelope-or-inner tolerance. The Stripe-specific
  // "queues a correctly signed Stripe webhook" test overrides with the real
  // Stripe envelope shape so the Phase 8.3 jobId dedup path is exercised.
  // occurred_at is required for Wise replay protection (M-2 pen test fix).
  const payload = JSON.stringify({
    occurred_at: new Date().toISOString(),
    data: { id: "transfer-1", status: "COMPLETED" },
    event: "transfer.state-change",
  })
  const rawBody = Buffer.from(payload, "utf8")

  beforeEach(() => {
    prismaMock = {
      payoutWebhookEvent: {
        create: jest.fn().mockResolvedValue({ id: "event-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "event-1" }),
      },
    }
    wakeupMock = { wake: jest.fn().mockResolvedValue(undefined) }
    controller = new PayoutWebhookController(prismaMock, wakeupMock)
  })

  function stripeSig(
    secret: string,
    body: string,
    timestamp = Math.floor(Date.now() / 1000),
  ) {
    const v1 = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")
    return `t=${timestamp},v1=${v1}`
  }

  it("rejects unsupported providers", async () => {
    await expect(
      controller.handleWebhook("paypal", {}, { rawBody } as any),
    ).rejects.toThrow(BadRequestException)
  })

  it("rejects Stripe webhook when no secret is configured (fail closed)", async () => {
    delete process.env.STRIPE_PAYOUT_WEBHOOK_SECRET
    delete process.env.STRIPE_WEBHOOK_SECRET
    await expect(
      controller.handleWebhook(
        "stripe_connect",
        { "stripe-signature": "t=1,v1=abc" },
        { rawBody } as any,
      ),
    ).rejects.toThrow(ServiceUnavailableException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with missing signature header", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_test"
    await expect(
      controller.handleWebhook("stripe_connect", {}, { rawBody } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with a forged signature", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_test"
    const forged = stripeSig("wrong-secret", payload)
    await expect(
      controller.handleWebhook(
        "stripe_connect",
        { "stripe-signature": forged },
        { rawBody } as any,
      ),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Stripe webhook with a stale timestamp (replay protection)", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_test"
    const stale = stripeSig(
      "whsec_test",
      payload,
      Math.floor(Date.now() / 1000) - 3600,
    )
    await expect(
      controller.handleWebhook(
        "stripe_connect",
        { "stripe-signature": stale },
        { rawBody } as any,
      ),
    ).rejects.toThrow(UnauthorizedException)
  })

  it("durably stores a correctly signed Stripe webhook before wake-up", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_test"
    // Use the real Stripe envelope shape so normalizeProviderWebhook extracts
    // data.object.id = "tr_phase83" → jobId = "payout-webhook:stripe_connect:tr_phase83".
    const stripePayload = JSON.stringify({
      id: "evt_phase83",
      type: "transfer.updated",
      data: { object: { id: "tr_phase83", status: "paid" } },
    })
    const stripeRaw = Buffer.from(stripePayload, "utf8")
    const sig = stripeSig("whsec_test", stripePayload)
    const result = await controller.handleWebhook(
      "stripe_connect",
      { "stripe-signature": sig },
      { rawBody: stripeRaw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "stripe_connect",
          providerExecutionId: "tr_phase83",
          providerStatus: "COMPLETED",
        }),
      }),
    )
    expect(wakeupMock.wake).toHaveBeenCalledWith("payout-webhook")
  })

  it("rejects Wise webhook when no public key is configured (fail closed)", async () => {
    delete process.env.WISE_WEBHOOK_PUBLIC_KEY
    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": "abc" }, {
        rawBody,
      } as any),
    ).rejects.toThrow(ServiceUnavailableException)
  })

  it("rejects Wise webhook with a forged signature and queues a valid one", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    await expect(
      controller.handleWebhook(
        "wise",
        { "x-signature-sha256": Buffer.from("forged").toString("base64") },
        { rawBody } as any,
      ),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()

    const signer = createSign("RSA-SHA256")
    signer.update(rawBody)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "wise",
          providerExecutionId: "transfer-1",
        }),
      }),
    )
  })

  // ─── M-2: Wise stale-timestamp boundary tests ─────────────────────
  // Mirrors the Stripe replay-protection test above. Tolerance is 300s;
  // ageSeconds > 300 is rejected, ≤ 300 is accepted (past and future are
  // symmetric via Math.abs).

  it("accepts Wise webhook with timestamp just inside the 300s tolerance (299s past)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() - 299_000).toISOString(),
      data: { id: "transfer-299", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody: raw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
    expect(prismaMock.payoutWebhookEvent.create).toHaveBeenCalled()
  })

  it("accepts Wise webhook at the exact 300s tolerance boundary", async () => {
    const now = new Date("2026-07-18T00:00:00.000Z")
    jest.useFakeTimers()
    jest.setSystemTime(now)

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(now.getTime() - 300_000).toISOString(),
      data: { id: "transfer-300", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    const result = await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody: raw } as any,
    )
    expect(result).toEqual({
      received: true,
      eventId: "event-1",
      duplicate: false,
    })
  })

  it("rejects Wise webhook with timestamp just outside the 300s tolerance (301s past)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() - 301_000).toISOString(),
      data: { id: "transfer-301", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": signature }, {
        rawBody: raw,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })

  it("rejects Wise webhook with a future timestamp outside tolerance (+301s)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()

    const body = JSON.stringify({
      occurred_at: new Date(Date.now() + 301_000).toISOString(),
      data: { id: "transfer-future", status: "COMPLETED" },
      event: "transfer.state-change",
    })
    const raw = Buffer.from(body, "utf8")
    const signer = createSign("RSA-SHA256")
    signer.update(raw)
    const signature = signer.sign(privateKey, "base64")

    await expect(
      controller.handleWebhook("wise", { "x-signature-sha256": signature }, {
        rawBody: raw,
      } as any),
    ).rejects.toThrow(UnauthorizedException)
    expect(prismaMock.payoutWebhookEvent.create).not.toHaveBeenCalled()
  })
})

describe("Provider adapters — idempotency and production safety", () => {
  it("derives a deterministic UUID-shaped customerTransactionId from the idempotency key", () => {
    const a = idempotencyKeyToUuid("payout-wd-1-v3")
    const b = idempotencyKeyToUuid("payout-wd-1-v3")
    const c = idempotencyKeyToUuid("payout-wd-1-v4")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it("Wise adapter sends customerTransactionId to the API", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 123, fee: { amount: 1 } }),
    })
    global.fetch = fetchMock as any

    const adapter = new WisePayoutAdapter()
    await adapter.createTransfer({
      amount: 100,
      currency: "usd",
      recipientDetails: { recipientId: "r-1" },
      providerConfig: { apiKey: "wise-key" },
      idempotencyKey: "payout-wd-1-v0",
      description: "test",
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.customerTransactionId).toBe(
      idempotencyKeyToUuid("payout-wd-1-v0"),
    )
    expect(body.idempotencyKey).toBeUndefined()
  })

  it("Stripe adapter sends the Idempotency-Key header, not a body field", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "tr_1", status: "pending" }),
    })
    global.fetch = fetchMock as any

    const adapter = new StripeConnectPayoutAdapter()
    await adapter.createTransfer({
      amount: 100,
      currency: "usd",
      recipientDetails: { connectedAccountId: "acct_1" },
      providerConfig: { apiKey: "sk_test" },
      idempotencyKey: "payout-wd-1-v0",
      description: "test",
    })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers["Idempotency-Key"]).toBe("payout-wd-1-v0")
    expect(String(options.body)).not.toContain("idempotency_key")
  })

  it("refuses mock transfers in production when API keys are missing", async () => {
    process.env.NODE_ENV = "production"
    delete process.env.WISE_API_KEY
    delete process.env.STRIPE_SECRET_KEY

    const wise = new WisePayoutAdapter()
    const stripe = new StripeConnectPayoutAdapter()
    const params = {
      amount: 100,
      currency: "usd",
      recipientDetails: {},
      providerConfig: {},
      idempotencyKey: "k",
      description: "",
    }

    await expect(wise.createTransfer(params as any)).rejects.toThrow(
      /production/,
    )
    await expect(stripe.createTransfer(params as any)).rejects.toThrow(
      /production/,
    )
    await expect(wise.checkTransferStatus("t-1")).rejects.toThrow(/production/)
    await expect(stripe.checkTransferStatus("t-1")).rejects.toThrow(
      /production/,
    )
    await expect(wise.cancelTransfer("t-1", "test-key")).rejects.toThrow(
      /production/,
    )
    await expect(stripe.cancelTransfer("t-1", "test-key")).rejects.toThrow(
      /production/,
    )
  })

  it("Stripe adapter sends the Idempotency-Key header on cancelTransfer", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test"
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "re_1" }),
    })
    global.fetch = fetchMock as any

    const adapter = new StripeConnectPayoutAdapter()
    await adapter.cancelTransfer("tr_1", "payout-cancel-exec-1")

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers["Idempotency-Key"]).toBe("payout-cancel-exec-1")
  })
})

describe("PayoutExecutionService.retryExecution — double-payment prevention", () => {
  const failedExecution = {
    id: "exec-1",
    status: "FAILED",
    withdrawalId: "wd-1",
    providerExecutionId: "transfer-9",
    amount: new Decimal(100),
    fee: new Decimal(0),
    withdrawal: {
      id: "wd-1",
      status: "FAILED",
      version: 2,
      publisherId: "pub-1",
      publisher: { organizationId: "org-1" },
    },
    provider: { id: "prov-1", name: "wise" },
  }

  function makeService(
    providerStatus: { status: string; fee?: number },
    executionOverride: Record<string, unknown> = {},
  ) {
    const auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    const prismaMock: any = {
      payoutExecution: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ ...failedExecution, ...executionOverride }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      withdrawal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      publisherBalance: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ publisherId: "pub-1", version: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ publisherId: "pub-1", version: 1 }]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    const adapterMock = {
      checkTransferStatus: jest.fn().mockResolvedValue(providerStatus),
      createTransfer: jest.fn(),
    }
    const providerMock = {
      getAdapter: jest.fn().mockReturnValue(adapterMock),
      getActiveProvider: jest
        .fn()
        .mockResolvedValue({ id: "prov-1", name: "wise", decryptedConfig: {} }),
    }
    const encryptionMock = {
      decrypt: jest.fn(),
      redactSensitive: jest.fn((s: string) => s),
    }
    const service = new PayoutExecutionService(
      prismaMock,
      auditMock as any,
      encryptionMock as any,
      providerMock as any,
    )
    return { service, prismaMock, auditMock, adapterMock }
  }

  it("recovers a provider-completed transfer instead of paying again", async () => {
    const { service, prismaMock, auditMock, adapterMock } = makeService({
      status: "COMPLETED",
      fee: 1.5,
    })

    const result = await service.retryExecution("exec-1", "staff-1")

    expect(result).toMatchObject({
      status: "COMPLETED",
      recoveredFromProvider: true,
    })
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
    expect(prismaMock.publisherBalance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lifetimePaid: { increment: 100 } }),
      }),
    )
    const audit = auditMock.log.mock.calls.find(
      (c: any[]) => c[0].action === "PAYOUT_EXECUTION_RECOVERED_COMPLETED",
    )
    expect(audit).toBeDefined()
  })

  it("refuses retry while the provider transfer is still processing", async () => {
    const { service, adapterMock } = makeService({ status: "PROCESSING" })

    await expect(service.retryExecution("exec-1", "staff-1")).rejects.toThrow(
      ConflictException,
    )
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
  })

  it("fails closed when provider outcome is ambiguous and no transfer id was recorded", async () => {
    const { service, adapterMock } = makeService(
      { status: "FAILED" },
      { providerExecutionId: null },
    )

    await expect(service.retryExecution("exec-1", "staff-1")).rejects.toThrow(
      /Do not retry/,
    )
    expect(adapterMock.checkTransferStatus).not.toHaveBeenCalled()
    expect(adapterMock.createTransfer).not.toHaveBeenCalled()
  })
})
