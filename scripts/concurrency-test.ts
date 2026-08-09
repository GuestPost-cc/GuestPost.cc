/**
 * Concurrency attack suite: fires parallel requests at every money-moving
 * endpoint and asserts the invariants hold. The final referee is the
 * reconciliation endpoint — cached balances must still equal the ledger.
 *
 * Run: pnpm tsx scripts/concurrency-test.ts
 * Requires: API on :4000, seeded DB, manual payouts enabled, and the API test
 * process started with WITHDRAWAL_HOLD_DAYS=0. Hold enforcement is covered by
 * `pnpm test:integration:hold`; immutable withdrawal envelopes must never be
 * edited to simulate elapsed time.
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
const PAR = 10 // parallel requests per attack

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

function requireSuccess<T extends { status: number; data: any }>(
  name: string,
  response: T,
): T["data"] {
  if (response.status >= 400) {
    throw new Error(`${name} failed: ${JSON.stringify(response.data)}`)
  }
  return response.data
}

function reconciliationIssueIds(report: any): Set<string> {
  const issueArrays = [
    report?.walletDrift,
    report?.publisherDrift,
    report?.settlementDrift,
    report?.orderPaymentRecon,
    report?.refundRecon,
    report?.stuckFinancialOrders,
    report?.stuckPayouts,
  ]
  return new Set(
    issueArrays
      .flatMap((issues) => (Array.isArray(issues) ? issues : []))
      .map((issue: any) => String(issue.id)),
  )
}

function hasNoNewReconciliationIssues(
  report: any,
  baselineIssueIds: Set<string>,
): boolean {
  return (
    Number(report?.summary?.critical ?? 0) === 0 &&
    [...reconciliationIssueIds(report)].every((id) => baselineIssueIds.has(id))
  )
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
  if (r.status !== 200) throw new Error(`sign-in failed: ${email}`)
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
    throw new Error("one or more concurrency-test sessions could not be closed")
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
      method.label === "Concurrency Test Bank",
  )
  if (existing) return existing

  const created = await call(
    "POST",
    "/publisher-payouts/payout-methods",
    publisherToken,
    {
      type: "bank_transfer",
      label: "Concurrency Test Bank",
      details: {
        bankName: "Concurrency Test Bank",
        accountHolderName: "Concurrency Test Publisher",
        accountNumber: "000087654321",
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

/** Drive one order from DRAFT to DELIVERED, return its settlement id. */
async function orderToSettlement(
  client: Session,
  publisher: Session,
  admin: Session,
  websiteId: string,
  listingService: {
    id: string
    version: number
    price: unknown
    currency: string
  },
) {
  const runId = `${Date.now()}-${Math.random()}`
  const order = (
    await call("POST", "/orders", client, {
      type: "GUEST_POST",
      title: `ctest ${runId}`,
      listingServiceId: listingService.id,
      expectedListingServiceVersion: listingService.version,
      expectedPrice: String(listingService.price),
      expectedCurrency: listingService.currency,
      briefData: {
        kind: "GUEST_POST",
        title: "Concurrency test article",
        topic: "Concurrency test coverage for financial state transitions",
        targetUrl: "https://example.com/c",
        anchorText: "ctest",
        notes: `Concurrency setup ${runId}`,
      },
      items: [
        { websiteId, targetUrl: "https://example.com/c", anchorText: "ctest" },
      ],
    })
  ).data
  for (const [actor, path, body] of [
    [client, "submit-payment", paymentEvidence(order)],
    [publisher, "accept", undefined],
    [publisher, "submit-content", { content: "ctest content" }],
    [publisher, "mark-content-ready", undefined],
    [publisher, "submit-for-review", undefined],
    [client, "approve-content", undefined],
    [publisher, "mark-published", { url: "https://techinsider.example.com/c" }],
  ] as const) {
    const r = await call(
      "POST",
      `/orders/${order.id}/${path}`,
      actor,
      body as any,
    )
    if (r.status >= 400)
      throw new Error(`setup ${path} failed: ${JSON.stringify(r.data)}`)
  }
  requireSuccess(
    "delivery evidence override",
    await call(
      "POST",
      `/admin/verification-queue/${order.id}/mark-verified`,
      admin,
      {
        reason: "OTHER",
        notes: "Local concurrency evidence-path verification",
      },
    ),
  )
  requireSuccess(
    "delivery confirmation",
    await call("POST", `/orders/${order.id}/confirm-delivery`, client),
  )
  const settlement = await prisma.settlement.findFirst({
    where: { orderId: order.id, status: { not: "CANCELLED" } },
  })
  if (!settlement) throw new Error("settlement not created")
  return { orderId: order.id, settlementId: settlement.id }
}

async function main() {
  loadRootEnv({ required: ["NODE_ENV", "DATABASE_URL"] })
  ;({ prisma } = await import("../packages/database/src"))

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
  const baselineReconciliation = requireSuccess(
    "baseline reconciliation",
    await call("GET", "/admin/reconciliation", admin),
  )
  if (Number(baselineReconciliation?.summary?.critical ?? 0) !== 0) {
    throw new Error("Baseline reconciliation contains critical money drift")
  }
  const baselineIssueIds = reconciliationIssueIds(baselineReconciliation)
  const payoutMethod = await ensureManualPayoutMethod(publisher)

  const wallet = (await call("GET", "/billing/wallet", client)).data
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
    include: { listing: { include: { website: true } } },
  })
  const site = listingService.listing.website
  if (!site) throw new Error("Concurrency listing has no publisher website")
  const price = Number(listingService.price)

  // ── Attack 1: double payment — N parallel submit-payment on ONE order ──
  console.log(`── Attack 1: ${PAR} parallel submit-payment on one order`)
  await fundExistingWalletForTest(
    prisma,
    wallet.id,
    price * 2,
    `ctest-a1-${Date.now()}`,
  )
  const w0 = Number(
    (await call("GET", "/billing/wallet", client)).data.availableBalance,
  )
  const order1 = (
    await call("POST", "/orders", client, {
      type: "GUEST_POST",
      title: "ctest dbl-pay",
      listingServiceId: listingService.id,
      expectedListingServiceVersion: listingService.version,
      expectedPrice: listingService.price.toString(),
      expectedCurrency: listingService.currency,
      briefData: {
        kind: "GUEST_POST",
        title: "Concurrency double payment",
        topic: "Concurrency coverage for duplicate customer wallet payment",
        targetUrl: "https://example.com/1",
        anchorText: "x",
      },
      items: [
        {
          websiteId: site.id,
          targetUrl: "https://example.com/1",
          anchorText: "x",
        },
      ],
    })
  ).data
  const payResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call(
        "POST",
        `/orders/${order1.id}/submit-payment`,
        client,
        paymentEvidence(order1),
      ),
    ),
  )
  const paySuccesses = payResults.filter((r) => r.status < 400).length
  const w1 = Number(
    (await call("GET", "/billing/wallet", client)).data.availableBalance,
  )
  check(
    "exactly one payment succeeds",
    paySuccesses === 1,
    payResults.map((r) => r.status),
  )
  check("wallet debited exactly once", Math.abs(w0 - w1 - price) < 0.001, {
    w0,
    w1,
    price,
  })

  // ── Attack 2: over-spend — N parallel orders totaling > balance ──
  console.log(`── Attack 2: parallel order payments exceeding wallet balance`)
  const w2 = Number(
    (await call("GET", "/billing/wallet", client)).data.availableBalance,
  )
  const affordable = Math.floor(w2 / price)
  const attempts = affordable + 3
  const orders: any[] = []
  for (let i = 0; i < attempts; i++) {
    const o = (
      await call("POST", "/orders", client, {
        type: "GUEST_POST",
        title: `ctest overspend ${i}`,
        listingServiceId: listingService.id,
        expectedListingServiceVersion: listingService.version,
        expectedPrice: listingService.price.toString(),
        expectedCurrency: listingService.currency,
        briefData: {
          kind: "GUEST_POST",
          title: `Concurrency overspend ${i}`,
          topic: "Concurrency coverage for aggregate customer wallet limits",
          targetUrl: `https://example.com/o${i}`,
          anchorText: "x",
        },
        items: [
          {
            websiteId: site.id,
            targetUrl: `https://example.com/o${i}`,
            anchorText: "x",
          },
        ],
      })
    ).data
    orders.push(o)
  }
  const overspendResults = await Promise.all(
    orders.map((order) =>
      call(
        "POST",
        `/orders/${order.id}/submit-payment`,
        client,
        paymentEvidence(order),
      ),
    ),
  )
  const overspendOk = overspendResults.filter((r) => r.status < 400).length
  const w3 = Number(
    (await call("GET", "/billing/wallet", client)).data.availableBalance,
  )
  check(
    "successful payments never exceed affordable count",
    overspendOk <= affordable,
    { overspendOk, affordable },
  )
  check("wallet never negative", w3 >= -0.001, { w3 })
  check(
    "debits equal successes * price",
    Math.abs(w2 - w3 - overspendOk * price) < 0.001,
    { w2, w3, overspendOk },
  )

  // ── Attack 3: settlement double-release — N parallel admin-approve ──
  console.log(`── Attack 3: ${PAR} parallel admin-approve on one settlement`)
  await fundExistingWalletForTest(
    prisma,
    wallet.id,
    price,
    `ctest-a3-${Date.now()}`,
  )
  const { settlementId } = await orderToSettlement(
    client,
    publisher,
    admin,
    site.id,
    listingService,
  )
  await call("POST", `/settlements/${settlementId}/customer-approve`, client)
  const balBefore = await prisma.publisherBalance.findFirstOrThrow({
    where: { publisher: { email: "publisher@guestpost.local" } },
  })
  const releaseResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call("POST", `/admin/settlements/${settlementId}/admin-approve`, admin, {
        reason: "Concurrency test verified settlement evidence",
      }),
    ),
  )
  const releaseOk = releaseResults.filter((r) => r.status < 400).length
  const balAfter = await prisma.publisherBalance.findFirstOrThrow({
    where: { id: balBefore.id },
  })
  const settlement = await prisma.settlement.findUniqueOrThrow({
    where: { id: settlementId },
  })
  const expectedCredit = Number(settlement.publisherAmount)
  const actualCredit =
    Number(balAfter.withdrawableBalance) - Number(balBefore.withdrawableBalance)
  check(
    "exactly one admin-approve succeeds",
    releaseOk === 1,
    releaseResults.map((r) => r.status),
  )
  check(
    "publisher credited exactly once",
    Math.abs(actualCredit - expectedCredit) < 0.001,
    { actualCredit, expectedCredit },
  )

  // ── Attack 4: withdrawal over-draw — N parallel withdrawals of full balance ──
  console.log(`── Attack 4: ${PAR} parallel full-balance withdrawals`)
  const bal = await prisma.publisherBalance.findUniqueOrThrow({
    where: { id: balBefore.id },
  })
  const full = Number(bal.withdrawableBalance)
  const wdResults = await Promise.all(
    Array.from({ length: PAR }, (_, i) =>
      call("POST", "/publisher-payouts/withdrawals", publisher, {
        amount: full,
        method: "bank_transfer",
        payoutMethodId: payoutMethod.id,
        idempotencyKey: `ctest-full-${Date.now()}-${i}`,
      }),
    ),
  )
  const wdOk = wdResults.filter((r) => r.status < 400)
  const balAfterWd = await prisma.publisherBalance.findUniqueOrThrow({
    where: { id: balBefore.id },
  })
  check(
    "exactly one full-balance withdrawal succeeds",
    wdOk.length === 1,
    wdResults.map((r) => r.status),
  )
  check(
    "withdrawable went to zero, not negative",
    Math.abs(Number(balAfterWd.withdrawableBalance)) < 0.001,
    balAfterWd.withdrawableBalance,
  )

  // ── Attack 5: idempotency-key storm — N parallel identical withdrawals ──
  console.log(
    `── Attack 5: ${PAR} parallel withdrawals with the same idempotency key`,
  )
  // give publisher fresh funds via another settlement
  await fundExistingWalletForTest(
    prisma,
    wallet.id,
    price,
    `ctest-a5-${Date.now()}`,
  )
  const s2 = await orderToSettlement(
    client,
    publisher,
    admin,
    site.id,
    listingService,
  )
  await call("POST", `/settlements/${s2.settlementId}/customer-approve`, client)
  requireSuccess(
    "second settlement admin approval",
    await call(
      "POST",
      `/admin/settlements/${s2.settlementId}/admin-approve`,
      admin,
      { reason: "Concurrency test verified second settlement evidence" },
    ),
  )
  const idemKey = `ctest-idem-${Date.now()}`
  const idemResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call("POST", "/publisher-payouts/withdrawals", publisher, {
        amount: 10,
        method: "bank_transfer",
        payoutMethodId: payoutMethod.id,
        idempotencyKey: idemKey,
      }),
    ),
  )
  const idemRows = await prisma.withdrawal.findMany({
    where: { idempotencyKey: idemKey },
  })
  const distinctIds = new Set(
    idemResults.filter((r) => r.status < 400).map((r) => r.data.id),
  )
  check(
    "idempotency key creates exactly one withdrawal row",
    idemRows.length === 1,
    idemRows.length,
  )
  check(
    "all successful responses reference the same withdrawal",
    distinctIds.size <= 1,
    [...distinctIds],
  )

  // ── Attack 6: payout execute race — N parallel execute on one APPROVED withdrawal ──
  console.log(`── Attack 6: ${PAR} parallel manual payout executions`)
  const target = idemRows[0]
  const approval = await call(
    "PATCH",
    `/admin/withdrawals/${target.id}/approve`,
    admin,
  )
  check(
    "payout race fixture reaches APPROVED",
    approval.status < 400 && approval.data?.status === "APPROVED",
    approval,
  )
  if (approval.status >= 400 || approval.data?.status !== "APPROVED") {
    throw new Error(
      `Payout race fixture approval failed: ${JSON.stringify(approval)}`,
    )
  }
  const execResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call("POST", `/admin/withdrawals/${target.id}/execute`, finance, {
        providerName: "manual",
        reason: "Concurrency test manual bank payout execution",
      }),
    ),
  )
  const execOk = execResults.filter((r) => r.status < 400).length
  const execRows = await prisma.payoutExecution.findMany({
    where: { withdrawalId: target.id },
  })
  check(
    "exactly one execution starts",
    execOk === 1,
    execResults.map((r) => r.status),
  )
  check(
    "exactly one execution row exists",
    execRows.length === 1,
    execRows.length,
  )
  if (execOk !== 1 || execRows.length !== 1) {
    throw new Error(
      `Payout execution race did not produce one canonical execution: ` +
        JSON.stringify({
          statuses: execResults.map((result) => result.status),
          executionCount: execRows.length,
        }),
    )
  }

  // ── Attack 7: legacy completion is retired; exact evidence replays are safe ──
  console.log(
    `── Attack 7: ${PAR} parallel evidence replays (double lifetimePaid guard)`,
  )
  const paidBefore = Number(
    (
      await prisma.publisherBalance.findUniqueOrThrow({
        where: { id: balBefore.id },
      })
    ).lifetimePaid,
  )
  const retiredMarkPaid = await call(
    "PATCH",
    `/admin/withdrawals/${target.id}/mark-paid`,
    admin,
  )
  const paidAfterRetiredRoute = Number(
    (
      await prisma.publisherBalance.findUniqueOrThrow({
        where: { id: balBefore.id },
      })
    ).lifetimePaid,
  )
  check(
    "legacy mark-paid returns 410",
    retiredMarkPaid.status === 410 &&
      retiredMarkPaid.data.code === "LEGACY_MARK_PAID_RETIRED",
    retiredMarkPaid,
  )
  check(
    "retired mark-paid does not change lifetimePaid",
    paidAfterRetiredRoute === paidBefore,
    { paidBefore, paidAfterRetiredRoute },
  )

  const manualEvidence = {
    executionId: execRows[0].id,
    withdrawalPublicReference: target.publicReference,
    bankReference: `CTEST-BANK-${target.id}`.toUpperCase(),
    paidAt: new Date().toISOString(),
    reason: "Verified concurrency-test bank settlement receipt",
  }
  const paidResults = await Promise.all(
    Array.from({ length: PAR }, () =>
      call(
        "POST",
        `/publisher-payouts/withdrawals/${target.id}/manual-complete`,
        financeChecker,
        manualEvidence,
      ),
    ),
  )
  const paidOk = paidResults.filter((r) => r.status < 400).length
  const paidAfter = Number(
    (
      await prisma.publisherBalance.findUniqueOrThrow({
        where: { id: balBefore.id },
      })
    ).lifetimePaid,
  )
  check(
    "all exact evidence replays resolve successfully",
    paidOk === PAR,
    paidResults.map((r) => r.status),
  )
  check(
    "lifetimePaid incremented exactly once",
    Math.abs(paidAfter - paidBefore - Number(target.amount)) < 0.001,
    { paidBefore, paidAfter },
  )
  const completedExecutions = await prisma.payoutExecution.findMany({
    where: { withdrawalId: target.id, status: "COMPLETED" },
  })
  const completedExecution = completedExecutions[0] as any
  check(
    "exactly one execution is completed with immutable bank evidence",
    completedExecutions.length === 1 &&
      completedExecution.completionSource === "MANUAL_BANK_CONFIRMATION" &&
      completedExecution.completionEvidenceRef === manualEvidence.bankReference,
    completedExecutions,
  )

  // ── Final referee ──
  const recon = (await call("GET", "/admin/reconciliation", admin)).data
  check(
    "reconciliation after all attacks: no new drift",
    hasNoNewReconciliationIssues(recon, baselineIssueIds),
    recon,
  )

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
