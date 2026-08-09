import crypto from "node:crypto"
import { ConflictException } from "@nestjs/common"
import { AdminService } from "../../modules/admin/admin.service"
import { AuditService } from "../../modules/audit/audit.service"
import { createTestDatabase, type TestDatabase } from "./helpers/test-db"

jest.mock("../../common/auth-context-cache", () => ({
  invalidateAuthContext: jest.fn(),
}))

function twoPartyBarrier() {
  let arrivals = 0
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })

  return async () => {
    arrivals += 1
    if (arrivals === 2) release()
    await released
  }
}

/**
 * The pre-fix implementation counted active Super Admins through the root
 * client before either role update. Coordinating only that obsolete path
 * makes the regression deterministic: both old commands observe two and both
 * demote. The fixed implementation performs its count through the locked
 * transaction client, so this wrapper is intentionally bypassed.
 */
function coordinateLegacyRootCount(
  client: any,
  waitForPeer: () => Promise<void>,
) {
  const user = new Proxy(client.user, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property === "count") {
        return async (args: any) => {
          const activeSuperAdminCount =
            args?.where?.userType === "STAFF" &&
            args?.where?.banned === false &&
            args?.where?.staffMemberships?.some?.role === "SUPER_ADMIN"
          if (activeSuperAdminCount) await waitForPeer()
          return value.call(target, args)
        }
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "user") return user
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

describe("[INTEGRATION] Active Super Admin invariant", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let firstClient: any
  let secondClient: any

  beforeEach(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url

    const { PrismaService } = require("../../common/prisma.service") as any
    firstClient = new PrismaService()
    secondClient = new PrismaService()
    await Promise.all([firstClient.$connect(), secondClient.$connect()])
  })

  afterEach(async () => {
    await Promise.allSettled([
      firstClient?.$disconnect(),
      secondClient?.$disconnect(),
    ])
    await database?.teardown()

    if (previousDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = previousDatabaseUrl
    } else {
      delete process.env.DATABASE_URL
    }
  })

  it("preserves one active Super Admin when the only two are demoted concurrently", async () => {
    const suffix = crypto.randomUUID()
    const [firstAdmin, secondAdmin] = await Promise.all([
      firstClient.user.create({
        data: {
          email: `super-admin-one-${suffix}@test.local`,
          name: "Super Admin one",
          userType: "STAFF",
          emailVerified: true,
          staffMemberships: { create: { role: "SUPER_ADMIN" } },
        },
      }),
      firstClient.user.create({
        data: {
          email: `super-admin-two-${suffix}@test.local`,
          name: "Super Admin two",
          userType: "STAFF",
          emailVerified: true,
          staffMemberships: { create: { role: "SUPER_ADMIN" } },
        },
      }),
    ])

    const waitForLegacyCount = twoPartyBarrier()
    const firstService = new AdminService(
      coordinateLegacyRootCount(firstClient, waitForLegacyCount),
      new AuditService(firstClient),
      {} as any,
    )
    const secondService = new AdminService(
      coordinateLegacyRootCount(secondClient, waitForLegacyCount),
      new AuditService(secondClient),
      {} as any,
    )

    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const commands = [
      started.then(() =>
        firstService.updateStaffRole(firstAdmin.id, "FINANCE", secondAdmin),
      ),
      started.then(() =>
        secondService.updateStaffRole(secondAdmin.id, "FINANCE", firstAdmin),
      ),
    ]
    start()

    const outcomes = await Promise.allSettled(commands)
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1)
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(ConflictException)
    expect(rejected[0].reason.message).toBe(
      "At least one active Super Admin is required",
    )

    const [activeSuperAdmins, financeMemberships, auditRows] =
      await Promise.all([
        firstClient.user.count({
          where: {
            userType: "STAFF",
            banned: false,
            staffMemberships: { some: { role: "SUPER_ADMIN" } },
          },
        }),
        firstClient.staffMembership.count({ where: { role: "FINANCE" } }),
        firstClient.auditLog.count({
          where: {
            action: "STAFF_ROLE_UPDATE",
            entityType: "StaffMembership",
          },
        }),
      ])
    expect({ activeSuperAdmins, financeMemberships, auditRows }).toEqual({
      activeSuperAdmins: 1,
      financeMemberships: 1,
      auditRows: 1,
    })
  })
})
