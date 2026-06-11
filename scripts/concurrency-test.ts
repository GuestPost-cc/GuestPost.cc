/**
 * Concurrency attack suite: fires parallel requests at every money-moving
 * endpoint and asserts the invariants hold. The final referee is the
 * reconciliation endpoint — cached balances must still equal the ledger.
 *
 * Run: pnpm tsx scripts/concurrency-test.ts  (API on :4000, seeded DB)
 */
import { prisma } from "../packages/database/src"

const API = process.env.API_URL ?? "http://localhost:4000"
const H = { "Content-Type": "application/json", Origin: "http://localhost:3001" }
const PAR = 10 // parallel requests per attack

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) }
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}/api/v1${path}`, {
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
  if (r.status !== 200) throw new Error(`sign-in failed: ${email}`)
  return r.data.token as string
}

/** Drive one order from DRAFT to DELIVERED, return its settlement id. */
async function orderToSettlement(client: string, publisher: string, admin: string, websiteId: string) {
  const order = (await call("POST", "/orders", client, {
    type: "GUEST_POST", title: `ctest ${Date.now()}-${Math.random()}`,
    items: [{ websiteId, targetUrl: "https://example.com/c", anchorText: "ctest" }],
  })).data
  for (const [actor, path, body] of [
    [client, "submit-payment", undefined],
    [publisher, "accept", undefined],
    [publisher, "submit-content", { content: "ctest content" }],
    [publisher, "mark-content-ready", undefined],
    [publisher, "submit-for-review", undefined],
    [client, "approve-content", undefined],
    [publisher, "mark-published", { url: "https://techinsider.example.com/c" }],
  ] as const) {
    const r = await call("POST", `/orders/${order.id}/${path}`, actor as string, body as any)
    if (r.status >= 400) throw new Error(`setup ${path} failed: ${JSON.stringify(r.data)}`)
  }
  await call("POST", `/admin/orders/${order.id}/manual-verify`, admin)
  await call("POST", `/orders/${order.id}/confirm-delivery`, client)
  const settlement = await prisma.settlement.findFirst({ where: { orderId: order.id, status: { not: "CANCELLED" } } })
  if (!settlement) throw new Error("settlement not created")
  return { orderId: order.id, settlementId: settlement.id }
}

async function main() {
  const client = await signIn("client@guestpost.local", "Client123!")
  const publisher = await signIn("publisher@guestpost.local", "Publisher123!")
  const admin = await signIn("admin@guestpost.local", "Admin123!")

  const wallet = (await call("GET", "/billing/wallet", client)).data
  const site = await prisma.website.findFirst({ where: { domain: "techinsider.example.com" } })
  const listing = await prisma.marketplaceListing.findFirst({ where: { websiteId: site!.id, status: "APPROVED", type: "GUEST_POST" } })
  const price = Number(listing!.price)

  // ── Attack 1: double payment — N parallel submit-payment on ONE order ──
  console.log(`── Attack 1: ${PAR} parallel submit-payment on one order`)
  await call("POST", `/billing/wallet/${wallet.id}/deposit`, client, { amount: price * 2, reference: `ctest-a1-${Date.now()}` })
  const w0 = Number((await call("GET", "/billing/wallet", client)).data.availableBalance)
  const order1 = (await call("POST", "/orders", client, {
    type: "GUEST_POST", title: "ctest dbl-pay",
    items: [{ websiteId: site!.id, targetUrl: "https://example.com/1", anchorText: "x" }],
  })).data
  const payResults = await Promise.all(
    Array.from({ length: PAR }, () => call("POST", `/orders/${order1.id}/submit-payment`, client)),
  )
  const paySuccesses = payResults.filter((r) => r.status < 400).length
  const w1 = Number((await call("GET", "/billing/wallet", client)).data.availableBalance)
  check("exactly one payment succeeds", paySuccesses === 1, payResults.map((r) => r.status))
  check("wallet debited exactly once", Math.abs(w0 - w1 - price) < 0.001, { w0, w1, price })

  // ── Attack 2: over-spend — N parallel orders totaling > balance ──
  console.log(`── Attack 2: parallel order payments exceeding wallet balance`)
  const w2 = Number((await call("GET", "/billing/wallet", client)).data.availableBalance)
  const affordable = Math.floor(w2 / price)
  const attempts = affordable + 3
  const orderIds: string[] = []
  for (let i = 0; i < attempts; i++) {
    const o = (await call("POST", "/orders", client, {
      type: "GUEST_POST", title: `ctest overspend ${i}`,
      items: [{ websiteId: site!.id, targetUrl: `https://example.com/o${i}`, anchorText: "x" }],
    })).data
    orderIds.push(o.id)
  }
  const overspendResults = await Promise.all(orderIds.map((id) => call("POST", `/orders/${id}/submit-payment`, client)))
  const overspendOk = overspendResults.filter((r) => r.status < 400).length
  const w3 = Number((await call("GET", "/billing/wallet", client)).data.availableBalance)
  check("successful payments never exceed affordable count", overspendOk <= affordable, { overspendOk, affordable })
  check("wallet never negative", w3 >= -0.001, { w3 })
  check("debits equal successes * price", Math.abs(w2 - w3 - overspendOk * price) < 0.001, { w2, w3, overspendOk })

  // ── Attack 3: settlement double-release — N parallel admin-approve ──
  console.log(`── Attack 3: ${PAR} parallel admin-approve on one settlement`)
  await call("POST", `/billing/wallet/${wallet.id}/deposit`, client, { amount: price, reference: `ctest-a3-${Date.now()}` })
  const { settlementId } = await orderToSettlement(client, publisher, admin, site!.id)
  await call("POST", `/settlements/${settlementId}/customer-approve`, client)
  const balBefore = await prisma.publisherBalance.findFirstOrThrow({ where: { publisher: { email: "publisher@guestpost.local" } } })
  const releaseResults = await Promise.all(
    Array.from({ length: PAR }, () => call("POST", `/admin/settlements/${settlementId}/admin-approve`, admin)),
  )
  const releaseOk = releaseResults.filter((r) => r.status < 400).length
  const balAfter = await prisma.publisherBalance.findFirstOrThrow({ where: { id: balBefore.id } })
  const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } })
  const expectedCredit = Number(settlement.publisherAmount)
  const actualCredit = Number(balAfter.withdrawableBalance) - Number(balBefore.withdrawableBalance)
  check("exactly one admin-approve succeeds", releaseOk === 1, releaseResults.map((r) => r.status))
  check("publisher credited exactly once", Math.abs(actualCredit - expectedCredit) < 0.001, { actualCredit, expectedCredit })

  // ── Attack 4: withdrawal over-draw — N parallel withdrawals of full balance ──
  console.log(`── Attack 4: ${PAR} parallel full-balance withdrawals`)
  const bal = await prisma.publisherBalance.findUniqueOrThrow({ where: { id: balBefore.id } })
  const full = Number(bal.withdrawableBalance)
  const wdResults = await Promise.all(
    Array.from({ length: PAR }, (_, i) =>
      call("POST", "/publisher-payouts/withdrawals", publisher, { amount: full, method: "bank_transfer" })),
  )
  const wdOk = wdResults.filter((r) => r.status < 400)
  const balAfterWd = await prisma.publisherBalance.findUniqueOrThrow({ where: { id: balBefore.id } })
  check("exactly one full-balance withdrawal succeeds", wdOk.length === 1, wdResults.map((r) => r.status))
  check("withdrawable went to zero, not negative", Math.abs(Number(balAfterWd.withdrawableBalance)) < 0.001, balAfterWd.withdrawableBalance)

  // ── Attack 5: idempotency-key storm — N parallel identical withdrawals ──
  console.log(`── Attack 5: ${PAR} parallel withdrawals with the same idempotency key`)
  // give publisher fresh funds via another settlement
  await call("POST", `/billing/wallet/${wallet.id}/deposit`, client, { amount: price, reference: `ctest-a5-${Date.now()}` })
  const s2 = await orderToSettlement(client, publisher, admin, site!.id)
  await call("POST", `/settlements/${s2.settlementId}/customer-approve`, client)
  await call("POST", `/admin/settlements/${s2.settlementId}/admin-approve`, admin)
  const idemKey = `ctest-idem-${Date.now()}`
  const idemResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call("POST", "/publisher-payouts/withdrawals", publisher, { amount: 10, method: "bank_transfer", idempotencyKey: idemKey })),
  )
  const idemRows = await prisma.withdrawal.findMany({ where: { idempotencyKey: idemKey } })
  const distinctIds = new Set(idemResults.filter((r) => r.status < 400).map((r) => r.data.id))
  check("idempotency key creates exactly one withdrawal row", idemRows.length === 1, idemRows.length)
  check("all successful responses reference the same withdrawal", distinctIds.size <= 1, [...distinctIds])

  // ── Attack 6: payout execute race — N parallel execute on one APPROVED withdrawal ──
  console.log(`── Attack 6: ${PAR} parallel manual payout executions`)
  const target = idemRows[0]
  await prisma.withdrawal.update({ where: { id: target.id }, data: { availableAt: new Date() } })
  await call("PATCH", `/admin/withdrawals/${target.id}/approve`, admin)
  const execResults = await Promise.all(
    Array.from({ length: PAR }, () => call("POST", `/admin/withdrawals/${target.id}/execute`, admin, { providerName: "manual" })),
  )
  const execOk = execResults.filter((r) => r.status < 400).length
  const execRows = await prisma.payoutExecution.findMany({ where: { withdrawalId: target.id } })
  check("exactly one execution starts", execOk === 1, execResults.map((r) => r.status))
  check("exactly one execution row exists", execRows.length === 1, execRows.length)

  // ── Attack 7: double mark-paid — N parallel completions ──
  console.log(`── Attack 7: ${PAR} parallel mark-paid (double lifetimePaid guard)`)
  const paidBefore = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { id: balBefore.id } })).lifetimePaid)
  const paidResults = await Promise.all(
    Array.from({ length: PAR }, () => call("PATCH", `/admin/withdrawals/${target.id}/mark-paid`, admin)),
  )
  const paidOk = paidResults.filter((r) => r.status < 400).length
  const paidAfter = Number((await prisma.publisherBalance.findUniqueOrThrow({ where: { id: balBefore.id } })).lifetimePaid)
  check("exactly one mark-paid succeeds", paidOk === 1, paidResults.map((r) => r.status))
  check("lifetimePaid incremented exactly once", Math.abs(paidAfter - paidBefore - Number(target.amount)) < 0.001, { paidBefore, paidAfter })

  // ── Final referee ──
  const recon = (await call("GET", "/admin/reconciliation", admin)).data
  check("reconciliation after all attacks: zero drift", recon.ok === true, recon.ok ? undefined : recon)

  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1) })
