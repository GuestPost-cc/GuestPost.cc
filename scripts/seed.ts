/**
 * Full development seed: users, roles, publisher inventory, marketplace
 * listings, and a funded customer wallet.
 *
 * Auth-sensitive steps go through the real API (better-auth password hashing
 * and role endpoints). The SUPER_ADMIN bootstrap, test funding, and demo
 * content go directly through Prisma — there is intentionally no API path
 * that lets a user self-promote to staff.
 *
 * Usage: pnpm seed   (local API must be running on :4000)
 */
import {
  assertDevelopmentSeedDatabaseSentinel,
  assertDevelopmentSeedSafety,
  type DevelopmentSeedDatabaseIdentity,
} from "../packages/shared/src/development-seed-safety"
import {
  CURRENT_TERMS_VERSION,
  TERMS_DOCUMENT_TYPE,
} from "../packages/shared/src/legal"
import { loadRootEnv } from "./env"

loadRootEnv({
  createDevelopmentFromExample: false,
  required: ["NODE_ENV", "DATABASE_URL"],
})
const API = process.env.SEED_API_URL ?? "http://localhost:4000"
assertDevelopmentSeedSafety(process.env.NODE_ENV, process.env.DATABASE_URL, API)

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Origin: "http://localhost:3001",
}

const USERS = [
  {
    email: "admin@guestpost.local",
    password: "Admin123!",
    name: "Admin",
    type: "STAFF",
    role: "SUPER_ADMIN",
  },
  {
    email: "finance@guestpost.local",
    password: "Finance123!",
    name: "Frank Finance",
    type: "STAFF",
    role: "FINANCE",
  },
  {
    email: "finance-checker@guestpost.local",
    password: "FinanceChecker123!",
    name: "Fiona Finance Checker",
    type: "STAFF",
    role: "FINANCE",
  },
  {
    email: "staff@guestpost.local",
    password: "Staff123!",
    name: "Ophelia Ops",
    type: "STAFF",
    role: "OPERATIONS",
  },
  {
    email: "publisher@guestpost.local",
    password: "Publisher123!",
    name: "John Publisher",
    type: "PUBLISHER",
    role: "PUBLISHER_OWNER",
  },
  {
    email: "client@guestpost.local",
    password: "Client123!",
    name: "Sarah Client",
    type: "CUSTOMER",
    role: "OWNER",
  },
  {
    email: "member@guestpost.local",
    password: "Member123!",
    name: "Mike Member",
    type: "CUSTOMER",
    role: "MEMBER",
  },
]

async function api(
  path: string,
  options: RequestInit = {},
  sessionCookie?: string,
) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body, headers: res.headers }
}

type ApiResponse = Awaited<ReturnType<typeof api>>
type Portal = "customer" | "publisher" | "staff"
type VerifiedSession = {
  cookie: string
  origin: string
  userId: string
}

const SESSION_COOKIE_NAMES = new Set([
  "guestpost.session_token",
  "__Secure-guestpost.session_token",
  "guestpost-session_token",
  "__Secure-guestpost-session_token",
])

function portalOrigin(portal: Portal): string {
  if (portal === "staff") return "http://localhost:3003"
  if (portal === "publisher") return "http://localhost:3002"
  return "http://localhost:3001"
}

function apiErrorCode(response: ApiResponse): string | null {
  if (
    response.body &&
    typeof response.body === "object" &&
    typeof response.body.code === "string"
  ) {
    return response.body.code
  }
  return null
}

function requireApiSuccess(response: ApiResponse, operation: string): void {
  if (!response.ok) {
    const code = apiErrorCode(response)
    throw new Error(
      `${operation} failed (HTTP ${response.status}${code ? `, ${code}` : ""})`,
    )
  }
}

function sessionCookieFrom(response: ApiResponse): string {
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie
  const setCookieHeaders =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : [response.headers.get("set-cookie")].filter(
          (value): value is string => value !== null,
        )
  const sessionCookies = setCookieHeaders
    .map((value) => value.split(";", 1)[0])
    .filter((value) => SESSION_COOKIE_NAMES.has(value.split("=", 1)[0]))
  if (sessionCookies.length !== 1) {
    throw new Error("Authentication did not establish one session cookie")
  }
  return sessionCookies[0]
}

async function verifySession(
  response: ApiResponse,
  email: string,
  portal: Portal,
): Promise<VerifiedSession> {
  requireApiSuccess(response, `Authentication for ${email}`)
  const responseUserId = response.body?.user?.id
  if (
    typeof responseUserId !== "string" ||
    response.body?.user?.email?.toLowerCase() !== email.toLowerCase()
  ) {
    throw new Error(`Authentication response identity mismatch for ${email}`)
  }

  const cookie = sessionCookieFrom(response)
  const origin = portalOrigin(portal)
  const candidate = { cookie, origin, userId: responseUserId }
  try {
    const sessionResponse = await api(
      "/auth/get-session",
      { headers: { Origin: origin, "x-portal-type": portal } },
      cookie,
    )
    requireApiSuccess(sessionResponse, `Session verification for ${email}`)
    const expectedUserType =
      portal === "staff"
        ? "STAFF"
        : portal === "publisher"
          ? "PUBLISHER"
          : "CUSTOMER"
    if (
      sessionResponse.body?.session?.userId !== responseUserId ||
      sessionResponse.body?.user?.id !== responseUserId ||
      sessionResponse.body?.user?.email?.toLowerCase() !==
        email.toLowerCase() ||
      sessionResponse.body?.user?.userType !== expectedUserType
    ) {
      throw new Error(`Session verification identity mismatch for ${email}`)
    }
    return candidate
  } catch (verificationError) {
    try {
      await signOut(candidate)
    } catch {
      console.error(
        `Seed session cleanup also failed for user ${candidate.userId}`,
      )
    }
    throw verificationError
  }
}

async function signOut(session: VerifiedSession): Promise<void> {
  const response = await api(
    "/auth/sign-out",
    { method: "POST", headers: { Origin: session.origin } },
    session.cookie,
  )
  requireApiSuccess(response, `Session cleanup for user ${session.userId}`)
}

async function withVerifiedSession<T>(
  email: string,
  password: string,
  portal: Portal,
  action: (session: VerifiedSession) => Promise<T>,
): Promise<T> {
  const session = await signIn(email, password, portal)
  let result: T
  try {
    result = await action(session)
  } catch (actionError) {
    try {
      await signOut(session)
    } catch {
      console.error(
        `Seed session cleanup also failed for user ${session.userId}`,
      )
    }
    throw actionError
  }
  await signOut(session)
  return result
}

async function signIn(
  email: string,
  password: string,
  portal: Portal,
): Promise<VerifiedSession> {
  const res = await api("/auth/sign-in/email", {
    method: "POST",
    headers: {
      "x-portal-type": portal,
      Origin: portalOrigin(portal),
    },
    body: JSON.stringify({ email, password, rememberMe: false }),
  })
  return verifySession(res, email, portal)
}

async function assertLocalApiSeedReadiness(
  expectedIdentity: DevelopmentSeedDatabaseIdentity,
): Promise<void> {
  const res = await api("/health/development-seed-ready")
  if (
    !res.ok ||
    res.body?.status !== "ok" ||
    !["development", "test"].includes(res.body?.environment) ||
    res.body?.database !== "local-development"
  ) {
    throw new Error(
      "Local API refused development seed readiness; verify its environment and database sentinel",
    )
  }
  const apiIdentity = res.body?.databaseIdentity
  if (
    apiIdentity?.databaseName !== expectedIdentity.databaseName ||
    apiIdentity?.databaseOid !== expectedIdentity.databaseOid ||
    apiIdentity?.systemIdentifier !== expectedIdentity.systemIdentifier
  ) {
    throw new Error(
      "Local API and direct seed connection do not target the same PostgreSQL database",
    )
  }
}

async function main() {
  const [database, seedFunding, seedCatalog] = await Promise.all([
    import("../packages/database/src"),
    import("../packages/shared/src/development-seed-funding"),
    import("../packages/shared/src/development-seed-publisher-catalog"),
  ])
  const { prisma } = database
  const { DEVELOPMENT_SEED_FUNDING, ensureDevelopmentSeedFunding } = seedFunding
  const { ensureDevelopmentSeedPublisherCatalog } = seedCatalog

  try {
    const databaseIdentity = await assertDevelopmentSeedDatabaseSentinel(prisma)
    await assertLocalApiSeedReadiness(databaseIdentity)
    console.log("── Phase 1: users via API (real password hashing)")
    for (const u of USERS) {
      // Phase 7.11 — birth-time provisioning. The databaseHooks in packages/auth
      // inspect x-portal-type to set userType + provision the right entity at
      // signup time. STAFF users are created as CUSTOMER here (no STAFF portal
      // intent exists by design), then promoted to STAFF via DB in Phase 2 —
      // their customer org from the after-hook is left as a harmless empty
      // workspace (STAFF users have no customer wallet access either way).
      const portal = u.type === "PUBLISHER" ? "publisher" : "customer"
      const res = await api("/auth/sign-up/email", {
        method: "POST",
        headers: {
          "x-portal-type": portal,
          Origin:
            portal === "publisher"
              ? "http://localhost:3002"
              : "http://localhost:3001",
        },
        body: JSON.stringify({
          email: u.email,
          password: u.password,
          name: u.name,
          rememberMe: false,
          termsAccepted: true,
          termsVersion: CURRENT_TERMS_VERSION,
        }),
      })
      if (res.ok) {
        const createdSession = await verifySession(res, u.email, portal)
        await signOut(createdSession)
        console.log(`  created ${u.email}`)
        continue
      }

      // A failed signup is idempotent only for Better Auth's explicit
      // duplicate-identity response and an exact account type in the
      // sentinel-verified database. Never swallow validation, transport, or
      // policy failures and then fail later with a misleading foreign key.
      const duplicateCode = apiErrorCode(res)
      if (
        ![
          "USER_ALREADY_EXISTS",
          "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        ].includes(duplicateCode ?? "")
      ) {
        throw new Error(
          `Seed signup failed for ${u.email} (HTTP ${res.status}${duplicateCode ? `, ${duplicateCode}` : ""})`,
        )
      }
      const existing = await prisma.user.findUnique({
        where: { email: u.email },
        select: { id: true, name: true, userType: true, banned: true },
      })
      if (!existing) {
        throw new Error(
          `Duplicate seed identity for ${u.email} is missing from the sentinel database`,
        )
      }
      const isRecoverableStaffPrecursor =
        u.type === "STAFF" && existing.userType === "CUSTOMER"
      if (
        existing.name !== u.name ||
        existing.banned ||
        (existing.userType !== u.type && !isRecoverableStaffPrecursor)
      ) {
        throw new Error(
          `Duplicate seed identity for ${u.email} does not match the exact fixture profile`,
        )
      }

      const legalAcceptance = await prisma.legalAcceptance.findUnique({
        where: {
          userId_documentType_documentVersion: {
            userId: existing.id,
            documentType: TERMS_DOCUMENT_TYPE,
            documentVersion: CURRENT_TERMS_VERSION,
          },
        },
        select: { audience: true, method: true },
      })
      const expectedLegalAudience = u.type === "STAFF" ? "CUSTOMER" : u.type
      if (
        legalAcceptance?.audience !== expectedLegalAudience ||
        legalAcceptance.method !== "email"
      ) {
        throw new Error(
          `Duplicate seed identity for ${u.email} does not have exact fixture consent evidence`,
        )
      }

      if (isRecoverableStaffPrecursor) {
        const [staffMembership, moneyEvidence, orderEvidence] =
          await Promise.all([
            prisma.staffMembership.findUnique({
              where: { userId: existing.id },
              select: { id: true },
            }),
            prisma.transaction.count({
              where: { wallet: { userId: existing.id } },
            }),
            prisma.order.count({ where: { customerId: existing.id } }),
          ])
        if (
          staffMembership !== null ||
          moneyEvidence !== 0 ||
          orderEvidence !== 0
        ) {
          throw new Error(
            `Duplicate seed identity for ${u.email} does not match an exact recoverable account state`,
          )
        }
      }

      // Credential ownership is mandatory for every existing fixture, not
      // only type-recovery cases. This happens before email verification,
      // staff promotion, role reconciliation, or any synthetic money write.
      const existingPortal: Portal =
        existing.userType === "STAFF"
          ? "staff"
          : existing.userType === "PUBLISHER"
            ? "publisher"
            : "customer"
      await withVerifiedSession(
        u.email,
        u.password,
        existingPortal,
        async () => undefined,
      )
      console.log(`  existing ${u.email}`)
    }

    console.log("── Phase 1b: verify all user emails (bypass API restriction)")
    for (const u of USERS) {
      await prisma.user.update({
        where: { email: u.email },
        data: { emailVerified: true },
      })
    }
    console.log(`  verified ${USERS.length} users`)

    console.log(
      "── Phase 2: staff bootstrap via DB (no self-promotion API exists, by design)",
    )
    for (const u of USERS.filter((x) => x.type === "STAFF")) {
      const user = await prisma.user.findUnique({ where: { email: u.email } })
      if (!user) throw new Error(`Missing user ${u.email}`)
      const permissions =
        u.role === "SUPER_ADMIN" || u.role === "FINANCE"
          ? ["FINANCIAL_DATA_DECRYPT"]
          : []
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id"
            FROM "User"
            WHERE "id" = ${user.id}
            FOR UPDATE
          `
          const current = await tx.user.findUnique({
            where: { id: user.id },
            select: { userType: true },
          })
          if (
            !current ||
            (current.userType !== "CUSTOMER" && current.userType !== "STAFF")
          ) {
            throw new Error(
              `Staff fixture ${u.email} changed to an incompatible account type`,
            )
          }
          if (current.userType !== "STAFF") {
            await tx.user.update({
              where: { id: user.id },
              data: { userType: "STAFF" },
            })
          }
          const currentMembership = await tx.staffMembership.findUnique({
            where: { userId: user.id },
          })
          const currentPermissions =
            currentMembership &&
            Array.isArray(currentMembership.permissions) &&
            currentMembership.permissions.every(
              (permission) => typeof permission === "string",
            )
              ? currentMembership.permissions
              : null
          const exactPermissions =
            currentPermissions?.length === permissions.length &&
            permissions.every((value) => currentPermissions.includes(value))
          if (!currentMembership) {
            await tx.staffMembership.create({
              data: { userId: user.id, role: u.role as any, permissions },
            })
          } else if (currentMembership.role !== u.role || !exactPermissions) {
            await tx.staffMembership.update({
              where: { userId: user.id },
              data: { role: u.role as any, permissions },
            })
          }
        },
        { isolationLevel: "Serializable" },
      )
      console.log(
        `  ${u.email} -> ${u.role}${permissions.length ? " +FINANCIAL_DATA_DECRYPT" : ""}`,
      )
    }

    console.log("── Phase 2b: verify fixture credentials and portal boundaries")
    for (const u of USERS) {
      const portal: Portal =
        u.type === "STAFF"
          ? "staff"
          : u.type === "PUBLISHER"
            ? "publisher"
            : "customer"
      await withVerifiedSession(u.email, u.password, portal, async () =>
        console.log(`  verified ${u.email} on ${portal} portal`),
      )
    }

    console.log("── Phase 3: verify customer/publisher roles via admin API")
    const allUsers: any[] = await withVerifiedSession(
      "admin@guestpost.local",
      "Admin123!",
      "staff",
      async (adminSession) => {
        const users: any[] = []
        for (const fixture of USERS) {
          const usersRes = await api(
            `/admin/users?take=2&search=${encodeURIComponent(fixture.email)}`,
            { headers: { Origin: adminSession.origin } },
            adminSession.cookie,
          )
          requireApiSuccess(usersRes, `Admin user lookup for ${fixture.email}`)
          if (!Array.isArray(usersRes.body?.items)) {
            throw new Error(
              `Admin user lookup returned an unexpected response for ${fixture.email}`,
            )
          }
          const exactMatches = usersRes.body.items.filter(
            (user: any) => user?.email === fixture.email,
          )
          if (exactMatches.length !== 1) {
            throw new Error(
              `Admin user lookup did not return one exact identity for ${fixture.email}`,
            )
          }
          users.push(exactMatches[0])
        }
        // Customer roles are organization-scoped and are verified against the
        // authenticated organization response in Phase 4. Only the
        // account-scoped publisher role belongs in this admin endpoint.
        for (const u of USERS.filter((x) => x.type === "PUBLISHER")) {
          const target = users.find((x) => x.email === u.email)
          if (!target) throw new Error(`User not in admin list: ${u.email}`)
          const currentRole = target.publisherRole
          if (currentRole === u.role) {
            console.log(`  ${u.email} -> ${u.role}`)
            continue
          }
          const res = await api(
            `/admin/users/${target.id}/role`,
            {
              method: "PATCH",
              headers: {
                Origin: adminSession.origin,
                "x-csrf-protection": "1",
              },
              body: JSON.stringify({ role: u.role }),
            },
            adminSession.cookie,
          )
          requireApiSuccess(res, `Role assignment for ${u.email}`)
          if (res.body?.role !== u.role) {
            throw new Error(`Role assignment for ${u.email} was not persisted`)
          }
          console.log(`  ${u.email} -> ${u.role}`)
        }
        return users
      },
    )

    console.log("── Phase 4: organizations + member invite")
    const clientOrgId = await withVerifiedSession(
      "client@guestpost.local",
      "Client123!",
      "customer",
      async (clientSession) => {
        const orgsRes = await api(
          "/identity/organizations",
          { headers: { Origin: clientSession.origin } },
          clientSession.cookie,
        )
        requireApiSuccess(orgsRes, "Customer organization listing")
        if (!Array.isArray(orgsRes.body)) {
          throw new Error(
            "Customer organization listing returned an unexpected response",
          )
        }
        const ownerOrganizations = orgsRes.body.filter(
          (org: any) =>
            typeof org?.id === "string" &&
            typeof org?.name === "string" &&
            org.role === "OWNER",
        )
        const customerAdminRecord = allUsers.find(
          (user) => user.email === "client@guestpost.local",
        )
        if (!customerAdminRecord) {
          throw new Error(
            "Seed customer is missing from the admin user listing",
          )
        }
        const existingSeedFunding = await prisma.transaction.findUnique({
          where: { reference: DEVELOPMENT_SEED_FUNDING.reference },
          select: {
            wallet: {
              select: { organizationId: true, userId: true },
            },
          },
        })
        let clientOrganization: any
        if (existingSeedFunding) {
          clientOrganization = ownerOrganizations.find(
            (org: any) =>
              org.id === existingSeedFunding.wallet?.organizationId &&
              existingSeedFunding.wallet?.userId === customerAdminRecord.id,
          )
          if (!clientOrganization) {
            throw new Error(
              "Existing seed funding is not attached to the seeded customer's owned organization",
            )
          }
        } else if (ownerOrganizations.length === 1) {
          clientOrganization = ownerOrganizations[0]
        } else {
          throw new Error(
            "Seed customer must have exactly one owned organization before initial funding",
          )
        }
        const organizationId = clientOrganization.id as string
        console.log(`  client org exists: ${clientOrganization.name}`)

        const memberUser = await prisma.user.findUnique({
          where: { email: "member@guestpost.local" },
          select: { id: true },
        })
        if (!memberUser) throw new Error("Seed member is missing")
        const existingMemberRelationship = await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: memberUser.id,
              organizationId,
            },
          },
          select: { role: true, status: true },
        })
        if (existingMemberRelationship) {
          if (
            existingMemberRelationship.role !== "MEMBER" ||
            !["PENDING", "ACTIVE"].includes(existingMemberRelationship.status)
          ) {
            throw new Error(
              "Existing customer member relationship conflicts with the seed fixture",
            )
          }
          console.log("  exact member invitation already exists")
          return organizationId
        }

        const inviteRes = await api(
          `/identity/organizations/${organizationId}/invite`,
          {
            method: "POST",
            headers: { "x-csrf-protection": "1" },
            body: JSON.stringify({
              email: "member@guestpost.local",
              role: "MEMBER",
            }),
          },
          clientSession.cookie,
        )
        requireApiSuccess(inviteRes, "Customer member invitation")

        const createdMemberRelationship = await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: memberUser.id,
              organizationId,
            },
          },
          select: { role: true, status: true },
        })
        if (
          createdMemberRelationship?.role !== "MEMBER" ||
          createdMemberRelationship.status !== "PENDING"
        ) {
          throw new Error(
            "Customer member invitation was not persisted exactly",
          )
        }
        console.log("  invited member into customer organization")
        return organizationId
      },
    )

    console.log(
      "── Phase 5: fund customer wallet with canonical local seed evidence",
    )
    const custUser = await prisma.user.findUnique({
      where: { email: "client@guestpost.local" },
    })
    if (!custUser) throw new Error("Seed customer is missing")

    const funding = await ensureDevelopmentSeedFunding(prisma, {
      organizationId: clientOrgId,
      userId: custUser.id,
    })
    console.log(
      funding.created
        ? "  wallet initial funding created: $5000"
        : "  wallet initial funding already present: $5000",
    )

    console.log("── Phase 6: publisher inventory + marketplace content via DB")
    const pubUser = await prisma.user.findUnique({
      where: { email: "publisher@guestpost.local" },
      select: {
        id: true,
        activeContext: { select: { activePublisherId: true } },
        publisherMemberships: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            publisherId: true,
            role: true,
            publisher: { select: { organizationId: true } },
          },
        },
      },
    })
    if (pubUser?.publisherMemberships.length !== 1) {
      throw new Error(
        "Seed publisher must have exactly one publisher membership; refusing an ambiguous catalog target",
      )
    }
    const publisherMembership = pubUser.publisherMemberships[0]
    if (
      publisherMembership.role !== "PUBLISHER_OWNER" ||
      (pubUser.activeContext?.activePublisherId !== null &&
        pubUser.activeContext?.activePublisherId !== undefined &&
        pubUser.activeContext.activePublisherId !==
          publisherMembership.publisherId)
    ) {
      throw new Error(
        "Seed publisher membership or active context conflicts with the exact fixture target",
      )
    }
    const publisherId = publisherMembership.publisherId

    const superAdmin = await prisma.user.findUnique({
      where: { email: "admin@guestpost.local" },
      select: { id: true },
    })
    if (!superAdmin) throw new Error("Seed Super Admin is missing")

    await prisma.publisherBalance.upsert({
      where: { publisherId },
      create: { publisherId },
      update: {},
    })

    const catalog = await ensureDevelopmentSeedPublisherCatalog(prisma, {
      publisherId,
      organizationId: publisherMembership.publisher.organizationId,
      actorUserId: superAdmin.id,
    })
    for (const website of catalog.websites) {
      console.log(`  website: ${website.name}`)
      console.log(`  listing: ${website.listingTitle}`)
    }

    console.log("── Phase 7: payout provider rows")
    for (const p of [
      { name: "manual", displayName: "Manual Payout" },
      { name: "wise", displayName: "Wise" },
      { name: "stripe_connect", displayName: "Stripe Connect" },
    ]) {
      const provider = await prisma.payoutProvider.upsert({
        where: { name: p.name },
        create: {
          name: p.name,
          displayName: p.displayName,
          config: {},
          isActive: p.name === "manual",
        },
        update: {},
      })
      console.log(
        `  provider: ${p.displayName} (${provider.isActive ? "active" : "inactive"}; existing runtime configuration preserved)`,
      )
    }

    console.log("\nSeed complete. Local fixture users:")
    for (const u of USERS) console.log(`  ${u.email.padEnd(32)} ${u.role}`)
    console.log("  Password values are intentionally not written to logs.")
  } finally {
    // Always runs — whether the try block succeeded or threw. Keeps the
    // connection pool from leaking on partial-seed failures. The outer
    // main().catch() handles process termination; it no longer needs prisma
    // (which was scoped to main() and unavailable there — Phase 7.11 fix).
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
