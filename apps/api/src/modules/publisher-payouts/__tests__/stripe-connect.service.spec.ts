import * as stripeClient from "../../../common/stripe-client"
import { StripeConnectService } from "../stripe-connect.service"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

function makeService() {
  const prisma: any = {
    publisherMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
    },
    publisher: {
      findUnique: jest.fn().mockResolvedValue({
        id: "pub-1",
        name: "Publisher",
        email: "publisher@example.test",
        organizationId: "org-1",
      }),
    },
    publisherProviderAccount: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: "local-account-1",
        ...data,
      })),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: "local-account-1",
        publisherId: "pub-1",
        provider: "stripe_connect",
        providerAccountId: "acct_1",
        ...data,
      })),
    },
    payoutMethod: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: "method-1" }),
      update: jest.fn(),
    },
  }
  const audit = { log: jest.fn().mockResolvedValue(undefined) }
  const encryption = {
    encrypt: jest.fn().mockReturnValue({
      ciphertext: "encrypted-provider-marker",
      version: 7,
    }),
  }
  return {
    service: new StripeConnectService(prisma, audit as any, encryption as any),
    prisma,
    audit,
    encryption,
  }
}

describe("StripeConnectService", () => {
  beforeEach(() => {
    process.env.STRIPE_CONNECT_ENABLED = "true"
    process.env.NEXT_PUBLIC_PUBLISHER_URL = "https://publisher.example.test"
  })

  it("uses one stable provider idempotency key and never persists the onboarding URL", async () => {
    const { service, prisma, audit } = makeService()
    const createAccount = jest.fn().mockResolvedValue({
      id: "acct_1",
      country: "US",
      default_currency: "usd",
    })
    const createLink = jest.fn().mockResolvedValue({
      url: "https://connect.stripe.test/single-use-secret",
      expires_at: 1_900_000_000,
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: { create: createAccount },
      accountLinks: { create: createLink },
    } as any)

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).resolves.toMatchObject({
      url: "https://connect.stripe.test/single-use-secret",
    })

    expect(createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "express",
        capabilities: { transfers: { requested: true } },
      }),
      { idempotencyKey: "stripe-connect-account-pub-1" },
    )
    expect(
      JSON.stringify(prisma.publisherProviderAccount.create.mock.calls),
    ).not.toContain("single-use-secret")
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(
      "single-use-secret",
    )
  })

  it("keeps a non-USD connected account restricted and does not configure a payout schedule", async () => {
    const { service, prisma } = makeService()
    const updateBalanceSettings = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "acct_1",
          capabilities: { transfers: "active" },
          details_submitted: true,
          payouts_enabled: true,
          default_currency: "eur",
          country: "DE",
          requirements: { currently_due: [] },
        }),
      },
      balanceSettings: { update: updateBalanceSettings },
    } as any)

    const result = await service.syncAccount("acct_1")

    expect(result).toMatchObject({
      status: "RESTRICTED",
      defaultCurrency: "EUR",
      payoutScheduleConfigured: false,
    })
    expect(updateBalanceSettings).not.toHaveBeenCalled()
    expect(prisma.publisherProviderAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requirementsDue: ["guestpost.currency.usd_required"],
        }),
      }),
    )
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
  })

  it("enables a USD account only after manual scheduling and stores no bank credentials", async () => {
    const { service, prisma, encryption } = makeService()
    const updateBalanceSettings = jest.fn().mockResolvedValue({})
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "acct_1",
          capabilities: { transfers: "active" },
          details_submitted: true,
          payouts_enabled: true,
          default_currency: "usd",
          country: "US",
          requirements: { currently_due: [] },
        }),
      },
      balanceSettings: { update: updateBalanceSettings },
    } as any)

    await expect(service.syncAccount("acct_1")).resolves.toMatchObject({
      status: "ENABLED",
      payoutScheduleConfigured: true,
    })
    expect(updateBalanceSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        payments: {
          payouts: {
            schedule: { interval: "manual" },
            statement_descriptor: "GPOST",
          },
        },
      }),
      { stripeAccount: "acct_1" },
    )
    expect(encryption.encrypt).toHaveBeenCalledWith({
      destinationManagedBy: "stripe",
    })
    expect(prisma.payoutMethod.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "stripe_connect",
        details: "encrypted-provider-marker",
        providerAccountId: "local-account-1",
      }),
    })
    expect(JSON.stringify(prisma.payoutMethod.create.mock.calls)).not.toMatch(
      /accountNumber|routingNumber|iban/i,
    )
  })
})
