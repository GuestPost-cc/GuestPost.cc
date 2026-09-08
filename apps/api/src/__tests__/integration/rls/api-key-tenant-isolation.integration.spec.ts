import crypto from "node:crypto"
import { makeOrganization, makeUser } from "../factories"
import { createTestApp } from "../helpers/create-test-app"

type TestPrisma = any

function roleIdentifier(): string {
  return `gp_rls_test_${crypto.randomUUID().replaceAll("-", "")}`
}

function apiKeyData(organizationId: string, name: string) {
  return {
    organizationId,
    name,
    keyHash: crypto.createHash("sha256").update(name).digest("hex"),
    permissions: ["orders:read"],
  }
}

function databaseRuntime() {
  // The integration harness must set DATABASE_URL before the database package
  // is evaluated. Loading this lazily preserves that clone-only invariant.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@guestpost/database") as typeof import("@guestpost/database")
}

async function createOwnerTenant(prisma: TestPrisma, suffix: string) {
  const organization = await makeOrganization(prisma, {
    name: `RLS organization ${suffix}`,
  })
  const user = await makeUser(prisma, { userType: "CUSTOMER" })
  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role: "OWNER",
      status: "ACTIVE",
    },
  })
  return { organization, user }
}

async function setRole(tx: TestPrisma, role: string) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`)
}

async function withOwner(
  prisma: TestPrisma,
  role: string,
  tenant: { organization: { id: string }; user: { id: string } },
  operation: (tx: TestPrisma) => Promise<any>,
): Promise<any> {
  return databaseRuntime().withOrganizationOwnerRlsContext(
    prisma,
    {
      actorId: tenant.user.id,
      organizationId: tenant.organization.id,
      actorKind: "CUSTOMER",
      organizationRole: "OWNER",
    },
    async (tx) => {
      await setRole(tx as TestPrisma, role)
      return operation(tx as TestPrisma)
    },
  )
}

async function withPresentedKey(
  prisma: TestPrisma,
  role: string,
  keyHash: string,
  operation: (tx: TestPrisma) => Promise<any>,
): Promise<any> {
  const { Prisma } = databaseRuntime()
  return prisma.$transaction(async (tx: TestPrisma) => {
    await setRole(tx, role)
    await tx.$executeRaw(
      Prisma.sql`
        SELECT
          set_config('guestpost.rls_workload', 'API_KEY_AUTH', true),
          set_config('guestpost.rls_api_key_hash', ${keyHash}, true)
      `,
    )
    return operation(tx)
  })
}

describe("[INTEGRATION] RLS — API key tenant isolation", () => {
  it("forces context-bound CRUD isolation between two organization owners", async () => {
    const { prisma, cleanup } = await createTestApp()
    const role = roleIdentifier()

    try {
      // This disposable role is deliberately not the schema owner. FORCE RLS
      // therefore proves the policy, rather than an owner bypass, on a real
      // PostgreSQL clone.
      await prisma.$executeRawUnsafe(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      )
      await prisma.$executeRawUnsafe(`GRANT "${role}" TO "guestpost"`)
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."ApiKey" TO "${role}"`,
      )
      await prisma.$executeRawUnsafe(
        `GRANT SELECT ON TABLE public."Membership", public."User" TO "${role}"`,
      )

      const suffix = crypto.randomUUID()
      const [tenantA, tenantB] = await Promise.all([
        createOwnerTenant(prisma, `A ${suffix}`),
        createOwnerTenant(prisma, `B ${suffix}`),
      ])
      const keyA = apiKeyData(tenantA.organization.id, `key-a-${suffix}`)
      const keyB = apiKeyData(tenantB.organization.id, `key-b-${suffix}`)

      const createdA = await withOwner(prisma, role, tenantA, (tx) =>
        tx.apiKey.create({ data: keyA }),
      )
      const createdB = await withOwner(prisma, role, tenantB, (tx) =>
        tx.apiKey.create({ data: keyB }),
      )

      // No context is an explicit deny, even with ordinary relation DML.
      const noContextRows = await prisma.$transaction(
        async (tx: TestPrisma) => {
          await setRole(tx, role)
          return tx.apiKey.findMany()
        },
      )
      expect(noContextRows).toEqual([])

      await withOwner(prisma, role, tenantA, async (tx) => {
        // SELECT: tenant A cannot enumerate tenant B.
        const visible = await tx.apiKey.findMany({
          orderBy: { organizationId: "asc" },
        })
        expect(visible.map((row: { id: string }) => row.id)).toEqual([
          createdA.id,
        ])
      })

      // Keep each rejected mutation in its own transaction. PostgreSQL marks
      // a transaction aborted after an RLS error, so combining these would let
      // the later assertions pass without reaching their policy checks.
      await expect(
        withOwner(prisma, role, tenantA, (tx) =>
          tx.apiKey.create({
            data: apiKeyData(tenantB.organization.id, `forbidden-${suffix}`),
          }),
        ),
      ).rejects.toThrow(/row-level security/i)

      // UPDATE and DELETE: cross-tenant predicates match no visible target.
      await expect(
        withOwner(prisma, role, tenantA, (tx) =>
          tx.apiKey.update({
            where: { id: createdB.id },
            data: { name: "cross-tenant-update" },
          }),
        ),
      ).rejects.toMatchObject({ code: "P2025" })
      await expect(
        withOwner(prisma, role, tenantA, (tx) =>
          tx.apiKey.delete({ where: { id: createdB.id } }),
        ),
      ).rejects.toMatchObject({ code: "P2025" })

      // Verify that both cross-tenant mutations left the protected row intact.
      const tenantBAfterDeniedMutations = await withOwner(
        prisma,
        role,
        tenantB,
        (tx) => tx.apiKey.findUniqueOrThrow({ where: { id: createdB.id } }),
      )
      expect(tenantBAfterDeniedMutations.name).toBe(keyB.name)

      // The allowed tenant can perform its own INSERT, UPDATE, and DELETE.
      await withOwner(prisma, role, tenantA, async (tx) => {
        const own = await tx.apiKey.create({
          data: apiKeyData(tenantA.organization.id, `own-${suffix}`),
        })
        const updated = await tx.apiKey.update({
          where: { id: own.id },
          data: { name: `own-updated-${suffix}` },
        })
        expect(updated.name).toBe(`own-updated-${suffix}`)
        await tx.apiKey.delete({ where: { id: own.id } })
      })

      // An opaque API-key authentication path can touch only its presented key.
      await withPresentedKey(prisma, role, keyA.keyHash, async (tx) => {
        const visible = await tx.apiKey.findMany()
        expect(visible.map((row: { id: string }) => row.id)).toEqual([
          createdA.id,
        ])
        await tx.apiKey.update({
          where: { id: createdA.id },
          data: { lastUsedAt: new Date() },
        })
      })

      // STAFF and anonymous contexts do not receive an accidental bypass.
      const { Prisma } = databaseRuntime()
      const staffRows = await prisma.$transaction(async (tx: TestPrisma) => {
        await setRole(tx, role)
        await tx.$executeRaw(
          Prisma.sql`
            SELECT
              set_config('guestpost.rls_workload', 'API', true),
              set_config('guestpost.rls_actor_kind', 'STAFF', true),
              set_config('guestpost.rls_actor_id', 'staff-test', true),
              set_config('guestpost.rls_organization_role', 'SUPER_ADMIN', true)
          `,
        )
        return tx.apiKey.findMany()
      })
      expect(staffRows).toEqual([])

      const tenantBRows = await withOwner(prisma, role, tenantB, (tx) =>
        tx.apiKey.findMany(),
      )
      expect(tenantBRows.map((row: { id: string }) => row.id)).toEqual([
        createdB.id,
      ])

      // A request context captured before an authority change must not remain
      // useful after the durable membership is deactivated.
      await prisma.membership.update({
        where: {
          userId_organizationId: {
            userId: tenantA.user.id,
            organizationId: tenantA.organization.id,
          },
        },
        data: { status: "PENDING" },
      })
      const revokedTenantRows = await withOwner(prisma, role, tenantA, (tx) =>
        tx.apiKey.findMany(),
      )
      expect(revokedTenantRows).toEqual([])
    } finally {
      try {
        await prisma.$executeRawUnsafe(
          `REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public."ApiKey" FROM "${role}"`,
        )
        await prisma.$executeRawUnsafe(
          `REVOKE SELECT ON TABLE public."Membership", public."User" FROM "${role}"`,
        )
        await prisma.$executeRawUnsafe(`REVOKE "${role}" FROM "guestpost"`)
        await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)
      } finally {
        await cleanup()
      }
    }
  }, 30_000)
})
