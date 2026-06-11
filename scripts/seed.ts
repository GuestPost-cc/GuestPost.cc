/**
 * Full development seed: users, roles, publisher inventory, marketplace
 * listings, and a funded customer wallet.
 *
 * Auth-sensitive steps go through the real API (better-auth password hashing,
 * role endpoints, dev deposit). The SUPER_ADMIN bootstrap and demo content go
 * directly through Prisma — there is intentionally no API path that lets a
 * user self-promote to staff.
 *
 * Usage: pnpm tsx scripts/seed.ts   (API must be running on :4000)
 */
import { prisma } from "../packages/database/src"

const API = process.env.SEED_API_URL ?? "http://localhost:4000"
const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "http://localhost:3001" }

const USERS = [
  { email: "admin@guestpost.local", password: "Admin123!", name: "Ava Admin", type: "STAFF", role: "SUPER_ADMIN" },
  { email: "finance@guestpost.local", password: "Finance123!", name: "Frank Finance", type: "STAFF", role: "FINANCE" },
  { email: "staff@guestpost.local", password: "Staff123!", name: "Ophelia Ops", type: "STAFF", role: "OPERATIONS" },
  { email: "publisher@guestpost.local", password: "Publisher123!", name: "John Publisher", type: "PUBLISHER", role: "PUBLISHER_OWNER" },
  { email: "client@guestpost.local", password: "Client123!", name: "Sarah Client", type: "CUSTOMER", role: "OWNER" },
  { email: "member@guestpost.local", password: "Member123!", name: "Mike Member", type: "CUSTOMER", role: "MEMBER" },
]

async function api(path: string, options: RequestInit = {}, token?: string) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...options,
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
  })
  const text = await res.text()
  let body: any
  try { body = JSON.parse(text) } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await api("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) })
  if (!res.ok) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(res.body)}`)
  return res.body.token
}

async function main() {
  console.log("── Phase 1: users via API (real password hashing)")
  for (const u of USERS) {
    const res = await api("/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: u.email, password: u.password, name: u.name }),
    })
    console.log(res.ok ? `  created ${u.email}` : `  ${u.email}: ${JSON.stringify(res.body).slice(0, 80)}`)
  }

  console.log("── Phase 2: staff bootstrap via DB (no self-promotion API exists, by design)")
  for (const u of USERS.filter((x) => x.type === "STAFF")) {
    const user = await prisma.user.findUnique({ where: { email: u.email } })
    if (!user) throw new Error(`Missing user ${u.email}`)
    await prisma.user.update({ where: { id: user.id }, data: { userType: "STAFF" } })
    const permissions = u.role === "SUPER_ADMIN" || u.role === "FINANCE" ? ["FINANCIAL_DATA_DECRYPT"] : []
    await prisma.staffMembership.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role: u.role as any, permissions },
      update: { role: u.role as any, permissions },
    })
    console.log(`  ${u.email} -> ${u.role}${permissions.length ? " +FINANCIAL_DATA_DECRYPT" : ""}`)
  }

  console.log("── Phase 3: customer/publisher roles via admin API")
  const adminToken = await signIn("admin@guestpost.local", "Admin123!")
  const usersRes = await api("/admin/users", {}, adminToken)
  const allUsers: any[] = usersRes.body
  for (const u of USERS.filter((x) => x.type !== "STAFF")) {
    const target = allUsers.find((x) => x.email === u.email)
    if (!target) throw new Error(`User not in admin list: ${u.email}`)
    const res = await api(`/admin/users/${target.id}/role`, { method: "PATCH", body: JSON.stringify({ role: u.role }) }, adminToken)
    console.log(res.ok ? `  ${u.email} -> ${u.role}` : `  FAILED ${u.email}: ${JSON.stringify(res.body).slice(0, 120)}`)
  }

  console.log("── Phase 4: organizations + member invite")
  const clientToken = await signIn("client@guestpost.local", "Client123!")
  const orgsRes = await api("/identity/organizations", {}, clientToken)
  let clientOrgId: string
  if (Array.isArray(orgsRes.body) && orgsRes.body.length > 0) {
    clientOrgId = orgsRes.body[0].id
    console.log(`  client org exists: ${orgsRes.body[0].name}`)
  } else {
    const orgRes = await api("/identity/organizations", {
      method: "POST",
      body: JSON.stringify({ name: "Sarah's Agency", slug: "sarahs-agency" }),
    }, clientToken)
    clientOrgId = orgRes.body.id
    console.log(`  created org: Sarah's Agency`)
  }
  const inviteRes = await api(`/identity/organizations/${clientOrgId}/invite`, {
    method: "POST",
    body: JSON.stringify({ email: "member@guestpost.local", role: "MEMBER" }),
  }, clientToken)
  console.log(inviteRes.ok ? "  invited member@ into Sarah's Agency" : `  invite: ${JSON.stringify(inviteRes.body).slice(0, 100)}`)

  console.log("── Phase 5: fund customer wallet via dev deposit")
  const walletRes = await api("/billing/wallet", {}, clientToken)
  const walletId = walletRes.body.id
  const depositRes = await api(`/billing/wallet/${walletId}/deposit`, {
    method: "POST",
    body: JSON.stringify({ amount: 5000, reference: "seed-initial-funding" }),
  }, clientToken)
  console.log(depositRes.ok ? `  wallet funded: $5000` : `  deposit failed: ${JSON.stringify(depositRes.body).slice(0, 120)}`)

  console.log("── Phase 6: publisher inventory + marketplace content via DB")
  const pubUser = await prisma.user.findUnique({
    where: { email: "publisher@guestpost.local" },
    include: { publisherMemberships: true },
  })
  const publisherId = pubUser?.publisherMemberships[0]?.publisherId
  if (!publisherId) throw new Error("Publisher entity missing — role assignment failed")

  await prisma.publisherBalance.upsert({
    where: { publisherId },
    create: { publisherId },
    update: {},
  })

  const websites = [
    { url: "https://techinsider.example.com", domain: "techinsider.example.com", name: "Tech Insider", category: "Technology", language: "en", country: "US", metrics: { domainRating: 72, traffic: 145000 } },
    { url: "https://healthdaily.example.com", domain: "healthdaily.example.com", name: "Health Daily", category: "Health", language: "en", country: "UK", metrics: { domainRating: 64, traffic: 89000 } },
    { url: "https://financehub.example.com", domain: "financehub.example.com", name: "Finance Hub", category: "Finance", language: "en", country: "US", metrics: { domainRating: 78, traffic: 210000 } },
  ]
  const siteIds: string[] = []
  for (const w of websites) {
    const site = await prisma.website.upsert({
      where: { url: w.url },
      create: { ...w, publisherId, ownershipType: "PUBLISHER", isActive: true },
      update: { publisherId, isActive: true },
    })
    siteIds.push(site.id)
    console.log(`  website: ${w.name}`)
  }

  const categories = [
    { name: "Technology", slug: "technology", description: "Tech blogs and publications", sortOrder: 1 },
    { name: "Health & Wellness", slug: "health-wellness", description: "Health publications", sortOrder: 2 },
    { name: "Finance", slug: "finance", description: "Finance and investing sites", sortOrder: 3 },
  ]
  const catIds: Record<string, string> = {}
  for (const c of categories) {
    const cat = await prisma.marketplaceCategory.upsert({
      where: { slug: c.slug },
      create: c,
      update: {},
    })
    catIds[c.slug] = cat.id
    console.log(`  category: ${c.name}`)
  }

  const listings = [
    { title: "Guest Post on Tech Insider (DR72)", slug: "guest-post-tech-insider", description: "High-authority technology publication accepting in-depth guest posts. Dofollow link included, permanent placement.", shortDescription: "DR72 tech site, dofollow, permanent", type: "GUEST_POST", price: 250, domainRating: 72, traffic: 145000, country: "US", language: "en", turnaroundDays: 7, categoryId: catIds["technology"], websiteId: siteIds[0] },
    { title: "Niche Edit on Tech Insider", slug: "niche-edit-tech-insider", description: "Contextual link inserted into existing aged article on Tech Insider.", shortDescription: "Link insert in aged content", type: "NICHE_EDIT", price: 180, domainRating: 72, traffic: 145000, country: "US", language: "en", turnaroundDays: 5, categoryId: catIds["technology"], websiteId: siteIds[0] },
    { title: "Guest Post on Health Daily (DR64)", slug: "guest-post-health-daily", description: "UK health publication with engaged readership. Editorial review, dofollow link.", shortDescription: "DR64 health site, UK audience", type: "GUEST_POST", price: 195, domainRating: 64, traffic: 89000, country: "UK", language: "en", turnaroundDays: 10, categoryId: catIds["health-wellness"], websiteId: siteIds[1] },
    { title: "Guest Post on Finance Hub (DR78)", slug: "guest-post-finance-hub", description: "Premium finance publication. Strict editorial standards, high-value placement.", shortDescription: "DR78 finance site, premium", type: "GUEST_POST", price: 420, domainRating: 78, traffic: 210000, country: "US", language: "en", turnaroundDays: 14, categoryId: catIds["finance"], websiteId: siteIds[2] },
  ]
  for (const l of listings) {
    await prisma.marketplaceListing.upsert({
      where: { slug: l.slug },
      create: { ...l, type: l.type as any, status: "APPROVED", fulfillmentType: "PUBLISHER", publisherId, publishedAt: new Date() },
      update: { status: "APPROVED", publisherId, websiteId: l.websiteId },
    })
    console.log(`  listing: ${l.title}`)
  }

  console.log("── Phase 7: payout provider rows")
  for (const p of [
    { name: "manual", displayName: "Manual Payout" },
    { name: "wise", displayName: "Wise" },
    { name: "stripe_connect", displayName: "Stripe Connect" },
  ]) {
    await prisma.payoutProvider.upsert({
      where: { name: p.name },
      create: { name: p.name, displayName: p.displayName, config: {}, isActive: p.name === "manual" },
      update: {},
    })
    console.log(`  provider: ${p.displayName}${p.name === "manual" ? " (active)" : " (inactive until API keys configured)"}`)
  }

  console.log("\nSeed complete. Credentials:")
  for (const u of USERS) console.log(`  ${u.email.padEnd(32)} ${u.password.padEnd(16)} ${u.role}`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
