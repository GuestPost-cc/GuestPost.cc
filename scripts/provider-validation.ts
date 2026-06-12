/**
 * Provider integration validation — fires GENUINELY SIGNED webhooks at the
 * running platform and asserts every money transition end-to-end (API
 * signature verification -> queue -> worker -> version-guarded DB
 * transitions -> reconciliation).
 *
 * Stripe: payloads signed with the real STRIPE_WEBHOOK_SECRET from env —
 *   byte-identical verification path to production deliveries.
 * Wise: payloads signed with a locally generated RSA keypair whose PUBLIC
 *   key is configured as WISE_WEBHOOK_PUBLIC_KEY — the API runs the exact
 *   production RSA-SHA256 verification against them.
 *
 * NOT covered here (requires real provider credentials, documented in the
 * validation report): Wise recipient/transfer creation against the Wise
 * sandbox API; Stripe Connect transfers to a connected account.
 *
 * Run: pnpm tsx scripts/provider-validation.ts
 * Requires: API + worker running; seed data; WISE_WEBHOOK_PUBLIC_KEY set to
 * the public half of scripts/.wise-validation-key.pem (script prints setup
 * commands if missing).
 */
import { createHmac, createSign, generateKeyPairSync } from "crypto"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { config } from "dotenv"
import path from "path"
import { prisma } from "../packages/database/src"

config({ path: path.resolve(__dirname, "../.env.development") })

const API = process.env.API_URL ?? "http://localhost:4000"
const H = { "Content-Type": "application/json", Origin: "http://localhost:3001" }
const KEY_FILE = path.resolve(__dirname, ".wise-validation-key.pem")
const PUB_FILE = path.resolve(__dirname, ".wise-validation-key.pub.pem")

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) }
}

async function call(method: string, path_: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}/api/v1${path_}`, {
    method,
    headers: { ...H, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: any
  const text = await res.text()
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

async function signIn(email: string, password: string) {
  const r = await call("POST", "/auth/sign-in/email", undefined, { email, password })
  if (r.status !== 200) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(r.data)}`)
  return r.data.token as string
}

// ── Webhook delivery with real signatures ───────────────────────────────────

async function fireStripe(pathSuffix: string, secret: string, payload: unknown) {
  const raw = JSON.stringify(payload)
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")
  const res = await fetch(`${API}/api/v1${pathSuffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body: raw,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function fireWise(payload: unknown, privateKeyPem: string, tamper = false) {
  const raw = JSON.stringify(payload)
  const signer = createSign("RSA-SHA256")
  signer.update(tamper ? raw + "x" : raw)
  const sig = signer.sign(privateKeyPem, "base64")
  const res = await fetch(`${API}/api/v1/payout-webhooks/wise`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature-sha256": sig },
    body: raw,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 15000): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(500)
  }
  return null
}

async function main() {
  // ── Key material ──────────────────────────────────────────────────────────
  if (!existsSync(KEY_FILE)) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    writeFileSync(KEY_FILE, privateKey, { mode: 0o600 })
    writeFileSync(PUB_FILE, publicKey)
    console.log(`Generated validation keypair. Set in .env.development:\nWISE_WEBHOOK_PUBLIC_KEY="${publicKey.replace(/\n/g, "\\n")}"\nthen restart the API and re-run.`)
    process.exit(2)
  }
  const wisePrivate = readFileSync(KEY_FILE, "utf8")
  const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET
  const stripePayoutSecret = process.env.STRIPE_PAYOUT_WEBHOOK_SECRET ?? stripeSecret
  if (!stripeSecret) throw new Error("STRIPE_WEBHOOK_SECRET missing from .env.development")

  const client = await signIn("client@guestpost.local", "Client123!")
  const admin = await signIn("admin@guestpost.local", "Admin123!")

  // ════════════════════════ STRIPE: DEPOSIT ═════════════════════════════════
  console.log("── Stripe deposit webhook (real HMAC, real handler)")
  const wallet0 = (await call("GET", "/billing/wallet", client)).data
  const sessionId = `cs_val_${Date.now()}`
  const piId = `pi_val_${Date.now()}`
  const depositCents = 12345 // $123.45 — non-whole-dollar on purpose
  const sessionPayload = {
    id: `evt_val_${Date.now()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        amount_total: depositCents,
        payment_intent: piId,
        metadata: { walletId: wallet0.id, organizationId: wallet0.organizationId, userId: "validation" },
      },
    },
  }

  const dep1 = await fireStripe("/billing/webhook/stripe", stripeSecret, sessionPayload)
  check("deposit webhook accepted (200)", dep1.status === 200 || dep1.status === 201, dep1)

  const wallet1 = (await call("GET", "/billing/wallet", client)).data
  check(
    "wallet credited exactly $123.45",
    Math.abs(Number(wallet1.availableBalance) - Number(wallet0.availableBalance) - 123.45) < 0.001,
    { before: wallet0.availableBalance, after: wallet1.availableBalance },
  )

  const depRow = await prisma.transaction.findFirst({ where: { reference: sessionId } })
  check("ledger row written with payment_intent linkage", depRow?.providerRef === piId, depRow)

  // Duplicate delivery (Stripe retries are routine)
  const dep2 = await fireStripe("/billing/webhook/stripe", stripeSecret, sessionPayload)
  check("duplicate deposit webhook accepted (replay-safe 200)", dep2.status === 200 || dep2.status === 201, dep2)
  const wallet2 = (await call("GET", "/billing/wallet", client)).data
  check("duplicate deposit did NOT double-credit", Number(wallet2.availableBalance) === Number(wallet1.availableBalance), {
    after1: wallet1.availableBalance, after2: wallet2.availableBalance,
  })
  const depCount = await prisma.transaction.count({ where: { reference: sessionId } })
  check("exactly one deposit ledger row", depCount === 1, { depCount })

  // Tampered signature must bounce
  const badSig = await fetch(`${API}/api/v1/billing/webhook/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify(sessionPayload),
  })
  check("tampered deposit signature rejected (400)", badSig.status === 400, badSig.status)

  // ════════════════════════ STRIPE: CHARGEBACK ══════════════════════════════
  console.log("── Stripe chargeback lifecycle (hold → won release; hold → lost debit)")
  const disputeWon = `dp_val_won_${Date.now()}`
  const disputeAmountCents = 5000 // $50

  const cb1 = await fireStripe("/billing/webhook/stripe", stripeSecret, {
    id: `evt_cb_${Date.now()}`,
    type: "charge.dispute.created",
    data: { object: { id: disputeWon, charge: "ch_val", payment_intent: piId, amount: disputeAmountCents, currency: "usd", reason: "fraudulent", status: "needs_response" } },
  })
  check("dispute.created accepted", cb1.status === 200 || cb1.status === 201, cb1)

  const wallet3 = (await call("GET", "/billing/wallet", client)).data
  check(
    "hold moved $50 available→reserved",
    Math.abs(Number(wallet2.availableBalance) - Number(wallet3.availableBalance) - 50) < 0.001 &&
      Math.abs(Number(wallet3.reservedBalance) - Number(wallet2.reservedBalance) - 50) < 0.001,
    { av2: wallet2.availableBalance, av3: wallet3.availableBalance, rs2: wallet2.reservedBalance, rs3: wallet3.reservedBalance },
  )

  // Duplicate dispute webhook
  await fireStripe("/billing/webhook/stripe", stripeSecret, {
    id: `evt_cb2_${Date.now()}`,
    type: "charge.dispute.created",
    data: { object: { id: disputeWon, charge: "ch_val", payment_intent: piId, amount: disputeAmountCents, currency: "usd", reason: "fraudulent", status: "needs_response" } },
  })
  const wallet3b = (await call("GET", "/billing/wallet", client)).data
  check("duplicate dispute webhook did not double-hold", Number(wallet3b.reservedBalance) === Number(wallet3.reservedBalance), {
    rs: wallet3.reservedBalance, rsDup: wallet3b.reservedBalance,
  })

  // WON → release
  await fireStripe("/billing/webhook/stripe", stripeSecret, {
    id: `evt_cbw_${Date.now()}`,
    type: "charge.dispute.closed",
    data: { object: { id: disputeWon, status: "won" } },
  })
  const wallet4 = (await call("GET", "/billing/wallet", client)).data
  check(
    "dispute WON released hold back to available",
    Math.abs(Number(wallet4.availableBalance) - Number(wallet2.availableBalance)) < 0.001 &&
      Math.abs(Number(wallet4.reservedBalance) - Number(wallet2.reservedBalance)) < 0.001,
    { av: wallet4.availableBalance, rs: wallet4.reservedBalance },
  )

  // Second dispute → LOST → permanent debit
  const disputeLost = `dp_val_lost_${Date.now()}`
  await fireStripe("/billing/webhook/stripe", stripeSecret, {
    id: `evt_cbl_${Date.now()}`,
    type: "charge.dispute.created",
    data: { object: { id: disputeLost, charge: "ch_val2", payment_intent: piId, amount: disputeAmountCents, currency: "usd", reason: "fraudulent", status: "needs_response" } },
  })
  await fireStripe("/billing/webhook/stripe", stripeSecret, {
    id: `evt_cbl2_${Date.now()}`,
    type: "charge.dispute.closed",
    data: { object: { id: disputeLost, status: "lost" } },
  })
  const wallet5 = (await call("GET", "/billing/wallet", client)).data
  check(
    "dispute LOST debited $50 permanently (reserved consumed, available unchanged)",
    Math.abs(Number(wallet4.availableBalance) - 50 - (Number(wallet5.availableBalance) + Number(wallet5.reservedBalance) - Number(wallet4.reservedBalance))) < 0.001 &&
      Math.abs(Number(wallet5.reservedBalance) - Number(wallet4.reservedBalance)) < 0.001,
    { av4: wallet4.availableBalance, av5: wallet5.availableBalance, rs4: wallet4.reservedBalance, rs5: wallet5.reservedBalance },
  )
  const lostRow = await prisma.transaction.findFirst({ where: { reference: `chargeback-lost-${disputeLost}` } })
  check("CHARGEBACK ledger row written for lost dispute", !!lostRow && Number(lostRow.amount) === -50, lostRow?.amount)

  // ════════════════════════ WISE: WEBHOOK PATH ══════════════════════════════
  console.log("── Wise webhook path (real RSA-SHA256 verification, real worker transitions)")

  // Harness setup (direct DB, like the load harness): a PROCESSING execution
  // awaiting a provider callback, exactly the state after a real Wise send.
  const wiseProvider = await prisma.payoutProvider.findUnique({ where: { name: "wise" } })
  check("wise provider registered", !!wiseProvider)
  const pub = await prisma.publisher.findFirstOrThrow({ where: { email: "publisher@guestpost.local" } })
  const transferId = Math.floor(Date.now() / 1000) // Wise transfer ids are numeric

  const wd = await prisma.withdrawal.create({
    data: { publisherId: pub.id, amount: 25, method: "wise", status: "PROCESSING", version: 1 },
  })
  const exec = await prisma.payoutExecution.create({
    data: {
      withdrawalId: wd.id, providerId: wiseProvider!.id, status: "PROCESSING",
      providerExecutionId: String(transferId), amount: 25, idempotencyKey: `payout-${wd.id}-v1`,
    },
  })
  const lifetimeBefore = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { publisherId: pub.id } })).lifetimePaid)

  // Tampered signature rejected before anything is queued
  const tampered = await fireWise(
    { data: { resource: { id: transferId, type: "transfer" }, current_state: "completed" }, event_type: "transfers#state-change" },
    wisePrivate, true,
  )
  check("tampered Wise signature rejected (401)", tampered.status === 401, tampered.status)

  // Non-terminal state: accepted, no transition
  const sent = await fireWise(
    { data: { resource: { id: transferId, type: "transfer" }, current_state: "processing" }, event_type: "transfers#state-change" },
    wisePrivate,
  )
  check("non-terminal Wise state accepted", sent.status === 200 || sent.status === 201, sent)
  await sleep(2500)
  const execMid = await prisma.payoutExecution.findUniqueOrThrow({ where: { id: exec.id } })
  check("non-terminal state caused no transition", execMid.status === "PROCESSING", execMid.status)

  // Terminal: completed
  const done = await fireWise(
    { data: { resource: { id: transferId, type: "transfer" }, current_state: "completed" }, event_type: "transfers#state-change" },
    wisePrivate,
  )
  check("completed Wise webhook accepted", done.status === 200 || done.status === 201, done)

  const completed = await waitFor(async () => {
    const e = await prisma.payoutExecution.findUniqueOrThrow({ where: { id: exec.id } })
    return e.status === "COMPLETED" ? e : null
  })
  check("worker completed the execution via webhook", !!completed)
  const wdAfter = await prisma.withdrawal.findUniqueOrThrow({ where: { id: wd.id } })
  check("withdrawal transitioned to COMPLETED", wdAfter.status === "COMPLETED", wdAfter.status)
  const lifetimeAfter = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { publisherId: pub.id } })).lifetimePaid)
  check("lifetimePaid incremented exactly $25", Math.abs(lifetimeAfter - lifetimeBefore - 25) < 0.001, { lifetimeBefore, lifetimeAfter })

  // Replay the completed webhook — must be a no-op
  await fireWise(
    { data: { resource: { id: transferId, type: "transfer" }, current_state: "completed" }, event_type: "transfers#state-change" },
    wisePrivate,
  )
  await sleep(2500)
  const lifetimeReplay = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { publisherId: pub.id } })).lifetimePaid)
  check("replayed Wise webhook did NOT double-pay", lifetimeReplay === lifetimeAfter, { lifetimeAfter, lifetimeReplay })

  // Failed-transfer path on a fresh execution
  const transferId2 = transferId + 1
  const wd2 = await prisma.withdrawal.create({
    data: { publisherId: pub.id, amount: 10, method: "wise", status: "PROCESSING", version: 1 },
  })
  const exec2 = await prisma.payoutExecution.create({
    data: {
      withdrawalId: wd2.id, providerId: wiseProvider!.id, status: "PROCESSING",
      providerExecutionId: String(transferId2), amount: 10, idempotencyKey: `payout-${wd2.id}-v1`,
    },
  })
  await fireWise(
    { data: { resource: { id: transferId2, type: "transfer" }, current_state: "cancelled" }, event_type: "transfers#state-change" },
    wisePrivate,
  )
  const failedExec = await waitFor(async () => {
    const e = await prisma.payoutExecution.findUniqueOrThrow({ where: { id: exec2.id } })
    return e.status === "FAILED" ? e : null
  })
  check("cancelled Wise transfer marked execution FAILED", !!failedExec)
  const wd2After = await prisma.withdrawal.findUniqueOrThrow({ where: { id: wd2.id } })
  check("withdrawal marked FAILED (reversal path now available)", wd2After.status === "FAILED", wd2After.status)
  const lifetimeFail = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { publisherId: pub.id } })).lifetimePaid)
  check("failed transfer paid nothing", lifetimeFail === lifetimeAfter, { lifetimeFail })

  // Recover the failed withdrawal through the audited admin reversal
  const reversed = await call("POST", `/admin/withdrawals/${wd2.id}/reverse`, admin, { reason: "provider cancelled transfer — validation run" })
  check("FAILED withdrawal reversed via admin API", reversed.status < 300 && reversed.data.status === "REVERSED", reversed.data?.status ?? reversed.status)

  // ════════════════════════ STRIPE PAYOUT WEBHOOK ═══════════════════════════
  console.log("── Stripe payout webhook (transfer paid)")
  const trId = `tr_val_${Date.now()}`
  const stripeProvider = await prisma.payoutProvider.findUnique({ where: { name: "stripe_connect" } })
  check("stripe_connect provider registered", !!stripeProvider)
  const wd3 = await prisma.withdrawal.create({
    data: { publisherId: pub.id, amount: 15, method: "stripe_connect", status: "PROCESSING", version: 1 },
  })
  const exec3 = await prisma.payoutExecution.create({
    data: {
      withdrawalId: wd3.id, providerId: stripeProvider!.id, status: "PROCESSING",
      providerExecutionId: trId, amount: 15, idempotencyKey: `payout-${wd3.id}-v1`,
    },
  })
  const sp = await fireStripe("/payout-webhooks/stripe_connect", stripePayoutSecret!, {
    id: `evt_tr_${Date.now()}`,
    type: "transfer.updated",
    data: { object: { id: trId, object: "transfer", status: "paid", amount: 1500 } },
  })
  check("stripe payout webhook accepted", sp.status === 200 || sp.status === 201, sp)
  const exec3Done = await waitFor(async () => {
    const e = await prisma.payoutExecution.findUniqueOrThrow({ where: { id: exec3.id } })
    return e.status === "COMPLETED" ? e : null
  })
  check("stripe transfer paid → execution COMPLETED via worker", !!exec3Done)

  // ════════════════════════ REFEREE ═════════════════════════════════════════
  const recon = (await call("GET", "/admin/reconciliation", admin)).data
  check("reconciliation after all provider events: ok", recon.ok === true, {
    walletDrift: recon.walletDrift?.length, publisherDrift: recon.publisherDrift?.length, stuckPayouts: recon.stuckPayouts?.length,
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
