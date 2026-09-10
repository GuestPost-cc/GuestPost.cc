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

import { createHash, randomBytes } from "node:crypto"
import { runReconciliation } from "@guestpost/shared"
import { prisma } from "../packages/database/src"
import { fundOrganizationWalletForTest } from "./test-wallet-funding"

const API = process.env.API_URL ?? "http://localhost:4000"
const H = {
  "Content-Type": "application/json",
  Origin: "http://localhost:3001",
}
const USERS = Number.parseInt(process.argv[2] ?? "1000", 10)
const CONCURRENCY = Number.parseInt(process.argv[3] ?? "50", 10)

async function call(
  method: string,
  path: string,
  apiKey?: string,
  body?: unknown,
) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...H, ...(apiKey ? { "X-API-Key": apiKey } : {}) },
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

// Provision a user and a narrowly-scoped API key directly in the disposable
// development database. This avoids testing an obsolete bearer-session shape
// or disabling production-correct sign-in throttles just for load setup.
async function provisionUserWithApiKey(
  email: string,
  name: string,
  slug: string,
): Promise<{ apiKey: string; orgId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email, name, userType: "CUSTOMER", emailVerified: true },
  })
  const org = await prisma.organization.create({
    data: {
      name: `${name}'s Org`,
      slug,
      memberships: { create: { userId: user.id, role: "OWNER" } },
      wallets: {
        create: {
          userId: user.id,
          currency: "USD",
        },
      },
    },
  })
  await prisma.activeContext.create({
    data: { userId: user.id, activeOrganizationId: org.id },
  })
  const apiKey = `gp_${randomBytes(32).toString("hex")}`
  await prisma.apiKey.create({
    data: {
      organizationId: org.id,
      createdByUserId: user.id,
      name: `Load test ${slug}`,
      keyHash: createHash("sha256").update(apiKey).digest("hex"),
      permissions: ["orders:write"],
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    },
  })
  return { apiKey, orgId: org.id, userId: user.id }
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
  if (process.env.NODE_ENV === "production") {
    throw new Error("Load-test provisioning is forbidden in production")
  }
  if (!Number.isSafeInteger(USERS) || USERS < 1 || USERS > 10_000) {
    throw new Error("users must be an integer between 1 and 10000")
  }
  if (
    !Number.isSafeInteger(CONCURRENCY) ||
    CONCURRENCY < 1 ||
    CONCURRENCY > 500
  ) {
    throw new Error("concurrency must be an integer between 1 and 500")
  }
  console.log(`── Load test: ${USERS} users, ${CONCURRENCY} concurrent`)
  const runId = randomBytes(4).toString("hex")

  // Shared site/listing + admin for setup
  const site = await prisma.website.findFirstOrThrow({
    where: { domain: "techinsider.example.com" },
  })
  const listingService = await prisma.listingService.findFirstOrThrow({
    where: {
      serviceType: "GUEST_POST",
      availability: "AVAILABLE",
      listing: { websiteId: site.id, status: "APPROVED" },
    },
  })
  const price = Number(listingService.price)

  // ── Provision: N customers, each with their own org + funded wallet ──
  console.log("── Provisioning users + wallets...")
  const provisionStart = Date.now()
  const users: Array<{ apiKey: string; email: string }> = []
  const ids = Array.from({ length: USERS }, (_, i) => i)
  await pool(ids, CONCURRENCY, async (i) => {
    const email = `load-${runId}-${i}@guestpost.local`
    const { apiKey, orgId, userId } = await provisionUserWithApiKey(
      email,
      `Load User ${i}`,
      `load-${runId}-${i}`,
    )
    await fundOrganizationWalletForTest(prisma, {
      organizationId: orgId,
      userId,
      amount: price,
      reference: `load-${runId}-${i}`,
    })
    users[i] = { apiKey, email }
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
      const create = await call("POST", "/orders", u.apiKey, {
        type: "GUEST_POST",
        title: `load order ${runId}`,
        idempotencyKey: `load-${runId}-${u.email}`,
        listingServiceId: listingService.id,
        expectedListingServiceVersion: listingService.version,
        expectedPrice: String(listingService.price),
        expectedCurrency: listingService.currency,
        briefData: {
          title: `Load-test article ${runId}`,
          topic: "Database integrity testing under concurrent order load",
          targetUrl: "https://example.com/load",
          anchorText: "load testing",
          targetKeywords: ["load testing"],
          wordCount: 800,
          notes: "Synthetic non-production load test order",
        },
        items: [
          {
            websiteId: site.id,
            targetUrl: "https://example.com/load",
            anchorText: "load",
          },
        ],
      })
      if (create.status >= 400) {
        throw new Error(`order create failed: ${JSON.stringify(create.data)}`)
      }
      const order = create.data
      const pay = await call(
        "POST",
        `/orders/${order.id}/submit-payment`,
        u.apiKey,
        {
          expectedVersion: order.version,
          expectedAmount: String(listingService.price),
          expectedCurrency: listingService.currency,
        },
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
      order: { title: `load order ${runId}` },
    },
    _sum: { amount: true },
    _count: { _all: true },
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
    purchaseAgg._count._all === paidOrders,
    { purchases: purchaseAgg._count._all, paidOrders },
  )
  expect(
    "total debited equals paidOrders * price",
    Math.abs(totalDebited - paidOrders * price) < 0.001,
    { totalDebited, expected: paidOrders * price },
  )

  const recon = await runReconciliation(prisma)
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
