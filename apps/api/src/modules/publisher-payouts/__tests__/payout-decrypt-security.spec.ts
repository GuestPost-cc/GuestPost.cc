import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import { PermissionsGuard } from "../../../common/guards/permissions.guard"
import { PayoutEncryptionService } from "../payout-encryption.service"
import { PayoutExecutionService } from "../payout-execution.service"
import { PublisherPayoutsService } from "../publisher-payouts.service"

const SECRET_DETAILS = {
  accountNumber: "DE89370400440532013000",
  routingNumber: "021000021",
  bankName: "Test Bank",
}

function makeContext(user: any, requiredPermissions?: string[]) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredPermissions),
  }
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }
  return { reflector, context }
}

describe("PermissionsGuard — FINANCIAL_DATA_DECRYPT", () => {
  let prismaMock: any

  beforeEach(() => {
    prismaMock = { staffMembership: { findUnique: jest.fn() } }
  })

  it("denies SUPER_ADMIN without an explicit FINANCIAL_DATA_DECRYPT grant", async () => {
    prismaMock.staffMembership.findUnique.mockResolvedValue({ permissions: [] })
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("allows SUPER_ADMIN with an explicit FINANCIAL_DATA_DECRYPT grant", async () => {
    prismaMock.staffMembership.findUnique.mockResolvedValue({
      permissions: ["FINANCIAL_DATA_DECRYPT"],
    })
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
  })

  it("still lets SUPER_ADMIN bypass non-sensitive permissions", async () => {
    const { reflector, context } = makeContext(
      { id: "u1", staffRole: "SUPER_ADMIN" },
      ["SOME_ORDINARY_PERMISSION"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
    expect(prismaMock.staffMembership.findUnique).not.toHaveBeenCalled()
  })

  it("allows FINANCE staff with an explicit grant", async () => {
    prismaMock.staffMembership.findUnique.mockResolvedValue({
      permissions: ["FINANCIAL_DATA_DECRYPT"],
    })
    const { reflector, context } = makeContext(
      { id: "u2", staffRole: "FINANCE" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).resolves.toBe(true)
  })

  it("denies FINANCE staff without the grant", async () => {
    prismaMock.staffMembership.findUnique.mockResolvedValue({
      permissions: ["SOMETHING_ELSE"],
    })
    const { reflector, context } = makeContext(
      { id: "u2", staffRole: "FINANCE" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("denies users with no staff membership", async () => {
    prismaMock.staffMembership.findUnique.mockResolvedValue(null)
    const { reflector, context } = makeContext(
      { id: "u3", staffRole: "OPERATIONS" },
      ["FINANCIAL_DATA_DECRYPT"],
    )
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it("denies unauthenticated requests", async () => {
    const { reflector, context } = makeContext(null, ["FINANCIAL_DATA_DECRYPT"])
    const guard = new PermissionsGuard(reflector as any, prismaMock)

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe("PayoutEncryptionService", () => {
  const ORIGINAL_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("fails startup in production when PAYOUT_ENCRYPTION_KEY is missing", () => {
    process.env.NODE_ENV = "production"
    delete process.env.PAYOUT_ENCRYPTION_KEY
    expect(() => new PayoutEncryptionService()).toThrow(/PAYOUT_ENCRYPTION_KEY/)
  })

  it("fails startup in production when the key is too short", () => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_ENCRYPTION_KEY = "abcd1234"
    expect(() => new PayoutEncryptionService()).toThrow(/PAYOUT_ENCRYPTION_KEY/)
  })

  it("falls back to a dev key outside production", () => {
    process.env.NODE_ENV = "test"
    delete process.env.PAYOUT_ENCRYPTION_KEY
    expect(() => new PayoutEncryptionService()).not.toThrow()
  })

  it("round-trips encrypt/decrypt with a real key", () => {
    process.env.NODE_ENV = "test"
    process.env.PAYOUT_ENCRYPTION_KEY = "a".repeat(64)
    const svc = new PayoutEncryptionService()
    const { ciphertext, version } = svc.encrypt(SECRET_DETAILS)
    expect(version).toBe(1)
    expect(ciphertext).not.toContain("DE89")
    expect(svc.decrypt(ciphertext, version)).toEqual(SECRET_DETAILS)
  })

  it("decrypts old-version records after key version bump (rotation safety)", () => {
    process.env.NODE_ENV = "test"
    process.env.PAYOUT_ENCRYPTION_KEY = "b".repeat(64)
    const svc = new PayoutEncryptionService()
    const v1 = svc.encrypt(SECRET_DETAILS, 1)
    const v2 = svc.encrypt(SECRET_DETAILS, 2)
    expect(svc.decrypt(v1.ciphertext, 1)).toEqual(SECRET_DETAILS)
    expect(svc.decrypt(v2.ciphertext, 2)).toEqual(SECRET_DETAILS)
    // Cross-version decrypt must fail (different derived keys)
    expect(() => svc.decrypt(v1.ciphertext, 2)).toThrow()
  })

  it("rejects tampered ciphertext (GCM auth)", () => {
    process.env.NODE_ENV = "test"
    process.env.PAYOUT_ENCRYPTION_KEY = "c".repeat(64)
    const svc = new PayoutEncryptionService()
    const { ciphertext, version } = svc.encrypt(SECRET_DETAILS)
    const raw = Buffer.from(ciphertext, "base64")
    raw[raw.length - 1] ^= 0xff
    expect(() => svc.decrypt(raw.toString("base64"), version)).toThrow()
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
    )
  })

  it("decryptPayoutMethod 404s on unknown method without decrypting", async () => {
    prismaMock.payoutMethod.findUnique.mockResolvedValue(null)

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
  })

  it("listPayoutMethods never selects or returns encrypted details", async () => {
    prismaMock.payoutMethod.findMany.mockResolvedValue([
      {
        id: "pm-1",
        type: "bank_transfer",
        label: "Main",
        displayDetails: { bankName: "Test Bank", last4: "3000" },
        isDefault: true,
      },
    ])

    const result = await service.listPayoutMethods("pub-1", "user-1")

    const select = prismaMock.payoutMethod.findMany.mock.calls[0][0].select
    expect(select.details).toBeUndefined()
    expect(encryptionMock.decrypt).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("DE89370400440532013000")
    expect(result[0].displayDetails).toEqual({
      bankName: "Test Bank",
      last4: "3000",
    })
  })
})

describe("PayoutExecutionService — provider error redaction", () => {
  it("redacts banking data from logs, errorMessage, and audit metadata on provider failure", async () => {
    process.env.NODE_ENV = "test"
    process.env.PAYOUT_ENCRYPTION_KEY = "d".repeat(64)
    const encryption = new PayoutEncryptionService()
    const { ciphertext, version } = encryption.encrypt(SECRET_DETAILS)

    const withdrawal = {
      id: "wd-1",
      status: "APPROVED",
      version: 0,
      amount: new Decimal(100),
      currency: "USD",
      method: "wise",
      publisherId: "pub-1",
      publisher: { organizationId: "org-1" },
      payoutMethod: {
        id: "pm-1",
        isActive: true,
        details: ciphertext,
        encryptionKeyVersion: version,
      },
    }
    const auditMock = { log: jest.fn().mockResolvedValue(undefined) }
    const prismaMock: any = {
      withdrawal: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(withdrawal)
          .mockResolvedValue({ ...withdrawal, version: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutExecution: {
        create: jest.fn().mockResolvedValue({ id: "exec-1" }),
        findUnique: jest.fn().mockResolvedValue({
          id: "exec-1",
          status: "PROCESSING",
          stage: "CREATED",
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(prismaMock)),
    }
    const leakyError = new Error(
      `Wise API 422: invalid payload {"accountNumber":"DE89370400440532013000"}`,
    )
    const providerMock = {
      getAdapter: jest.fn().mockReturnValue({
        capabilities: { supportedCurrencies: ["USD"] },
        validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
        createTransfer: jest.fn().mockRejectedValue(leakyError),
      }),
      getActiveProvider: jest
        .fn()
        .mockResolvedValue({ id: "prov-1", name: "wise", decryptedConfig: {} }),
    }

    const service = new PayoutExecutionService(
      prismaMock,
      auditMock as any,
      encryption,
      providerMock as any,
    )

    await expect(
      service.executeWithdrawal("wd-1", "wise", "staff-1"),
    ).rejects.toThrow(/\[REDACTED\]/)

    const updateCall = prismaMock.payoutExecution.update.mock.calls.find(
      (c: any[]) => c[0].data.status === "FAILED",
    )
    expect(updateCall[0].data.errorMessage).not.toContain(
      "DE89370400440532013000",
    )
    expect(updateCall[0].data.errorMessage).toContain("[REDACTED]")

    const failAudit = auditMock.log.mock.calls.find(
      (c: any[]) => c[0].action === "PAYOUT_EXECUTION_FAILED",
    )
    expect(JSON.stringify(failAudit[0].metadata)).not.toContain(
      "DE89370400440532013000",
    )
  })
})
