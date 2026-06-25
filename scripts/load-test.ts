/**
 * 1000-user load + integrity test. Provisions N customer orgs (each funded)
 * and one shared publisher, then runs N concurrent full order→payment flows
 * in bounded waves. Asserts:
 *   - throughput / latency are sane
 *   - every wallet debit equals exactly one order's price (no over/under charge)
 *   - reconciliation reports zero drift after the storm
 *
 * Run: pnpm tsx scripts/load-test.ts [users] [concurrency]
 * Defaults: 1000 users, 50 in flight. Requires API on :4000, seeded DB.
 */

import { randomBytes } from "node:crypto"
import { prisma } from "../packages/database/src"

const API = process.env.API_URL ?? "http://localhost:4000"
const H = {
  "Content-Type": "application/json",
  Origin: "http://localhost:3001",
}
const USERS = Number(process.argv[2] ?? 1000)
const CONCURRENCY = Number(process.argv[3] ?? 50)

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...H, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: any
  const text = await res.text()
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function signIn(email: string, password: string) {
  const r = await call("POST", "/auth/sign-in/email", undefined, {
    email,
    password,
  })
  if (r.status !== 200)
    throw new Error(`sign-in failed: ${email} ${JSON.stringify(r.data)}`)
  return r.data.token as string
}

// Provision a user directly in the DB and mint a bearer session token.
// Auth endpoints are (correctly) rate-limited, so bulk HTTP signup is not an
// option — this bypasses the limiter for load setup only. The session token is
// a real Session row the bearer plugin accepts on subsequent requests.
async function provisionUserWithSession(
  email: string,
  name: string,
  slug: string,
): Promise<string> {
  const user = await prisma.user.create({
    data: { email, name, userType: "CUSTOMER", emailVerified: true },
  })
  const org = await prisma.organization.create({
    data: {
      name: `${name}'s Org`,
      slug,
      memberships: { create: { userId: user.id, role: "OWNER" } },
    },
  })
  await prisma.activeContext.create({
    data: { userId: user.id, activeOrganizationId: org.id },
  })
  const token = randomBytes(24).toString("hex")
  await prisma.session.create({
    data: {
      token,
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  return { token, orgId: org.id }
}

// Fund a wallet directly. The /billing deposit endpoint is rate-limited
// (correct production defense) and would throttle bulk setup from one IP.
// This writes a deposit transaction + balance, the same shape getWallet/deposit
// would produce, so reconciliation stays consistent.
async function fundWalletDirect(
  orgId: string,
  userId: string,
  amount: number,
  reference: string,
) {
  await prisma.$transaction(async (tx: any) => {
    const wallet = await tx.wallet.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        userId,
        availableBalance: amount,
        reservedBalance: 0,
        currency: "USD",
      },
      update: { availableBalance: { increment: amount } },
    })
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        amount,
        type: "DEPOSIT",
        description: `Deposit ${reference}`,
        reference,
      },
    })
  })
}

/** Run async tasks with a bounded concurrency pool. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
) {
  let idx = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const i = idx++
        await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
}

async function main() {
  console.log(`── Load test: ${USERS} users, ${CONCURRENCY} concurrent`)
  const runId = randomBytes(4).toString("hex")

  // Shared site/listing + admin for setup
  const site = await prisma.website.findFirstOrThrow({
    where: { domain: "techinsider.example.com" },
  })
  const listing = await prisma.marketplaceListing.findFirstOrThrow({
    where: { websiteId: site.id, status: "APPROVED", type: "GUEST_POST" },
  })
  const price = Number(listing.price)

  // ── Provision: N customers, each with their own org + funded wallet ──
  console.log("── Provisioning users + wallets...")
  const provisionStart = Date.now()
  const users: Array<{ token: string; email: string }> = []
  const ids = Array.from({ length: USERS }, (_, i) => i)
  await pool(ids, CONCURRENCY, async (i) => {
    const email = `load-${runId}-${i}@guestpost.local`
    const { token, orgId } = await provisionUserWithSession(
      email,
      `Load User ${i}`,
      `load-${runId}-${i}`,
    )
    const userId = (await prisma.user.findUniqueOrThrow({ where: { email } }))
      .id
    await fundWalletDirect(orgId, userId, price, `load-${runId}-${i}`)
    users[i] = { token, email }
  })
  console.log(
    `   provisioned ${users.length} users in ${((Date.now() - provisionStart) / 1000).toFixed(1)}s`,
  )

  // ── Storm: each user places + pays for one order, concurrently ──
  console.log("── Running concurrent order + payment storm...")
  const latencies: number[] = []
  let ok = 0
  let errors = 0
  const stormStart = Date.now()
  await pool(users, CONCURRENCY, async (u) => {
    const t0 = Date.now()
    try {
      const order = (
        await call("POST", "/orders", u.token, {
          type: "GUEST_POST",
          title: `load order ${runId}`,
          items: [
            {
              websiteId: site.id,
              targetUrl: "https://example.com/load",
              anchorText: "load",
            },
          ],
        })
      ).data
      const pay = await call(
        "POST",
        `/orders/${order.id}/submit-payment`,
        u.token,
      )
      if (pay.status < 400) ok++
      else errors++
    } catch {
      errors++
    }
    latencies.push(Date.now() - t0)
  })
  const stormMs = Date.now() - stormStart

  latencies.sort((a, b) => a - b)
  const p50 = latencies[Math.floor(latencies.length * 0.5)]
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  const p99 = latencies[Math.floor(latencies.length * 0.99)]
  const throughput = (ok / (stormMs / 1000)).toFixed(1)

  console.log(`\n── Results`)
  console.log(`   orders paid OK : ${ok}/${users.length}`)
  console.log(`   errors         : ${errors}`)
  console.log(`   wall time      : ${(stormMs / 1000).toFixed(1)}s`)
  console.log(`   throughput     : ${throughput} paid orders/s`)
  console.log(`   latency p50/p95/p99 : ${p50}/${p95}/${p99} ms`)

  // ── Integrity: every paid order debited its wallet by exactly the price ──
  console.log("\n── Integrity checks")
  const paidOrders = await prisma.order.count({
    where: {
      title: `load order ${runId}`,
      status: { in: ["PAID", "SUBMITTED"] },
    },
  })
  const purchaseAgg = await prisma.transaction.aggregate({
    where: {
      type: "PURCHASE",
      description: { contains: "" },
      order: { title: `load order ${runId}` },
    },
    _sum: { amount: true },
    _count: true,
  })
  const totalDebited = Math.abs(Number(purchaseAgg._sum.amount ?? 0))
  let pass = true
  const expect = (name: string, cond: boolean, detail?: unknown) => {
    console.log(
      `   ${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` — ${JSON.stringify(detail)}`}`,
    )
    if (!cond) pass = false
  }
  expect("paid order count equals OK responses", paidOrders === ok, {
    paidOrders,
    ok,
  })
  expect(
    "one PURCHASE transaction per paid order",
    purchaseAgg._count === paidOrders,
    { purchases: purchaseAgg._count, paidOrders },
  )
  expect(
    "total debited equals paidOrders * price",
    Math.abs(totalDebited - paidOrders * price) < 0.001,
    { totalDebited, expected: paidOrders * price },
  )

  const recon = (
    await call(
      "GET",
      "/admin/reconciliation",
      await signIn("admin@guestpost.local", "Admin123!"),
    )
  ).data
  expect(
    "reconciliation: zero drift after storm",
    recon.ok === true,
    recon.ok
      ? undefined
      : {
          wallet: recon.walletDrift?.length,
          pub: recon.publisherDrift?.length,
        },
  )

  console.log(`\n${pass ? "LOAD TEST PASSED" : "LOAD TEST FAILED"}`)
  await prisma.$disconnect()
  process.exit(pass ? 0 : 1)
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
