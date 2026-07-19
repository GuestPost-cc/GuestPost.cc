import {
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
} from "node:crypto"
import { PayoutWebhookController } from "../payout-webhook.controller"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("payout webhook durable inbox dedup", () => {
  let prismaMock: any
  let wakeupMock: any
  let controller: PayoutWebhookController

  beforeEach(() => {
    prismaMock = {
      payoutWebhookEvent: {
        create: jest.fn().mockResolvedValue({ id: "inbox-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "inbox-1" }),
      },
    }
    wakeupMock = { wake: jest.fn().mockResolvedValue(undefined) }
    controller = new PayoutWebhookController(prismaMock, wakeupMock)
  })

  function stripeSig(secret: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000)
    const v1 = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex")
    return `t=${timestamp},v1=${v1}`
  }

  function persistedData(): Record<string, unknown> {
    return prismaMock.payoutWebhookEvent.create.mock.calls[0][0].data
  }

  it("deduplicates by provider event identity, not by transfer id", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    const makePayload = (eventId: string, status: string) =>
      JSON.stringify({
        id: eventId,
        type: "transfer.updated",
        data: { object: { id: "tr_same", status } },
      })

    const first = makePayload("evt_processing", "pending")
    await controller.handleWebhook(
      "stripe_connect",
      { "stripe-signature": stripeSig("whsec_phase83", first) },
      { rawBody: Buffer.from(first) } as any,
    )
    const firstData = persistedData()

    prismaMock.payoutWebhookEvent.create.mockClear()
    const completed = makePayload("evt_completed", "paid")
    await controller.handleWebhook(
      "stripe_connect",
      { "stripe-signature": stripeSig("whsec_phase83", completed) },
      { rawBody: Buffer.from(completed) } as any,
    )
    const completedData = persistedData()

    expect(firstData.providerExecutionId).toBe("tr_same")
    expect(completedData.providerExecutionId).toBe("tr_same")
    expect(firstData.dedupKey).not.toBe(completedData.dedupKey)
    expect(completedData.providerStatus).toBe("COMPLETED")
  })

  it("returns the existing durable event on an identical replay", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    prismaMock.payoutWebhookEvent.create.mockRejectedValue({ code: "P2002" })
    prismaMock.payoutWebhookEvent.findUnique.mockResolvedValue({
      id: "inbox-existing",
    })
    const payload = JSON.stringify({
      id: "evt_replay",
      type: "transfer.updated",
      data: { object: { id: "tr_1", status: "paid" } },
    })

    const result = await controller.handleWebhook(
      "stripe_connect",
      { "stripe-signature": stripeSig("whsec_phase83", payload) },
      { rawBody: Buffer.from(payload) } as any,
    )

    expect(result).toEqual({
      received: true,
      eventId: "inbox-existing",
      duplicate: true,
    })
    const expectedKey = createHash("sha256")
      .update("event:evt_replay")
      .digest("hex")
    expect(prismaMock.payoutWebhookEvent.findUnique).toHaveBeenCalledWith({
      where: {
        provider_dedupKey: {
          provider: "stripe_connect",
          dedupKey: expectedKey,
        },
      },
      select: { id: true },
    })
  })

  it("uses a verified payload hash when Wise supplies no event id", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey
      .export({ type: "spki", format: "pem" })
      .toString()
    const payload = JSON.stringify({
      event_type: "balances#credit",
      occurred_at: new Date().toISOString(),
      data: { current_state: "processing" },
    })
    const rawBody = Buffer.from(payload)
    const signer = createSign("RSA-SHA256")
    signer.update(rawBody)
    const signature = signer.sign(privateKey, "base64")

    await controller.handleWebhook(
      "wise",
      { "x-signature-sha256": signature },
      { rawBody } as any,
    )

    const payloadHash = createHash("sha256").update(rawBody).digest("hex")
    const expectedKey = createHash("sha256")
      .update(`payload:${payloadHash}`)
      .digest("hex")
    expect(persistedData()).toMatchObject({
      provider: "wise",
      dedupKey: expectedKey,
      eventType: "balances#credit",
      providerExecutionId: null,
    })
  })

  it("persists only normalized allow-listed fields", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    const payload = JSON.stringify({
      id: "evt_safe",
      type: "transfer.updated",
      secretBankField: "must-not-persist",
      data: {
        object: {
          id: "tr_safe",
          status: "paid",
          destination: "acct_sensitive",
        },
      },
    })
    await controller.handleWebhook(
      "stripe_connect",
      { "stripe-signature": stripeSig("whsec_phase83", payload) },
      { rawBody: Buffer.from(payload) } as any,
    )

    const serialized = JSON.stringify(persistedData())
    expect(serialized).not.toContain("must-not-persist")
    expect(serialized).not.toContain("acct_sensitive")
    expect(persistedData()).toMatchObject({
      providerExecutionId: "tr_safe",
      providerStatus: "COMPLETED",
      rawStatus: "paid",
    })
    expect(wakeupMock.wake).toHaveBeenCalledWith("payout-webhook")
  })
})
