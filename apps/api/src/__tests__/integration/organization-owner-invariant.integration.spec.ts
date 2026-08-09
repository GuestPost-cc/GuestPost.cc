import crypto from "node:crypto"
import { ConflictException } from "@nestjs/common"
import { AdminService } from "../../modules/admin/admin.service"
import { AuditService } from "../../modules/audit/audit.service"
import { IdentityService } from "../../modules/identity/identity.service"
import { createTestDatabase, type TestDatabase } from "./helpers/test-db"

jest.mock("../../common/auth-context-cache", () => ({
  invalidateAuthContext: jest.fn(),
}))

describe("[INTEGRATION] Organization owner invariant", () => {
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

  it("preserves an active owner when demotion races another owner removal", async () => {
    const suffix = crypto.randomUUID()
    const [firstOwner, secondOwner, administrator] = await Promise.all([
      firstClient.user.create({
        data: {
          email: `owner-one-${suffix}@test.local`,
          name: "Owner one",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `owner-two-${suffix}@test.local`,
          name: "Owner two",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `admin-${suffix}@test.local`,
          name: "Administrator",
          userType: "STAFF",
          emailVerified: true,
        },
      }),
    ])
    const organization = await firstClient.organization.create({
      data: {
        name: `Owner invariant ${suffix}`,
        slug: `owner-invariant-${suffix}`,
        memberships: {
          create: [
            { userId: firstOwner.id, role: "OWNER", status: "ACTIVE" },
            { userId: secondOwner.id, role: "OWNER", status: "ACTIVE" },
          ],
        },
      },
    })

    const adminService = new AdminService(
      firstClient,
      new AuditService(firstClient),
      {} as any,
    )
    const identityService = new IdentityService(
      secondClient,
      new AuditService(secondClient),
      {} as any,
    )

    const outcomes = await Promise.allSettled([
      adminService.updateUserRole(firstOwner.id, "MEMBER", administrator),
      identityService.removeMember(
        organization.id,
        firstOwner.id,
        secondOwner.id,
      ),
    ])

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1)

    const activeOwners = await firstClient.membership.findMany({
      where: {
        organizationId: organization.id,
        role: "OWNER",
        status: "ACTIVE",
      },
      select: { userId: true },
    })
    expect(activeOwners).toHaveLength(1)
  })

  it("creates only one personal organization when first role commands race", async () => {
    const suffix = crypto.randomUUID()
    const [customer, administrator] = await Promise.all([
      firstClient.user.create({
        data: {
          email: `new-customer-${suffix}@test.local`,
          name: "New customer",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `provisioning-admin-${suffix}@test.local`,
          name: "Provisioning administrator",
          userType: "STAFF",
          emailVerified: true,
        },
      }),
    ])
    const firstService = new AdminService(
      firstClient,
      new AuditService(firstClient),
      {} as any,
    )
    const secondService = new AdminService(
      secondClient,
      new AuditService(secondClient),
      {} as any,
    )

    const outcomes = await Promise.allSettled([
      firstService.updateUserRole(customer.id, "OWNER", administrator),
      secondService.updateUserRole(customer.id, "OWNER", administrator),
    ])

    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(
      true,
    )
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(ConflictException)
      }
    }

    const memberships = await firstClient.membership.findMany({
      where: { userId: customer.id },
      include: { organization: { include: { wallets: true } } },
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]).toMatchObject({
      role: "OWNER",
      status: "ACTIVE",
    })
    expect(memberships[0].organization.wallets).toHaveLength(1)
  })

  it("rolls back a customer role mutation when its audit write fails", async () => {
    const suffix = crypto.randomUUID()
    const [firstOwner, secondOwner, administrator] = await Promise.all([
      firstClient.user.create({
        data: {
          email: `rollback-owner-one-${suffix}@test.local`,
          name: "Rollback owner one",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `rollback-owner-two-${suffix}@test.local`,
          name: "Rollback owner two",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `rollback-admin-${suffix}@test.local`,
          name: "Rollback administrator",
          userType: "STAFF",
          emailVerified: true,
        },
      }),
    ])
    const organization = await firstClient.organization.create({
      data: {
        name: `Audit rollback ${suffix}`,
        slug: `audit-rollback-${suffix}`,
        memberships: {
          create: [
            { userId: firstOwner.id, role: "OWNER", status: "ACTIVE" },
            { userId: secondOwner.id, role: "OWNER", status: "ACTIVE" },
          ],
        },
      },
    })
    const failingAudit = {
      log: jest.fn().mockRejectedValue(new Error("audit unavailable")),
    }
    const service = new AdminService(
      firstClient,
      failingAudit as any,
      {} as any,
    )

    await expect(
      service.updateUserRole(firstOwner.id, "MEMBER", administrator),
    ).rejects.toThrow("audit unavailable")

    const persisted = await firstClient.membership.findUniqueOrThrow({
      where: {
        userId_organizationId: {
          userId: firstOwner.id,
          organizationId: organization.id,
        },
      },
    })
    expect(persisted.role).toBe("OWNER")
  })

  it("rolls back first-time organization provisioning when its audit fails", async () => {
    const suffix = crypto.randomUUID()
    const [customer, administrator] = await Promise.all([
      firstClient.user.create({
        data: {
          email: `provisioning-rollback-${suffix}@test.local`,
          name: "Provisioning rollback customer",
          userType: "CUSTOMER",
          emailVerified: true,
        },
      }),
      firstClient.user.create({
        data: {
          email: `provisioning-rollback-admin-${suffix}@test.local`,
          name: "Provisioning rollback administrator",
          userType: "STAFF",
          emailVerified: true,
        },
      }),
    ])
    const failingAudit = {
      log: jest.fn().mockRejectedValue(new Error("audit unavailable")),
    }
    const service = new AdminService(
      firstClient,
      failingAudit as any,
      {} as any,
    )

    await expect(
      service.updateUserRole(customer.id, "OWNER", administrator),
    ).rejects.toThrow("audit unavailable")

    const [memberships, organizations, wallets] = await Promise.all([
      firstClient.membership.count({ where: { userId: customer.id } }),
      firstClient.organization.count({
        where: { name: `Org for ${customer.email}` },
      }),
      firstClient.wallet.count({ where: { userId: customer.id } }),
    ])
    expect({ memberships, organizations, wallets }).toEqual({
      memberships: 0,
      organizations: 0,
      wallets: 0,
    })
  })
})
