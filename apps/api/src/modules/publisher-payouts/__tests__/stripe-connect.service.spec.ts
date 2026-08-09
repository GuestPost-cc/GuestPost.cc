import * as stripeClient from "../../../common/stripe-client"
import { StripeConnectService } from "../stripe-connect.service"

const ORIGINAL_ENV = { ...process.env }
const WEBHOOK_CLAIM_LOCKED_AT = "2026-07-29T15:00:00.000Z"

afterEach(() => {
  jest.restoreAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

function makeService() {
  let persistedProviderAccount: any = null
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
      findUnique: jest
        .fn()
        .mockImplementation(async () => persistedProviderAccount),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        persistedProviderAccount = {
          id: "local-account-1",
          isActive: true,
          ...data,
        }
        return persistedProviderAccount
      }),
      updateManyAndReturn: jest
        .fn()
        .mockImplementation(async ({ data }: any) => {
          persistedProviderAccount = {
            id: "local-account-1",
            publisherId: "pub-1",
            provider: "stripe_connect",
            providerAccountId: "acct_1",
            isActive: true,
            ...data,
          }
          return [persistedProviderAccount]
        }),
    },
    payoutMethod: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: "method-1" }),
      update: jest.fn(),
    },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue({ id: "audit-created-1" }),
    },
    payoutWebhookEvent: {
      findUnique: jest.fn().mockResolvedValue({
        provider: "stripe_connect",
        eventType: "account.updated",
        providerAccountExternalId: "acct_1",
        status: "PROCESSING",
        attempts: 1,
        lockedAt: new Date(WEBHOOK_CLAIM_LOCKED_AT),
      }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "event-1" }]),
  }
  prisma.$transaction = jest.fn(
    async (operation: (tx: any) => Promise<unknown>) => operation(prisma),
  )
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

const WEBHOOK_SYNC_CONTEXT = {
  source: "webhook" as const,
  payoutWebhookEventId: "payout-webhook-event-1",
  claimAttempt: 1,
  claimLockedAt: WEBHOOK_CLAIM_LOCKED_AT,
}

function mockConnectedLocalIdentity(prisma: any) {
  prisma.publisherProviderAccount.findUnique.mockResolvedValue({
    id: "local-account-1",
    publisherId: "pub-1",
    provider: "stripe_connect",
    providerAccountId: "acct_1",
    lastSyncedAt: new Date("2026-07-29T14:00:00.000Z"),
  })
}

describe("StripeConnectService", () => {
  beforeEach(() => {
    process.env.STRIPE_CONNECT_ENABLED = "true"
    process.env.NEXT_PUBLIC_PUBLISHER_URL = "https://publisher.example.test"
    process.env.FINANCE_RUNTIME_MODE = "normal"
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
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CONNECT_ACCOUNT_CREATED",
        entityId: "local-account-1",
        userId: "user-1",
      }),
      prisma,
    )
    expect(prisma.publisherMembership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        publisherId: "pub-1",
        role: "PUBLISHER_OWNER",
        user: { banned: false, userType: "PUBLISHER" },
      },
      select: { id: true },
    })
  })

  it("maps Stripe onboarding SDK failures to a stable redacted 503", async () => {
    const { service } = makeService()
    const providerFailure = new Error(
      "Stripe diagnostic request-id=req_secret account=acct_secret",
    )
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: { create: jest.fn().mockRejectedValue(providerFailure) },
      accountLinks: { create: jest.fn() },
    } as any)

    let rejection: any
    try {
      await service.createOnboardingLink("pub-1", "user-1")
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({ status: 503 })
    expect(rejection.getResponse()).toEqual({
      code: "STRIPE_CONNECT_UNAVAILABLE",
      message:
        "Stripe payout setup could not be confirmed. No withdrawal was submitted. Retry or refresh the provider status later.",
    })
    expect(JSON.stringify(rejection.getResponse())).not.toMatch(
      /req_secret|acct_secret|diagnostic/,
    )
  })

  it("maps exhausted serializable account persistence retries to a stable 409", async () => {
    const { service, prisma } = makeService()
    prisma.$transaction.mockRejectedValue({ code: "P2034" })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: {
        create: jest.fn().mockResolvedValue({
          id: "acct_1",
          country: "US",
          default_currency: "usd",
        }),
      },
      accountLinks: { create: jest.fn() },
    } as any)

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "STRIPE_CONNECT_CONCURRENCY_RETRY",
        message:
          "Stripe payout state changed concurrently. Refresh and retry the operation.",
      },
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(5)
  })

  it("blocks onboarding in recovery-only mode before Stripe or local state can mutate", async () => {
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const { service, prisma } = makeService()
    const getStripe = jest.spyOn(stripeClient, "getStripeClient")

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "FINANCE_OPERATION_BLOCKED",
      }),
    })

    expect(getStripe).not.toHaveBeenCalled()
    expect(prisma.publisherProviderAccount.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("does not create an onboarding link when the atomic creation audit fails", async () => {
    const { service, prisma, audit } = makeService()
    const auditFailure = new Error("audit unavailable")
    audit.log.mockRejectedValueOnce(auditFailure)
    const createLink = jest.fn()
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: {
        create: jest.fn().mockResolvedValue({
          id: "acct_1",
          country: "US",
          default_currency: "usd",
        }),
      },
      accountLinks: { create: createLink },
    } as any)

    await expect(service.createOnboardingLink("pub-1", "user-1")).rejects.toBe(
      auditFailure,
    )

    expect(audit.log).toHaveBeenCalledWith(expect.any(Object), prisma)
    expect(createLink).not.toHaveBeenCalled()
  })

  it("does not bind a new local account when owner authority is revoked during the Stripe call", async () => {
    const { service, prisma, audit } = makeService()
    prisma.publisherMembership.findFirst
      .mockResolvedValueOnce({ id: "membership-1" })
      .mockResolvedValueOnce(null)
    const createLink = jest.fn()
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: {
        create: jest.fn().mockResolvedValue({
          id: "acct_1",
          country: "US",
          default_currency: "usd",
        }),
      },
      accountLinks: { create: createLink },
    } as any)

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).rejects.toMatchObject({ status: 403 })

    expect(prisma.publisherProviderAccount.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(createLink).not.toHaveBeenCalled()
  })

  it("discards an onboarding credential when owner authority is revoked during link creation", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    prisma.publisherMembership.findFirst
      .mockResolvedValueOnce({ id: "membership-1" })
      .mockResolvedValueOnce(null)
    const createAccount = jest.fn()
    const createLink = jest.fn().mockResolvedValue({
      url: "https://connect.stripe.test/must-not-return",
      expires_at: 1_900_000_000,
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: { create: createAccount },
      accountLinks: { create: createLink },
    } as any)

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).rejects.toMatchObject({ status: 403 })

    expect(createAccount).not.toHaveBeenCalled()
    expect(createLink).toHaveBeenCalled()
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(
      "must-not-return",
    )
  })

  it("accepts a concurrent account create only with exact identity and committed creation evidence", async () => {
    const { service, prisma } = makeService()
    const collision = {
      code: "P2002",
      meta: { target: ["publisherId", "provider"] },
    }
    prisma.publisherProviderAccount.create.mockRejectedValueOnce(collision)
    const exactWinner = {
      id: "local-account-winner",
      publisherId: "pub-1",
      provider: "stripe_connect",
      providerAccountId: "acct_1",
    }
    prisma.publisherProviderAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(exactWinner)
      .mockResolvedValue(exactWinner)
    const createLink = jest.fn().mockResolvedValue({
      url: "https://connect.stripe.test/winner-link",
      expires_at: 1_900_000_000,
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: {
        create: jest.fn().mockResolvedValue({
          id: "acct_1",
          country: "US",
          default_currency: "usd",
        }),
      },
      accountLinks: { create: createLink },
    } as any)

    await expect(
      service.createOnboardingLink("pub-1", "user-1"),
    ).resolves.toMatchObject({
      url: "https://connect.stripe.test/winner-link",
    })

    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        action: "STRIPE_CONNECT_ACCOUNT_CREATED",
        entityType: "PublisherProviderAccount",
        entityId: "local-account-winner",
      },
      select: { id: true },
    })
    expect(createLink).toHaveBeenCalledWith(
      expect.objectContaining({ account: "acct_1" }),
    )
  })

  it("rejects an account-create collision when creation audit evidence is missing", async () => {
    const { service, prisma } = makeService()
    const collision = {
      code: "P2002",
      meta: { target: ["publisherId", "provider"] },
    }
    prisma.publisherProviderAccount.create.mockRejectedValueOnce(collision)
    prisma.publisherProviderAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "local-account-winner",
        publisherId: "pub-1",
        provider: "stripe_connect",
        providerAccountId: "acct_1",
      })
    prisma.auditLog.findFirst.mockResolvedValueOnce(null)
    const createLink = jest.fn()
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      accounts: {
        create: jest.fn().mockResolvedValue({
          id: "acct_1",
          country: "US",
          default_currency: "usd",
        }),
      },
      accountLinks: { create: createLink },
    } as any)

    await expect(service.createOnboardingLink("pub-1", "user-1")).rejects.toBe(
      collision,
    )
    expect(createLink).not.toHaveBeenCalled()
  })

  it("keeps a non-USD connected account restricted and does not configure a payout schedule", async () => {
    const { service, prisma } = makeService()
    mockConnectedLocalIdentity(prisma)
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
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

    const result = await service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT)

    expect(result).toMatchObject({
      status: "RESTRICTED",
      defaultCurrency: "EUR",
      payoutScheduleConfigured: false,
    })
    expect(updateBalanceSettings).not.toHaveBeenCalled()
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requirementsDue: ["guestpost.currency.usd_required"],
        }),
      }),
    )
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
  })

  it("blocks account recovery in locked mode before Stripe or local state can be touched", async () => {
    process.env.FINANCE_RUNTIME_MODE = "locked"
    const { service, prisma } = makeService()
    const getStripe = jest.spyOn(stripeClient, "getStripeRecoveryClient")

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "FINANCE_OPERATION_BLOCKED",
      }),
    })

    expect(getStripe).not.toHaveBeenCalled()
    expect(prisma.publisherProviderAccount.findUnique).not.toHaveBeenCalled()
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("blocks publisher refresh in locked mode before reading or mutating routing state", async () => {
    process.env.FINANCE_RUNTIME_MODE = "locked"
    const { service, prisma } = makeService()

    await expect(
      service.refreshStatus("pub-1", "user-1"),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "FINANCE_OPERATION_BLOCKED",
      }),
    })

    expect(prisma.publisherMembership.findFirst).toHaveBeenCalled()
    expect(prisma.publisherProviderAccount.findUnique).not.toHaveBeenCalled()
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).not.toHaveBeenCalled()
  })

  it("records a sanitized publisher actor context in the same refresh transaction", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "acct_1",
          capabilities: { transfers: "inactive" },
          details_submitted: false,
          payouts_enabled: false,
          default_currency: "usd",
          country: "US",
          requirements: { currently_due: ["business_profile.url"] },
        }),
      },
      balanceSettings: { update: jest.fn() },
    } as any)

    await expect(
      service.refreshStatus("pub-1", "user-1"),
    ).resolves.toMatchObject({
      connected: true,
      status: "PENDING_ONBOARDING",
    })

    expect(audit.log).toHaveBeenCalledWith(
      {
        action: "STRIPE_CONNECT_ACCOUNT_REFRESHED_BY_PUBLISHER",
        entityType: "PublisherProviderAccount",
        entityId: "local-account-1",
        organizationId: "org-1",
        userId: "user-1",
        metadata: {
          publisherId: "pub-1",
          provider: "stripe_connect",
          source: "publisher_refresh",
          resultStatus: "PENDING_ONBOARDING",
          providerAccountActive: true,
        },
      },
      prisma,
    )
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(
      "business_profile.url",
    )
  })

  it("maps Stripe refresh SDK failures to the same redacted 503", async () => {
    const { service, prisma } = makeService()
    mockConnectedLocalIdentity(prisma)
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: {
        retrieve: jest
          .fn()
          .mockRejectedValue(new Error("raw Stripe response body secret")),
      },
    } as any)

    let rejection: any
    try {
      await service.refreshStatus("pub-1", "user-1")
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject({ status: 503 })
    expect(rejection.getResponse()).toMatchObject({
      code: "STRIPE_CONNECT_UNAVAILABLE",
    })
    expect(JSON.stringify(rejection.getResponse())).not.toMatch(
      /raw Stripe|response body secret/,
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("does not persist a publisher refresh when owner authority is revoked during Stripe recovery", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    prisma.publisherMembership.findFirst
      .mockResolvedValueOnce({ id: "membership-1" })
      .mockResolvedValueOnce(null)
    const retrieve = jest.fn().mockResolvedValue({
      id: "acct_1",
      capabilities: { transfers: "inactive" },
      details_submitted: false,
      payouts_enabled: false,
      default_currency: "usd",
      country: "US",
      requirements: { currently_due: [] },
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: { retrieve },
      balanceSettings: { update: jest.fn() },
    } as any)

    await expect(
      service.refreshStatus("pub-1", "user-1"),
    ).rejects.toMatchObject({ status: 403 })

    expect(retrieve).toHaveBeenCalledWith("acct_1")
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("fails the whole local sync transaction when its mandatory audit cannot commit", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    const auditFailure = new Error("audit insert failed")
    audit.log.mockRejectedValueOnce(auditFailure)
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
      balanceSettings: { update: jest.fn().mockResolvedValue({}) },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).rejects.toBe(auditFailure)

    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).toHaveBeenCalled()
    expect(prisma.payoutMethod.create).toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(expect.any(Object), prisma)
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
  })

  it("enables a USD account only after manual scheduling and stores no bank credentials", async () => {
    const { service, prisma, audit, encryption } = makeService()
    mockConnectedLocalIdentity(prisma)
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

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).resolves.toMatchObject({
      id: "local-account-1",
      publisherId: "pub-1",
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
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn.mock
        .invocationCallOrder[0],
    ).toBeLessThan(prisma.payoutMethod.findUnique.mock.invocationCallOrder[0])
    expect(audit.log).toHaveBeenCalledWith(
      {
        action: "STRIPE_CONNECT_ACCOUNT_SYNCED_FROM_WEBHOOK",
        entityType: "PublisherProviderAccount",
        entityId: "local-account-1",
        organizationId: "org-1",
        userId: null,
        metadata: {
          publisherId: "pub-1",
          provider: "stripe_connect",
          source: "webhook",
          resultStatus: "ENABLED",
          providerAccountActive: true,
          payoutWebhookEventId: "payout-webhook-event-1",
          webhookClaimAttempt: 1,
          webhookClaimLockedAt: WEBHOOK_CLAIM_LOCKED_AT,
        },
      },
      prisma,
    )
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(
      /capabilities|requirements|accountNumber|routingNumber|iban|secret/i,
    )
  })

  it("does not reactivate a provider-managed payout method disabled by an explicit lifecycle action", async () => {
    const { service, prisma, encryption } = makeService()
    mockConnectedLocalIdentity(prisma)
    prisma.payoutMethod.findUnique.mockResolvedValue({
      id: "method-disabled",
      providerAccountId: "local-account-1",
      publisherId: "pub-1",
      type: "stripe_connect",
      isActive: false,
    })
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
      balanceSettings: { update: jest.fn().mockResolvedValue({}) },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).resolves.toMatchObject({
      status: "ENABLED",
    })

    expect(prisma.payoutMethod.findUnique).toHaveBeenCalledWith({
      where: { providerAccountId: "local-account-1" },
      select: {
        id: true,
        publisherId: true,
        type: true,
        isActive: true,
      },
    })
    expect(prisma.payoutMethod.update).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
    expect(encryption.encrypt).not.toHaveBeenCalled()
  })

  it("durably disables a deleted Stripe account without rewriting payout-method evidence", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    const updateBalanceSettings = jest.fn()
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: {
        retrieve: jest.fn().mockResolvedValue({
          id: "acct_1",
          deleted: true,
        }),
      },
      balanceSettings: { update: updateBalanceSettings },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).resolves.toMatchObject({
      status: "DISABLED",
      isActive: false,
      transfersEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      payoutScheduleConfigured: false,
      requirementsDue: ["guestpost.stripe.account_deleted"],
    })

    expect(updateBalanceSettings).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.findUnique).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.update).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STRIPE_CONNECT_ACCOUNT_SYNCED_FROM_WEBHOOK",
        metadata: expect.objectContaining({
          resultStatus: "DISABLED",
          providerAccountActive: false,
        }),
      }),
      prisma,
    )
  })

  it("rejects a webhook context that is not bound to the processing account event", async () => {
    const { service, prisma } = makeService()
    mockConnectedLocalIdentity(prisma)
    prisma.payoutWebhookEvent.findUnique.mockResolvedValue({
      provider: "stripe_connect",
      eventType: "account.updated",
      providerAccountExternalId: "acct_other",
      status: "PROCESSING",
    })
    const getStripe = jest.spyOn(stripeClient, "getStripeRecoveryClient")

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).rejects.toThrow(
      "Stripe webhook event does not authorize this account refresh",
    )

    expect(getStripe).not.toHaveBeenCalled()
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).not.toHaveBeenCalled()
  })

  it("fences a webhook attempt that loses its lease during Stripe recovery", async () => {
    const { service, prisma, audit } = makeService()
    mockConnectedLocalIdentity(prisma)
    prisma.payoutWebhookEvent.findUnique
      .mockResolvedValueOnce({
        provider: "stripe_connect",
        eventType: "account.updated",
        providerAccountExternalId: "acct_1",
        status: "PROCESSING",
        attempts: 1,
        lockedAt: new Date(WEBHOOK_CLAIM_LOCKED_AT),
      })
      .mockResolvedValueOnce({
        provider: "stripe_connect",
        eventType: "account.updated",
        providerAccountExternalId: "acct_1",
        status: "PROCESSING",
        attempts: 2,
        lockedAt: new Date("2026-07-29T15:20:00.000Z"),
      })
    const retrieve = jest.fn().mockResolvedValue({
      id: "acct_1",
      capabilities: { transfers: "inactive" },
      details_submitted: false,
      payouts_enabled: false,
      default_currency: "usd",
      country: "US",
      requirements: { currently_due: [] },
    })
    jest.spyOn(stripeClient, "getStripeRecoveryClient").mockReturnValue({
      accounts: { retrieve },
      balanceSettings: { update: jest.fn() },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).rejects.toThrow(
      "Stripe webhook event does not authorize this account refresh",
    )

    expect(retrieve).toHaveBeenCalled()
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled()
    expect(
      prisma.publisherProviderAccount.updateManyAndReturn,
    ).not.toHaveBeenCalled()
    expect(prisma.payoutMethod.create).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it("retries the full atomic sync after an exact managed-method create race", async () => {
    const { service, prisma } = makeService()
    mockConnectedLocalIdentity(prisma)
    const collision = {
      code: "P2002",
      meta: { target: ["providerAccountId"] },
    }
    prisma.payoutMethod.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "method-winner",
        publisherId: "pub-1",
        type: "stripe_connect",
        isActive: false,
      })
      .mockResolvedValueOnce({
        id: "method-winner",
        publisherId: "pub-1",
        type: "stripe_connect",
        isActive: false,
      })
    prisma.payoutMethod.create.mockRejectedValueOnce(collision)
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
      balanceSettings: { update: jest.fn().mockResolvedValue({}) },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).resolves.toMatchObject({ status: "ENABLED" })

    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(prisma.payoutMethod.create).toHaveBeenCalledTimes(1)
    expect(prisma.payoutMethod.update).not.toHaveBeenCalled()
  })

  it("does not hide an unrelated or unverified unique collision", async () => {
    const { service, prisma } = makeService()
    mockConnectedLocalIdentity(prisma)
    const collision = {
      code: "P2002",
      meta: { target: ["providerAccountId"] },
    }
    prisma.payoutMethod.create.mockRejectedValueOnce(collision)
    prisma.payoutMethod.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
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
      balanceSettings: { update: jest.fn().mockResolvedValue({}) },
    } as any)

    await expect(
      service.syncAccount("acct_1", WEBHOOK_SYNC_CONTEXT),
    ).rejects.toBe(collision)
  })
})
