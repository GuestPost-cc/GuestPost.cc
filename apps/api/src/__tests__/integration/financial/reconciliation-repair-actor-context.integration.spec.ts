import { makeUser } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

describe("[INTEGRATION] Financial repair staff actor context", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let prisma: any

  beforeAll(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url
    const { PrismaService } = require("../../../common/prisma.service") as any
    prisma = new PrismaService()
    await prisma.$connect()
  })

  afterAll(async () => {
    try {
      await prisma?.$disconnect()
    } finally {
      await database?.teardown()
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  it.each([
    "SUPER_ADMIN",
    "FINANCE",
  ] as const)("recognizes an explicitly pinned %s actor under database RLS", async (role) => {
    const actor = await makeUser(prisma, { userType: "STAFF" })
    await prisma.staffMembership.create({
      data: { userId: actor.id, role },
    })

    const { withApplicationRlsContext } =
      require("@guestpost/database") as typeof import("@guestpost/database")
    const [result] = await withApplicationRlsContext(
      prisma,
      {
        workload: "API",
        actorId: actor.id,
        actorKind: "STAFF",
        staffRole: role,
        staffPermissions: [],
      },
      (tx) =>
        tx.$queryRaw<Array<{ authorized: boolean }>>`
            SELECT guestpost_rls.staff_role_in(
              ARRAY['SUPER_ADMIN', 'FINANCE']
            ) AS authorized
          `,
    )

    expect(result?.authorized).toBe(true)
  })

  it("rejects a mismatched durable actor id", async () => {
    const actor = await makeUser(prisma, { userType: "STAFF" })
    await prisma.staffMembership.create({
      data: { userId: actor.id, role: "SUPER_ADMIN" },
    })

    const { withApplicationRlsContext } =
      require("@guestpost/database") as typeof import("@guestpost/database")
    const [result] = await withApplicationRlsContext(
      prisma,
      {
        workload: "API",
        actorId: "different-actor",
        actorKind: "STAFF",
        staffRole: "SUPER_ADMIN",
        staffPermissions: [],
      },
      (tx) =>
        tx.$queryRaw<Array<{ authorized: boolean }>>`
          SELECT guestpost_rls.staff_role_in(
            ARRAY['SUPER_ADMIN', 'FINANCE']
          ) AS authorized
        `,
    )

    expect(result?.authorized).toBe(false)
  })
})
