import { createCipheriv, randomBytes, scryptSync } from "node:crypto"
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PermissionsGuard } from "../../../common/guards/permissions.guard"
import {
  PayoutEncryptionService,
  payoutMethodEncryptionContext,
  payoutProviderEncryptionContext,
} from "../payout-encryption.service"
import { StaticPayoutEncryptionKeyProvider } from "../payout-encryption-key-provider"
import { PayoutExecutionService } from "../payout-execution.service"
import { PublisherPayoutsService } from "../publisher-payouts.service"

const SECRET_DETAILS = {
  accountNumber: "DE89370400440532013000",
  routingNumber: "021000021",
  bankName: "Test Bank",
}

function makeContext(user: any, requiredPermissions?: string[]) {
  const request = { user }
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredPermissions),
  }
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  }
  return { reflector, context, request }
}

describe("PermissionsGuard — FINANCIAL_DATA_DECRYPT", () => {
  let authorities: { resolveRequest: jest.Mock }

  const staffAuthority = (
    staffRole: string | null,
    staffPermissions: string[] = [],
  ) => ({
    id: "staff-user",
    userType: "STAFF",
    staffRole,
    staffPermissions,
  })

  beforeEach(() => {
    authorities = { resolveRequest: jest.fn() }
  })

  it("denies SUPER_ADMIN without an explicit FINANCIAL_DATA_DECRYPT grant", async () => {
    authorities.resolveRequest.mockResolvedValue(staffAuthority("SUPER_ADMIN"))
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("allows SUPER_ADMIN with an explicit FINANCIAL_DATA_DECRYPT grant", async () => {
    authorities.resolveRequest.mockResolvedValue(
      staffAuthority("SUPER_ADMIN", ["FINANCIAL_DATA_DECRYPT"]),
    )
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
  })

  it("still lets SUPER_ADMIN bypass non-sensitive permissions", async () => {
    authorities.resolveRequest.mockResolvedValue(staffAuthority("SUPER_ADMIN"))
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["SOME_ORDINARY_PERMISSION"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
    expect(authorities.resolveRequest).toHaveBeenCalledTimes(1)
  })

  it("allows FINANCE staff with an explicit grant", async () => {
    authorities.resolveRequest.mockResolvedValue(
      staffAuthority("FINANCE", ["FINANCIAL_DATA_DECRYPT"]),
    )
    const { reflector, context } = makeContext(
      { id: "u2", staffRole: "FINANCE" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
  })

  it("denies a cached decrypt grant after durable permission removal", async () => {
    authorities.resolveRequest.mockResolvedValue(staffAuthority("FINANCE"))
    const { reflector, context } = makeContext(
      {
        id: "u2",
        userType: "STAFF",
        staffRole: "FINANCE",
        staffPermissions: ["FINANCIAL_DATA_DECRYPT"],
      },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("denies FINANCE staff without the grant", async () => {
    authorities.resolveRequest.mockResolvedValue(
      staffAuthority("FINANCE", ["SOMETHING_ELSE"]),
    )
    const { reflector, context } = makeContext(
      { id: "u2", staffRole: "FINANCE" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("denies users with no staff membership", async () => {
    authorities.resolveRequest.mockResolvedValue(staffAuthority(null))
    const { reflector, context } = makeContext(
      { id: "u3", staffRole: "OPERATIONS" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("denies unauthenticated requests", async () => {
    const { reflector, context } = makeContext(null, ["FINANCIAL_DATA_DECRYPT"])
    const guard = new PermissionsGuard(reflector as any, authorities as any)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe("PayoutEncryptionService", () => {
  const ORIGINAL_ENV = { ...process.env }
  const METHOD_CONTEXT = payoutMethodEncryptionContext({
    id: "method-1",
    publisherId: "publisher-1",
    type: "bank_transfer",
  })

  function provider(
    activeKeyId = "active-2026-08",
    keys: Record<string, string> = { "active-2026-08": "a".repeat(64) },
    legacyKey = "f".repeat(64),
  ) {
    return new StaticPayoutEncryptionKeyProvider({
      activeKeyId,
      keys,
      legacyKey,
    })
  }

  function clearPayoutKeyEnv() {
    delete process.env.PAYOUT_ENCRYPTION_KEYS
    delete process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID
    delete process.env.PAYOUT_ENCRYPTION_KEY
  }

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("fails closed outside tests when the v2 keyring is missing", () => {
    process.env.NODE_ENV = "production"
    clearPayoutKeyEnv()
    expect(() => new PayoutEncryptionService()).toThrow(
      /PAYOUT_ENCRYPTION_KEYS/,
    )

    process.env.NODE_ENV = "development"
    expect(() => new PayoutEncryptionService()).toThrow(
      /PAYOUT_ENCRYPTION_KEYS/,
    )
  })

  it("treats an empty optional legacy key as unset", () => {
    process.env.NODE_ENV = "development"
    process.env.PAYOUT_ENCRYPTION_KEYS = JSON.stringify({
      "active-2026-08": "a".repeat(64),
    })
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = "active-2026-08"
    process.env.PAYOUT_ENCRYPTION_KEY = ""

    expect(() => new PayoutEncryptionService()).not.toThrow()
  })

  it("does not treat the legacy key as authority to create v2 writes", () => {
    process.env.NODE_ENV = "production"
    clearPayoutKeyEnv()
    process.env.PAYOUT_ENCRYPTION_KEY = "f".repeat(64)
    expect(() => new PayoutEncryptionService()).toThrow(
      /PAYOUT_ENCRYPTION_KEYS/,
    )
  })

  it("rejects malformed, duplicate, and unbounded configured keyrings", () => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_ENCRYPTION_KEYS = "not-json"
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = "active"
    delete process.env.PAYOUT_ENCRYPTION_KEY
    expect(() => new PayoutEncryptionService()).toThrow(/valid JSON/)

    expect(
      () =>
        new StaticPayoutEncryptionKeyProvider({
          activeKeyId: "a",
          keys: { a: "1".repeat(64), b: "1".repeat(64) },
        }),
    ).toThrow(/duplicate/)

    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `key-${index}`,
        index.toString(16).padStart(64, "0"),
      ]),
    )
    expect(
      () =>
        new StaticPayoutEncryptionKeyProvider({
          activeKeyId: "key-0",
          keys: tooMany,
        }),
    ).toThrow(/between 1 and 16/)
  })

  it("rejects malformed legacy material and an active ID outside the keyring", () => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_ENCRYPTION_KEYS = JSON.stringify({
      active: "a".repeat(64),
    })
    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = "missing"
    delete process.env.PAYOUT_ENCRYPTION_KEY
    expect(() => new PayoutEncryptionService()).toThrow(/not in the keyring/)

    process.env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID = "active"
    process.env.PAYOUT_ENCRYPTION_KEY = "too-short"
    expect(() => new PayoutEncryptionService()).toThrow(
      /exactly 64 hexadecimal characters/,
    )
  })

  it("permits the deterministic fallback only in the isolated test runtime", () => {
    process.env.NODE_ENV = "test"
    clearPayoutKeyEnv()
    expect(() => new PayoutEncryptionService()).not.toThrow()

    delete process.env.JEST_WORKER_ID
    expect(() => new PayoutEncryptionService()).toThrow()

    process.env.NODE_ENV = "development"
    expect(() => new PayoutEncryptionService()).toThrow()
  })

  it("writes a v2 envelope with opaque key identity and context-bound AAD", () => {
    const svc = new PayoutEncryptionService(provider())
    const { ciphertext, version, keyId } = svc.encrypt(
      SECRET_DETAILS,
      METHOD_CONTEXT,
    )
    expect(version).toBe(2)
    expect(keyId).toBe("active-2026-08")
    expect(ciphertext).toMatch(/^p2:active-2026-08:/)
    expect(ciphertext).not.toContain("DE89")
    expect(svc.decrypt(ciphertext, version, METHOD_CONTEXT)).toEqual(
      SECRET_DETAILS,
    )
    expect(() => svc.decrypt(ciphertext, version)).toThrow(/context/)
  })

  it("rejects ciphertext transplanted between payout identities", () => {
    const svc = new PayoutEncryptionService(provider())
    const encrypted = svc.encrypt(SECRET_DETAILS, METHOD_CONTEXT)

    expect(() =>
      svc.decrypt(
        encrypted.ciphertext,
        encrypted.version,
        payoutMethodEncryptionContext({
          id: "method-2",
          publisherId: "publisher-1",
          type: "bank_transfer",
        }),
      ),
    ).toThrow()
    expect(() =>
      svc.decrypt(
        encrypted.ciphertext,
        encrypted.version,
        payoutProviderEncryptionContext({ id: "provider-1", name: "wise" }),
      ),
    ).toThrow()
  })

  it("keeps inactive key IDs decrypt-only while new writes use the active ID", () => {
    const oldService = new PayoutEncryptionService(
      provider("old-key", { "old-key": "b".repeat(64) }),
    )
    const oldCiphertext = oldService.encrypt(SECRET_DETAILS, METHOD_CONTEXT)
    const rotated = new PayoutEncryptionService(
      provider("new-key", {
        "old-key": "b".repeat(64),
        "new-key": "c".repeat(64),
      }),
    )

    expect(
      rotated.decrypt(oldCiphertext.ciphertext, 2, METHOD_CONTEXT),
    ).toEqual(SECRET_DETAILS)
    expect(rotated.encrypt(SECRET_DETAILS, METHOD_CONTEXT).keyId).toBe(
      "new-key",
    )
  })

  it("retains legacy v0/v1 reads without permitting legacy new writes", () => {
    const legacyHex = "f".repeat(64)
    const svc = new PayoutEncryptionService(
      provider(undefined, undefined, legacyHex),
    )
    const v0 = encryptLegacy(SECRET_DETAILS, legacyHex, 0)
    const v1 = encryptLegacy(SECRET_DETAILS, legacyHex, 1)

    expect(svc.decrypt(v0, 0)).toEqual(SECRET_DETAILS)
    expect(svc.decrypt(v1, 1)).toEqual(SECRET_DETAILS)
    expect(() => svc.decrypt(v1, 0)).toThrow()
    expect(svc.encrypt(SECRET_DETAILS, METHOD_CONTEXT).version).toBe(2)
  })

  it("rejects tampered ciphertext and envelope relabeling", () => {
    const svc = new PayoutEncryptionService(provider())
    const { ciphertext, version } = svc.encrypt(SECRET_DETAILS, METHOD_CONTEXT)
    const [prefix, keyId, encoded] = ciphertext.split(":")
    const raw = Buffer.from(encoded, "base64")
    raw[raw.length - 1] ^= 0xff
    expect(() =>
      svc.decrypt(
        `${prefix}:${keyId}:${raw.toString("base64")}`,
        version,
        METHOD_CONTEXT,
      ),
    ).toThrow()
    expect(() => svc.decrypt(ciphertext, 1, METHOD_CONTEXT)).toThrow(
      /does not match/,
    )
  })

  it("masks sensitive fields", () => {
    const svc = new PayoutEncryptionService()
    const masked = svc.mask(SECRET_DETAILS)
    expect(masked.accountNumber).not.toBe(SECRET_DETAILS.accountNumber)
    expect(String(masked.accountNumber)).toContain("*")
  })

  it("redacts sensitive values from log/error strings", () => {
    const svc = new PayoutEncryptionService()
    const leaky = `Provider rejected payload: {"accountNumber":"DE89370400440532013000","routingNumber":"021000021"}`
    const redacted = svc.redactSensitive(leaky)
    expect(redacted).not.toContain("DE89370400440532013000")
    expect(redacted).not.toContain("021000021")
    expect(redacted).toContain("[REDACTED]")
  })

  it("extractDisplayDetails returns only non-sensitive fields", () => {
    const svc = new PayoutEncryptionService()
    const display = svc.extractDisplayDetails(SECRET_DETAILS, "bank_transfer")
    expect(display).toEqual({ bankName: "Test Bank", last4: "3000" })
    expect(JSON.stringify(display)).not.toContain("DE89370400440532013000")
  })
})

function encryptLegacy(
  plaintext: Record<string, unknown>,
  legacyHex: string,
  version: 0 | 1,
): string {
  const master = Buffer.from(legacyHex, "hex")
  const key = version === 0 ? master : scryptSync(master, "payout-key-v1", 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}

describe("PublisherPayoutsService — decrypt access path", () => {
  let service: PublisherPayoutsService
  let prismaMock: any
  let auditMock: any
  let encryptionMock: any

  beforeEach(() => {
    auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    encryptionMock = {
      encrypt: jest.fn().mockReturnValue({ ciphertext: "enc", version: 1 }),
      decrypt: jest.fn().mockReturnValue(SECRET_DETAILS),
      extractDisplayDetails: jest
        .fn()
        .mockReturnValue({ bankName: "Test Bank", last4: "3000" }),
    }
    prismaMock = {
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "mem-1" }),
      },
      payoutMethod: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            role: "FINANCE",
            permissions: ["FINANCIAL_DATA_DECRYPT"],
            banned: false,
            userType: "STAFF",
          },
        ])
        .mockResolvedValueOnce([{ id: "pm-1" }]),
      $transaction: jest.fn((operation: (tx: any) => unknown) =>
        operation(prismaMock),
      ),
    }
    service = new PublisherPayoutsService(
      prismaMock as any,
      auditMock as any,
      {} as any,
      encryptionMock as any,
      {} as any,
    )
  })

  it("decryptPayoutMethod writes a PAYOUT_METHOD_DECRYPTED audit entry with actor, reason, IP, UA", async () => {
    prismaMock.payoutMethod.findUnique.mockResolvedValue({
      id: "pm-1",
      publisherId: "pub-1",
      type: "bank_transfer",
      details: "ciphertext",
      encryptionKeyVersion: 1,
      publisher: { organizationId: "org-1" },
    })

    const result = await service.decryptPayoutMethod(
      "pm-1",
      "staff-1",
      "KYC verification for withdrawal #42",
      "1.2.3.4",
      "TestAgent/1.0",
    )

    expect(result.details).toEqual(SECRET_DETAILS)
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_METHOD_DECRYPTED",
        entityType: "PayoutMethod",
        entityId: "pm-1",
        userId: "staff-1",
        metadata: expect.objectContaining({
          publisherId: "pub-1",
          reason: "KYC verification for withdrawal #42",
          ipAddress: "1.2.3.4",
          userAgent: "TestAgent/1.0",
        }),
      }),
      prismaMock,
    )
  })

  it("decryptPayoutMethod 404s on unknown method without decrypting", async () => {
    prismaMock.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        {
          role: "FINANCE",
          permissions: ["FINANCIAL_DATA_DECRYPT"],
          banned: false,
          userType: "STAFF",
        },
      ])
      .mockResolvedValueOnce([])

    await expect(
      service.decryptPayoutMethod(
        "nope",
        "staff-1",
        "reason text here",
        "ip",
        "ua",
      ),
    ).rejects.toThrow(NotFoundException)
    expect(encryptionMock.decrypt).not.toHaveBeenCalled()
    expect(auditMock.log).not.toHaveBeenCalled()
    expect(prismaMock.payoutMethod.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "revoked decrypt permission",
      staff: {
        role: "FINANCE",
        permissions: [],
        banned: false,
        userType: "STAFF",
      },
    },
    {
      name: "role downgrade",
      staff: {
        role: "OPERATIONS",
        permissions: ["FINANCIAL_DATA_DECRYPT"],
        banned: false,
        userType: "STAFF",
      },
    },
    {
      name: "account ban",
      staff: {
        role: "FINANCE",
        permissions: ["FINANCIAL_DATA_DECRYPT"],
        banned: true,
        userType: "STAFF",
      },
    },
  ])("revalidates $name at the service boundary", async ({ staff }) => {
    prismaMock.$queryRaw.mockReset().mockResolvedValueOnce([staff])

    await expect(
      service.decryptPayoutMethod(
        "pm-1",
        "staff-1",
        "KYC verification review",
        "1.2.3.4",
        "TestAgent/1.0",
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(prismaMock.payoutMethod.findUnique).not.toHaveBeenCalled()
    expect(encryptionMock.decrypt).not.toHaveBeenCalled()
    expect(auditMock.log).not.toHaveBeenCalled()
  })

  it("rejects an oversized reason at the service boundary before reading finance data", async () => {
    await expect(
      service.decryptPayoutMethod(
        "pm-1",
        "staff-1",
        "x".repeat(501),
        "1.2.3.4",
        "TestAgent/1.0",
      ),
    ).rejects.toThrow(/between 10 and 500/)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(encryptionMock.decrypt).not.toHaveBeenCalled()
  })

  it("listPayoutMethods never selects or returns encrypted details", async () => {
    prismaMock.payoutMethod.findMany.mockResolvedValue([
      {
        id: "pm-1",
        type: "bank_transfer",
        label: "Main",
        displayDetails: { bankName: "Test Bank", last4: "3000" },
        isDefault: true,
        isActive: true,
      },
    ])

    const result = await service.listPayoutMethods("pub-1", "user-1")

    const select = prismaMock.payoutMethod.findMany.mock.calls[0][0].select
    expect(select.details).toBeUndefined()
    expect(prismaMock.payoutMethod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publisherId: "pub-1", isActive: true },
      }),
    )
    expect(encryptionMock.decrypt).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("DE89370400440532013000")
    expect(result[0].displayDetails).toEqual({
      bankName: "Test Bank",
      last4: "3000",
    })
    expect(result[0].isActive).toBe(true)
  })

  it("keeps active but uncertified legacy rows out of the withdrawal selector", async () => {
    prismaMock.payoutMethod.findMany.mockResolvedValue([
      {
        id: "pm-paypal-legacy",
        type: "paypal",
        label: "Historical PayPal",
        displayDetails: { maskedEmail: "p***@example.test" },
        isDefault: true,
        isActive: true,
        providerAccountId: null,
        providerAccount: null,
      },
      {
        id: "pm-bank",
        type: "bank_transfer",
        label: "Manual bank",
        displayDetails: { bankName: "Test Bank", last4: "3000" },
        isDefault: false,
        isActive: true,
        providerAccountId: null,
        providerAccount: null,
      },
    ])

    const result = await service.listPayoutMethods("pub-1", "user-1")

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: "pm-bank",
      withdrawalEligibility: { executable: true, code: "READY" },
    })
  })

  it("listPayoutMethods includes inactive lifecycle rows only when requested", async () => {
    prismaMock.payoutMethod.findMany.mockResolvedValue([
      {
        id: "pm-paypal-legacy",
        type: "paypal",
        label: "Historical PayPal",
        displayDetails: { maskedEmail: "p***@example.test" },
        isDefault: false,
        isActive: true,
        providerAccountId: null,
        providerAccount: null,
      },
    ])

    const result = await service.listPayoutMethods("pub-1", "user-1", true)

    expect(prismaMock.payoutMethod.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publisherId: "pub-1" },
      }),
    )
    expect(result).toEqual([
      expect.objectContaining({
        id: "pm-paypal-legacy",
        isActive: true,
        withdrawalEligibility: expect.objectContaining({
          executable: false,
          canReactivate: false,
          code: "METHOD_NOT_CERTIFIED",
        }),
      }),
    ])
  })
})

describe("PayoutExecutionService — provider error redaction", () => {
  const originalStripeKey = process.env.STRIPE_SECRET_KEY
  const originalLiveGate = process.env.STRIPE_LIVE_MODE_ENABLED

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_provider_redaction"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
  })

  afterEach(() => {
    if (originalStripeKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeKey
    }
    if (originalLiveGate === undefined) {
      delete process.env.STRIPE_LIVE_MODE_ENABLED
    } else {
      process.env.STRIPE_LIVE_MODE_ENABLED = originalLiveGate
    }
  })

  it("replaces a provider response-loss error with a constant safe message", async () => {
    const account = {
      id: "account-row-1",
      providerAccountId: "acct_1",
    }
    const withdrawal = {
      id: "wd-1",
      status: "PROCESSING",
      amount: new Decimal(100),
      netAmount: new Decimal(100),
      currency: "USD",
      publisherId: "pub-1",
      publicReference: "GP-WD-1",
      publisher: { organizationId: "org-1" },
      payoutMethod: { id: "pm-1", providerAccount: account },
    }
    const execution = {
      id: "exec-1",
      withdrawalId: withdrawal.id,
      status: "PROCESSING",
      stage: "PROVIDER_SEND_CLAIMED",
      version: 1,
      livemode: false,
      idempotencyKey: "payout-wd-1-v1",
      providerMetadata: {},
      provider: { id: "provider-1", name: "stripe_connect" },
      withdrawal,
    }
    const auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    const prismaMock: any = {
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(execution),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
    }
    prismaMock.$transaction = jest
      .fn()
      .mockImplementation(async (work: any) => work(prismaMock))
    const leakyError = new Error(
      `Wise API 422: invalid payload {"accountNumber":"DE89370400440532013000"}`,
    )
    const providerMock = {
      getAdapter: jest.fn().mockReturnValue({
        validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
        recoverClaimedTransfer: jest.fn().mockRejectedValue(leakyError),
      }),
    }

    const service: any = new PayoutExecutionService(
      prismaMock,
      auditMock as any,
      { decrypt: jest.fn() } as any,
      providerMock as any,
    )
    service.claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution,
      withdrawal,
      recipientDetails: {
        connectedAccountId: "acct_1",
        providerAccountStatus: "ENABLED",
        payoutScheduleConfigured: true,
      },
      providerConfig: {},
      claimedVersion: 2,
    })

    let rejection: unknown
    try {
      await service.recoverClaimedProviderSend(execution, "staff-1")
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(ConflictException)
    expect(String((rejection as Error).message)).toMatch(
      /outcome remains unknown/i,
    )
    expect(String((rejection as Error).stack)).not.toContain(
      "DE89370400440532013000",
    )

    expect(
      JSON.stringify(prismaMock.payoutExecution.updateMany.mock.calls),
    ).not.toContain("DE89370400440532013000")
    expect(prismaMock.payoutExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorMessage:
            "Stripe Transfer outcome remains unknown; retry the original claim only after the recovery lease",
        }),
      }),
    )
    expect(JSON.stringify(auditMock.log.mock.calls)).not.toContain(
      "DE89370400440532013000",
    )
  })
})
