// Phase 8.3 — payout-webhook BullMQ jobId dedup contract (audit #3).
//
// We assert OUR contract (controller supplies the right jobId to addJob).
// BullMQ's rejection behavior is BullMQ's job and is covered by manual smoke.
//
// Design choices documented in the controller's Phase 8.3 comment block:
//   - Reuse normalizeProviderWebhook from @guestpost/shared (single source
//     of truth for payload-shape extraction across the worker + controller).
//   - jobId = `payout-webhook:${provider}:${providerExecutionId}` — matches
//     the repo's BullMQ jobId convention (delivery-verify, website-verify,
//     trust-recompute, payout-check-status-poll, settlement-auto-approve).
//   - Non-transfer events with no derivable providerExecutionId fall through
//     with no jobId override (preserves pre-fix behavior; logger.warn fires
//     so payload-shape drift is visible).

import { createHmac, createSign, generateKeyPairSync } from "crypto"
import { PayoutWebhookController } from "../payout-webhook.controller"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("Phase 8.3 — payout-webhook BullMQ jobId dedup (audit #3)", () => {
  let controller: PayoutWebhookController
  let queueMock: any

  beforeEach(() => {
    queueMock = { addJob: jest.fn().mockResolvedValue({ id: "job-1" }) }
    controller = new PayoutWebhookController(queueMock)
  })

  function stripeSig(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
    const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
    return `t=${timestamp},v1=${v1}`
  }

  function signWise(rawBody: Buffer, privateKey: any): string {
    const signer = createSign("RSA-SHA256")
    signer.update(rawBody)
    return signer.sign(privateKey, "base64")
  }

  // ─── a) Stripe payload with known transfer id → deterministic jobId ───

  it("Stripe webhook with a transfer id passes jobId 'payout-webhook:stripe_connect:<id>' to addJob", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    const payload = JSON.stringify({
      id: "evt_abc",
      type: "transfer.updated",
      data: { object: { id: "tr_abc123", status: "paid" } },
    })
    const rawBody = Buffer.from(payload, "utf8")
    const sig = stripeSig("whsec_phase83", payload)

    await controller.handleWebhook("stripe_connect", { "stripe-signature": sig }, { rawBody } as any)

    expect(queueMock.addJob).toHaveBeenCalledTimes(1)
    const jobIdArg = queueMock.addJob.mock.calls[0][3]
    expect(jobIdArg).toEqual({ jobId: "payout-webhook:stripe_connect:tr_abc123" })
  })

  // ─── b) Wise payload with known transfer id → deterministic jobId ───

  it("Wise webhook with a transfer id passes jobId 'payout-webhook:wise:<id>' to addJob", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    process.env.WISE_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString()
    const payload = JSON.stringify({
      event_type: "transfers#state-change",
      data: { resource: { id: "wise_xyz789" }, current_state: "outgoing_payment_sent" },
    })
    const rawBody = Buffer.from(payload, "utf8")
    const signature = signWise(rawBody, privateKey)

    await controller.handleWebhook("wise", { "x-signature-sha256": signature }, { rawBody } as any)

    expect(queueMock.addJob).toHaveBeenCalledTimes(1)
    const jobIdArg = queueMock.addJob.mock.calls[0][3]
    expect(jobIdArg).toEqual({ jobId: "payout-webhook:wise:wise_xyz789" })
  })

  // ─── c) Two identical replays produce the deterministic same jobId string ───

  it("two identical replays produce the deterministic same jobId string", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    const payload = JSON.stringify({
      id: "evt_replay",
      type: "transfer.updated",
      data: { object: { id: "tr_replay_target", status: "paid" } },
    })
    const rawBody = Buffer.from(payload, "utf8")
    const sig = stripeSig("whsec_phase83", payload)

    // Two identical handleWebhook calls (simulating provider retry / ops replay).
    await controller.handleWebhook("stripe_connect", { "stripe-signature": sig }, { rawBody } as any)
    await controller.handleWebhook("stripe_connect", { "stripe-signature": sig }, { rawBody } as any)

    expect(queueMock.addJob).toHaveBeenCalledTimes(2)
    // Capture the jobId arg from BOTH calls and assert deterministic identity.
    // String equality (not toMatch) — proves the controller derives the same
    // dedup key from the same input. BullMQ then handles actual rejection.
    const jobId1 = queueMock.addJob.mock.calls[0][3]?.jobId
    const jobId2 = queueMock.addJob.mock.calls[1][3]?.jobId
    expect(jobId1).toBe("payout-webhook:stripe_connect:tr_replay_target")
    expect(jobId2).toBe(jobId1)
  })

  // ─── d) Non-transfer payload falls through with no jobId override ───

  it("non-transfer Stripe webhook (no data.object.id) falls through with no jobId override", async () => {
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = "whsec_phase83"
    // account.updated has no data.object.id — Stripe sends account-shape data
    // there. Our normalizer returns providerExecutionId=null; we fall back to
    // auto-id (no jobId override). Worker's status-check guard handles any
    // logical replay from this path.
    const payload = JSON.stringify({
      id: "evt_no_id",
      type: "account.updated",
      data: { whatever: "no object field here" },
    })
    const rawBody = Buffer.from(payload, "utf8")
    const sig = stripeSig("whsec_phase83", payload)

    await controller.handleWebhook("stripe_connect", { "stripe-signature": sig }, { rawBody } as any)

    expect(queueMock.addJob).toHaveBeenCalledTimes(1)
    // 4th arg should be undefined (no override) — preserves the pre-fix
    // behavior for events that don't carry a transfer id.
    const jobIdArg = queueMock.addJob.mock.calls[0][3]
    expect(jobIdArg).toBeUndefined()
  })
})
