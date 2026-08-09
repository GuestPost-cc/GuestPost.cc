/**
 * End-to-end integration test: the full money loop against a running API.
 * deposit -> order -> fulfillment -> verify -> delivery -> settlement
 * -> approval -> withdrawal -> payout -> reconciliation.
 *
 * Exit 0 = every step and every invariant held. Run: pnpm tsx scripts/integration-test.ts
 * Requires: API on :4000, seeded users (pnpm seed), publisher tier VERIFIED,
 * and manual payouts enabled in this development/test environment.
 */

import { normalizePositiveUsdMoney } from "../packages/shared/src/money"
import { loadRootEnv } from "./env"
import { fundExistingWalletForTest } from "./test-wallet-funding"

let prisma: typeof import("../packages/database/src")["prisma"]

const API = process.env.API_URL ?? "http://localhost:4000"
const H = {
  "Content-Type": "application/json",
  Origin: "http://localhost:3001",
}
type Portal = "customer" | "publisher" | "staff"
type Session = { cookie: string; origin: string; portal: Portal }
const activeSessions: Session[] = []
const SESSION_COOKIE_NAMES = new Set([
  "guestpost.session_token",
  "__Secure-guestpost.session_token",
  "guestpost-session_token",
  "__Secure-guestpost-session_token",
])

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.error(
      `  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
    )
  }
}

async function call(
  method: string,
  path: string,
  session?: Session,
  body?: unknown,
  requestHeaders?: Record<string, string>,
) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...H,
      ...(session
        ? {
            Cookie: session.cookie,
            Origin: session.origin,
            "x-csrf-protection": "1",
            "x-portal-type": session.portal,
          }
        : {}),
      ...requestHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: any
  const text = await res.text()
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data, headers: res.headers }
}

function portalOrigin(portal: Portal): string {
  if (portal === "staff") return "http://localhost:3003"
  if (portal === "publisher") return "http://localhost:3002"
  return "http://localhost:3001"
}

async function signIn(email: string, password: string, portal: Portal) {
  const r = await call(
    "POST",
    "/auth/sign-in/email",
    undefined,
    {
      email,
      password,
    },
    {
      Origin: portalOrigin(portal),
      "x-portal-type": portal,
    },
  )
  if (r.status !== 200)
    throw new Error(`sign-in failed for ${email}: ${JSON.stringify(r.data)}`)
  const setCookies =
    (
      r.headers as Headers & {
        getSetCookie?: () => string[]
      }
    ).getSetCookie?.() ?? []
  const sessionCookies = setCookies
    .map((value) => value.split(";", 1)[0] ?? "")
    .filter((value) => SESSION_COOKIE_NAMES.has(value.split("=", 1)[0] ?? ""))
  if (sessionCookies.length !== 1) {
    throw new Error(`sign-in did not establish one session for ${email}`)
  }
  const session = {
    cookie: sessionCookies[0],
    origin: portalOrigin(portal),
    portal,
  }
  activeSessions.push(session)
  return session
}

async function cleanupSessions() {
  const sessions = activeSessions.splice(0)
  const results = await Promise.allSettled(
    sessions.map((session) =>
      call("POST", "/auth/sign-out", session, undefined, {
        Origin: session.origin,
        "x-portal-type": session.portal,
      }),
    ),
  )
  if (
    results.some(
      (result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" && result.value.status >= 400),
    )
  ) {
    throw new Error("one or more integration-test sessions could not be closed")
  }
}

function paymentEvidence(order: any) {
  const expectedAmount = normalizePositiveUsdMoney(order?.amount)
  if (
    !Number.isInteger(order?.version) ||
    expectedAmount === null ||
    order?.currency !== "USD"
  ) {
    throw new Error("order response is missing canonical USD capture evidence")
  }
  return {
    expectedVersion: order.version,
    expectedAmount,
    expectedCurrency: order.currency,
  }
}

async function ensureManualPayoutMethod(publisherToken: Session) {
  const listed = await call(
    "GET",
    "/publisher-payouts/payout-methods",
    publisherToken,
  )
  if (listed.status !== 200 || !Array.isArray(listed.data)) {
    throw new Error(
      `Unable to list payout methods: ${JSON.stringify(listed.data)}`,
    )
  }
  const existing = listed.data.find(
    (method: any) =>
      method.type === "bank_transfer" &&
      method.label === "Integration Test Bank",
  )
  if (existing) return existing

  const created = await call(
    "POST",
    "/publisher-payouts/payout-methods",
    publisherToken,
    {
      type: "bank_transfer",
      label: "Integration Test Bank",
      details: {
        bankName: "Integration Test Bank",
        accountHolderName: "Integration Test Publisher",
        accountNumber: "000012345678",
      },
      isDefault: true,
    },
  )
  if (created.status >= 400) {
    throw new Error(
      `Unable to create the manual payout method required by this test. ` +
        `Run the API in development/test mode or explicitly enable certified ` +
        `legacy payout methods. Response: ${JSON.stringify(created.data)}`,
    )
  }
  return created.data
}

async function main() {
  loadRootEnv({ required: ["NODE_ENV", "DATABASE_URL"] })
  ;({ prisma } = await import("../packages/database/src"))

  console.log("── Integration: full money loop")
  const client = await signIn(
    "client@guestpost.local",
    "Client123!",
    "customer",
  )
  const publisher = await signIn(
    "publisher@guestpost.local",
    "Publisher123!",
    "publisher",
  )
  const admin = await signIn("admin@guestpost.local", "Admin123!", "staff")
  const finance = await signIn(
    "finance@guestpost.local",
    "Finance123!",
    "staff",
  )
  const financeChecker = await signIn(
    "finance-checker@guestpost.local",
    "FinanceChecker123!",
    "staff",
  )

  // Snapshot starting balances
  const wallet0 = (await call("GET", "/billing/wallet", client)).data
  const pubBal0 = (await call("GET", "/publisher-payouts/balance", publisher))
    .data
  const walletId = wallet0.id

  // Find a website-backed listing — listings without a websiteId (internal
  // services, partial seed/validation rows) can't be fulfilled by a
  // publisher, so the order would 404 at accept/publish. Mirrors the order
  // wizard, which only offers website-backed listings.
  // Must be a website owned by the SEED publisher (publisher@) — the test
  // fulfills as that account. With platform listings + other publishers'
  // listings polluting a shared dev DB, picking any website-backed listing
  // would hand the order to the wrong publisher (403 at accept).
  const seedPublisher = await prisma.publisher.findFirstOrThrow({
    where: { email: "publisher@guestpost.local" },
  })
  const listingService = await prisma.listingService.findFirstOrThrow({
    where: {
      serviceType: "GUEST_POST",
      availability: "AVAILABLE",
      listing: {
        status: "APPROVED",
        website: { publisherId: seedPublisher.id },
      },
    },
    include: {
      listing: { select: { websiteId: true } },
    },
  })
  if (!listingService.listing.websiteId) {
    throw new Error("Seed guest-post listing service has no website")
  }
  const listing = {
    websiteId: listingService.listing.websiteId,
    listingServiceId: listingService.id,
    price: Number(listingService.price),
  }
  check(
    "seed publisher has a website-backed approved listing",
    !!listing.websiteId,
  )
  const price = listing.price

  // Fund the run relative to the actual listing price — a flat amount goes
  // stale as listings change and the shared dev wallet drains across runs
  const fundAmount = price + 100
  await fundExistingWalletForTest(
    prisma,
    walletId,
    fundAmount,
    `itest-${Date.now()}`,
  )

  // Order lifecycle
  const order = (
    await call("POST", "/orders", client, {
      type: "GUEST_POST",
      title: `itest order ${Date.now()}`,
      listingServiceId: listing.listingServiceId,
      expectedListingServiceVersion: listingService.version,
      expectedPrice: listingService.price.toString(),
      expectedCurrency: listingService.currency,
      briefData: {
        kind: "GUEST_POST",
        title: "Integration test article",
        topic: "Integration test coverage for the complete order money loop",
        targetUrl: "https://example.com/x",
        anchorText: "itest",
        notes: "Created by the full-loop integration test.",
      },
      items: [
        {
          websiteId: listing.websiteId,
          targetUrl: "https://example.com/x",
          anchorText: "itest",
        },
      ],
    })
  ).data
  check("order created as DRAFT", order.status === "DRAFT", order)

  const paid = (
    await call(
      "POST",
      `/orders/${order.id}/submit-payment`,
      client,
      paymentEvidence(order),
    )
  ).data
  check("payment moves order to SUBMITTED", paid.status === "SUBMITTED", paid)

  const walletAfterPay = (await call("GET", "/billing/wallet", client)).data
  check(
    "wallet debited exactly the listing price",
    Math.abs(
      Number(wallet0.availableBalance) +
        fundAmount -
        price -
        Number(walletAfterPay.availableBalance),
    ) < 0.001,
    {
      before: wallet0.availableBalance,
      after: walletAfterPay.availableBalance,
      price,
    },
  )

  // Fulfillment state machine — publisher side
  for (const [path, expect] of [
    ["accept", "ACCEPTED"],
    ["submit-content", "CONTENT_CREATION"],
    ["mark-content-ready", "CONTENT_READY"],
    ["submit-for-review", "CUSTOMER_REVIEW"],
  ] as const) {
    const r = (
      await call(
        "POST",
        `/orders/${order.id}/${path}`,
        publisher,
        path === "submit-content"
          ? { content: "itest content body" }
          : undefined,
      )
    ).data
    check(`${path} -> ${expect}`, r.status === expect, r)
  }

  const approved = (
    await call("POST", `/orders/${order.id}/approve-content`, client)
  ).data
  check("approve-content -> APPROVED", approved.status === "APPROVED", approved)

  const published = (
    await call("POST", `/orders/${order.id}/mark-published`, publisher, {
      url: "https://techinsider.example.com/itest",
    })
  ).data
  check(
    "mark-published -> PUBLISHED",
    published.status === "PUBLISHED",
    published,
  )

  // Out-of-order action must be rejected (state machine integrity)
  const replay = await call("POST", `/orders/${order.id}/accept`, publisher)
  check("replayed accept rejected", replay.status >= 400, replay)

  const verified = (
    await call("POST", `/admin/orders/${order.id}/manual-verify`, admin, {
      method: "MANUAL_ADMIN",
    })
  ).data
  check("manual-verify -> VERIFIED", verified.status === "VERIFIED", verified)

  const delivered = (
    await call("POST", `/orders/${order.id}/confirm-delivery`, client)
  ).data
  check(
    "confirm-delivery -> DELIVERED",
    delivered.status === "DELIVERED",
    delivered,
  )

  // Settlement: two-step approval, correct split
  const settlements = (await call("GET", "/admin/settlements", admin)).data
    .items
  const settlement = settlements.find((s: any) => s.orderId === order.id)
  check("settlement auto-created on delivery", !!settlement, settlements.length)
  check(
    "settlement split conserves money",
    Math.abs(
      Number(settlement.grossAmount) -
        Number(settlement.platformFee) -
        Number(settlement.publisherAmount),
    ) < 0.001,
    settlement,
  )

  const adminFirst = await call(
    "POST",
    `/admin/settlements/${settlement.id}/admin-approve`,
    admin,
  )
  check(
    "admin approval blocked before customer approval",
    adminFirst.status >= 400,
    adminFirst,
  )

  await call("POST", `/settlements/${settlement.id}/customer-approve`, client)
  const released = (
    await call(
      "POST",
      `/admin/settlements/${settlement.id}/admin-approve`,
      admin,
    )
  ).data
  check(
    "settlement RELEASED after both approvals",
    released.status === "RELEASED",
    released,
  )

  const pubBal1 = (await call("GET", "/publisher-payouts/balance", publisher))
    .data
  const credited =
    Number(pubBal1.withdrawableBalance) - Number(pubBal0.withdrawableBalance)
  check(
    "publisher credited exactly publisherAmount",
    Math.abs(credited - Number(settlement.publisherAmount)) < 0.001,
    { credited, expected: settlement.publisherAmount },
  )

  // Withdrawal -> manual payout -> evidence-backed completion
  const payoutMethod = await ensureManualPayoutMethod(publisher)
  const wd = (
    await call("POST", "/publisher-payouts/withdrawals", publisher, {
      amount: credited,
      method: "bank_transfer",
      idempotencyKey: `itest-${order.id}`,
      payoutMethodId: payoutMethod.id,
    })
  ).data
  check("withdrawal created PENDING", wd.status === "PENDING", wd)

  const wdReplay = (
    await call("POST", "/publisher-payouts/withdrawals", publisher, {
      amount: credited,
      method: "bank_transfer",
      idempotencyKey: `itest-${order.id}`,
      payoutMethodId: payoutMethod.id,
    })
  ).data
  check(
    "idempotency-key replay returns same withdrawal",
    wdReplay.id === wd.id,
    { a: wd.id, b: wdReplay.id },
  )

  // Tier hold must block early approval — this is the fraud-window control
  const heldApprove = await call(
    "PATCH",
    `/admin/withdrawals/${wd.id}/approve`,
    admin,
  )
  check(
    "tier hold blocks early approval",
    heldApprove.status === 400 &&
      String(heldApprove.data.message).includes("tier hold"),
    heldApprove,
  )

  // Simulate hold expiry (time travel via DB — no API may shortcut a hold)
  await prisma.withdrawal.update({
    where: { id: wd.id },
    data: { availableAt: new Date() },
  })

  const wdApproved = (
    await call("PATCH", `/admin/withdrawals/${wd.id}/approve`, admin)
  ).data
  check(
    "withdrawal approved after hold expiry",
    wdApproved.status === "APPROVED",
    wdApproved,
  )

  const executeResponse = await call(
    "POST",
    `/admin/withdrawals/${wd.id}/execute`,
    finance,
    {
      providerName: "manual",
    },
  )
  check(
    "manual execution started by a checker distinct from the approver",
    executeResponse.status < 400 &&
      typeof executeResponse.data?.executionId === "string",
    executeResponse,
  )
  if (
    executeResponse.status >= 400 ||
    typeof executeResponse.data?.executionId !== "string"
  ) {
    throw new Error(
      `Manual payout execution did not start: ${JSON.stringify(executeResponse)}`,
    )
  }
  const exec = executeResponse.data

  const retiredMarkPaid = await call(
    "PATCH",
    `/admin/withdrawals/${wd.id}/mark-paid`,
    admin,
  )
  check(
    "legacy mark-paid is retired",
    retiredMarkPaid.status === 410 &&
      retiredMarkPaid.data.code === "LEGACY_MARK_PAID_RETIRED",
    retiredMarkPaid,
  )

  const manualEvidence = {
    executionId: exec.executionId,
    bankReference: `ITEST-BANK-${order.id}`.toUpperCase(),
    paidAt: new Date().toISOString(),
    reason: "Verified integration-test bank settlement receipt",
  }
  const completed = (
    await call(
      "POST",
      `/publisher-payouts/withdrawals/${wd.id}/manual-complete`,
      financeChecker,
      manualEvidence,
    )
  ).data
  check(
    "bank evidence completes the manual withdrawal",
    completed.status === "COMPLETED",
    completed,
  )

  const completedReplay = await call(
    "POST",
    `/publisher-payouts/withdrawals/${wd.id}/manual-complete`,
    financeChecker,
    manualEvidence,
  )
  check(
    "exact manual evidence replay is idempotent",
    completedReplay.status === 201 &&
      completedReplay.data.status === "COMPLETED",
    completedReplay,
  )

  const executions = (
    await call("GET", `/admin/withdrawals/${wd.id}/executions`, admin)
  ).data
  const completedExecutions = executions.filter(
    (e: any) => e.status === "COMPLETED",
  )
  check(
    "exactly one COMPLETED execution",
    completedExecutions.length === 1,
    executions.map((e: any) => e.status),
  )
  check(
    "completed execution retains manual bank evidence",
    completedExecutions[0]?.completionSource === "MANUAL_BANK_CONFIRMATION" &&
      completedExecutions[0]?.completionEvidenceRef ===
        manualEvidence.bankReference,
    completedExecutions[0],
  )

  // Final referee
  const recon = (await call("GET", "/admin/reconciliation", admin)).data
  check("reconciliation: zero drift", recon.ok === true, recon)

  console.log(`\n${passed} passed, ${failed} failed`)
  await cleanupSessions()
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error(err)
  await cleanupSessions().catch((cleanupError) => console.error(cleanupError))
  await prisma?.$disconnect()
  process.exit(1)
})
