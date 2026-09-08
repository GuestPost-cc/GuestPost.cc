import crypto from "node:crypto"
import { makeOrganization, makePublisher, makeUser } from "../factories"
import { createTestDatabase, type TestDatabase } from "../helpers/test-db"

type TestPrisma = any

function databaseRuntime() {
  // The clone URL must be installed before the database package creates a
  // client. Keep the context helper lazy for the same reason as the API-key
  // isolation integration suite.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@guestpost/database") as typeof import("@guestpost/database")
}

function expectSerializedOwnerTransition(
  outcomes: PromiseSettledResult<unknown>[],
  message: RegExp,
): void {
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  )
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  )
  expect(rejected).toHaveLength(1)
  expect(String(rejected[0].reason)).toMatch(message)
}

describe("[INTEGRATION] RLS — concurrent owner preservation", () => {
  let database: TestDatabase | undefined
  let previousDatabaseUrl: string | undefined
  let firstClient: TestPrisma
  let secondClient: TestPrisma

  beforeEach(async () => {
    database = await createTestDatabase()
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = database.url

    const { PrismaService } = require("../../../common/prisma.service") as any
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

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  it("serializes simultaneous customer-owner demotions", async () => {
    const suffix = crypto.randomUUID()
    const organization = await makeOrganization(firstClient, {
      name: `RLS owner race ${suffix}`,
    })
    const [firstOwner, secondOwner] = await Promise.all([
      makeUser(firstClient, { userType: "CUSTOMER" }),
      makeUser(firstClient, { userType: "CUSTOMER" }),
    ])
    await firstClient.membership.createMany({
      data: [firstOwner, secondOwner].map((owner) => ({
        organizationId: organization.id,
        userId: owner.id,
        role: "OWNER",
        status: "ACTIVE",
      })),
    })

    const demote = (client: TestPrisma, actorId: string) =>
      databaseRuntime().withApplicationRlsContext(
        client,
        {
          workload: "API",
          actorId,
          actorKind: "CUSTOMER",
          organizationId: organization.id,
          organizationRole: "OWNER",
        },
        (tx) =>
          tx.membership.update({
            where: {
              userId_organizationId: {
                userId: actorId,
                organizationId: organization.id,
              },
            },
            data: { role: "MEMBER" },
          }),
      )

    const outcomes = await Promise.allSettled([
      demote(firstClient, firstOwner.id),
      demote(secondClient, secondOwner.id),
    ])

    expectSerializedOwnerTransition(
      outcomes,
      /cannot remove or demote the last active organization owner/i,
    )
    await expect(
      firstClient.membership.count({
        where: {
          organizationId: organization.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      }),
    ).resolves.toBe(1)
  })

  it("serializes simultaneous publisher-owner demotions", async () => {
    const suffix = crypto.randomUUID()
    const organization = await makeOrganization(firstClient, {
      name: `RLS publisher owner race ${suffix}`,
    })
    const publisher = await makePublisher(firstClient, {
      organizationId: organization.id,
    })
    const [firstOwner, secondOwner] = await Promise.all([
      makeUser(firstClient, { userType: "PUBLISHER" }),
      makeUser(firstClient, { userType: "PUBLISHER" }),
    ])
    await firstClient.publisherMembership.createMany({
      data: [firstOwner, secondOwner].map((owner) => ({
        publisherId: publisher.id,
        userId: owner.id,
        role: "PUBLISHER_OWNER",
      })),
    })

    const demote = (client: TestPrisma, actorId: string) =>
      databaseRuntime().withApplicationRlsContext(
        client,
        {
          workload: "API",
          actorId,
          actorKind: "PUBLISHER",
          publisherId: publisher.id,
          publisherRole: "PUBLISHER_OWNER",
        },
        (tx) =>
          tx.publisherMembership.update({
            where: {
              userId_publisherId: {
                userId: actorId,
                publisherId: publisher.id,
              },
            },
            data: { role: "PUBLISHER_MEMBER" },
          }),
      )

    const outcomes = await Promise.allSettled([
      demote(firstClient, firstOwner.id),
      demote(secondClient, secondOwner.id),
    ])

    expectSerializedOwnerTransition(
      outcomes,
      /cannot remove or demote the last publisher owner/i,
    )
    await expect(
      firstClient.publisherMembership.count({
        where: {
          publisherId: publisher.id,
          role: "PUBLISHER_OWNER",
        },
      }),
    ).resolves.toBe(1)
  })
})
