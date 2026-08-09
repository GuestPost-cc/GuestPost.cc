import { createHash } from "node:crypto"
import { ConflictException } from "@nestjs/common"
import { Decimal } from "@prisma/client/runtime/client"
import * as stripeClient from "../../../common/stripe-client"
import { PayoutExecutionService } from "../payout-execution.service"
import { StripeConnectPayoutAdapter } from "../providers/stripe-connect-payout.adapter"

const ORIGINAL_ENV = { ...process.env }

function idempotencyFingerprint(value: string): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`
}

function canonicalFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
  process.env = { ...ORIGINAL_ENV }
})

function stripeClaimedExecution(
  stage:
    | "PROVIDER_SEND_CLAIMED"
    | "BANK_PAYOUT_SEND_CLAIMED"
    | "BANK_PAYOUT_RESUME_CLAIMED",
) {
  const account = {
    id: "account-row-1",
    providerAccountId: "acct_immutable",
  }
  const payoutMethod = {
    id: "method-1",
    providerAccount: account,
  }
  const withdrawal = {
    id: "withdrawal-1",
    status: "PROCESSING",
    publicReference: "GP-WD-0001",
    publisherId: "publisher-1",
    approvedBy: "approver-1",
    publisher: { organizationId: "organization-1" },
    payoutMethod,
    amount: new Decimal(100),
    netAmount: new Decimal(97),
    currency: "USD",
  }
  return {
    id: "execution-1",
    withdrawalId: withdrawal.id,
    providerId: "provider-1",
    provider: { id: "provider-1", name: "stripe_connect" },
    withdrawal,
    status: "PROCESSING",
    stage,
    livemode: false,
    version: 7,
    idempotencyKey: "payout-withdrawal-1-v12",
    providerExecutionId:
      stage === "PROVIDER_SEND_CLAIMED" ? null : "tr_original",
    providerTransferId:
      stage === "PROVIDER_SEND_CLAIMED" ? null : "tr_original",
    providerPayoutId: null,
    providerMetadata: {
      destinationSnapshot: { providerAccountExternalId: "acct_immutable" },
    },
    fee: new Decimal(0),
  }
}

function makeRecoveryService(adapter: Record<string, jest.Mock>) {
  const payoutExecution = {
    findUnique: jest.fn().mockResolvedValue({
      id: "execution-1",
      status: "PROCESSING",
      stage: "PROVIDER_SEND_CLAIMED",
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  const tx: any = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
    payoutExecution,
    staffMembership: {
      findMany: jest.fn().mockResolvedValue([{ userId: "finance-1" }]),
    },
    notification: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  }
  const prisma: any = {
    payoutExecution,
    $transaction: jest.fn(async (work: any) => work(tx)),
  }
  const audit = { log: jest.fn().mockResolvedValue(undefined) }
  const providerService = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  }
  const service: any = new PayoutExecutionService(
    prisma,
    audit as any,
    { decrypt: jest.fn() } as any,
    providerService as any,
  )
  return { audit, service, prisma, providerService, tx }
}

function validStripeFinalClaim(
  stage:
    | "DESTINATION_VALIDATED"
    | "PROVIDER_SEND_CLAIMED"
    | "TRANSFER_CREATED"
    | "TRANSFER_RECOVERY_REQUIRED",
) {
  const account = {
    id: "account-row-1",
    publisherId: "publisher-1",
    provider: "stripe_connect",
    providerAccountId: "acct_immutable",
    status: "ENABLED",
    isActive: true,
    transfersEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    payoutScheduleConfigured: true,
    defaultCurrency: "USD",
  }
  const payoutMethod = {
    id: "method-1",
    publisherId: "publisher-1",
    type: "stripe_connect",
    isActive: true,
    version: 3,
    encryptionKeyVersion: 2,
    details: "ciphertext",
    providerAccountId: account.id,
    providerAccount: account,
  }
  const publicReference = "GP-WD-0001"
  const recipientDetails = {
    connectedAccountId: account.providerAccountId,
    providerAccountStatus: account.status,
    payoutScheduleConfigured: account.payoutScheduleConfigured,
    publicReference,
  }
  const provider = {
    id: "provider-1",
    name: "stripe_connect",
    isActive: true,
    version: 4,
    configEncryptionKeyVersion: 1,
    config: {},
  }
  const destinationSnapshot = {
    payoutMethodVersion: payoutMethod.version,
    encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
    encryptedDetailsFingerprint: canonicalFingerprint({
      details: payoutMethod.details,
      encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
    }),
    providerAccountRowId: account.id,
    providerAccountFingerprint: canonicalFingerprint(account),
    providerAccountExternalId: account.providerAccountId,
    recipientFingerprint: canonicalFingerprint(recipientDetails),
  }
  const providerSnapshot = {
    providerId: provider.id,
    providerName: provider.name,
    providerVersion: provider.version,
    configEncryptionKeyVersion: provider.configEncryptionKeyVersion,
    configFingerprint: canonicalFingerprint(provider.config),
  }
  const withdrawal = {
    id: "withdrawal-1",
    status: "PROCESSING",
    method: "stripe_connect",
    payoutMethodId: payoutMethod.id,
    publisherId: "publisher-1",
    requestedBy: "publisher-owner-1",
    approvedBy: "finance-approver-1",
    publicReference,
    publisher: { organizationId: "organization-1" },
    payoutMethod,
    allocations: [
      { amount: new Decimal(100), currency: "USD", releasedAt: null },
    ],
    amount: new Decimal(100),
    netAmount: new Decimal(97),
    currency: "USD",
  }
  const hasTransfer = [
    "TRANSFER_CREATED",
    "TRANSFER_RECOVERY_REQUIRED",
  ].includes(stage)
  return {
    id: "execution-1",
    withdrawalId: withdrawal.id,
    providerId: provider.id,
    provider,
    withdrawal,
    status: "PROCESSING",
    stage,
    livemode: false,
    version: 7,
    updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    idempotencyKey: "payout-withdrawal-1-v12",
    amount: new Decimal(100),
    destinationAmount: new Decimal(97),
    sourceCurrency: "USD",
    destinationCurrency: "USD",
    providerExecutionId: hasTransfer ? "tr_original" : null,
    providerTransferId: hasTransfer ? "tr_original" : null,
    providerPayoutId: null,
    providerMetadata: { destinationSnapshot, providerSnapshot },
    fee: new Decimal(0),
  }
}

function makeFinalClaimHarness(
  fresh: ReturnType<typeof validStripeFinalClaim>,
) {
  const createTransfer = jest.fn()
  const tx: any = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
    $queryRaw: jest.fn().mockResolvedValue([
      {
        publisherId: fresh.withdrawal.publisherId,
        currency: "USD",
        debtBalance: new Decimal(0),
      },
    ]),
    payoutExecution: {
      findUnique: jest.fn().mockResolvedValue(fresh),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payoutExecutionClaim: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "claim-1" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publisherMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: "publisher-member-1" }),
    },
    staffMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: "staff-member-1" }),
    },
  }
  const audit = { log: jest.fn().mockResolvedValue(undefined) }
  const providerService = {
    getAdapter: jest.fn().mockReturnValue({ createTransfer }),
  }
  const service: any = new PayoutExecutionService(
    {
      $transaction: jest.fn(async (work: any) => work(tx)),
    } as any,
    audit as any,
    { decrypt: jest.fn() } as any,
    providerService as any,
  )
  return { audit, createTransfer, providerService, service, tx }
}

function finalClaimParams(
  fresh: ReturnType<typeof validStripeFinalClaim>,
  claimPurpose: "NEW_SEND" | "EXACT_RECOVERY",
  requireAgedClaim: boolean,
) {
  return {
    executionId: fresh.id,
    withdrawalId: fresh.withdrawalId,
    publisherId: fresh.withdrawal.publisherId,
    payoutMethodId: fresh.withdrawal.payoutMethod.id,
    providerAccountRowId:
      fresh.withdrawal.payoutMethod.providerAccount?.id ?? null,
    providerId: fresh.provider.id,
    providerName: fresh.provider.name,
    expectedStages: [fresh.stage],
    claimedStage: fresh.stage,
    requireAgedClaim,
    claimPurpose,
    requireTransferWithoutPayout: false,
    userId: "finance-actor-1",
    auditAction: "PAYOUT_PROVIDER_SEND_CLAIMED",
  }
}

describe("PayoutExecutionService claimed-send recovery", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "rk_test_claim_recovery"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
  })

  it("atomically quarantines an initial mismatched Transfer response before any provider identity is attached", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_provider_response_mismatch"
    process.env.STRIPE_LIVE_MODE_ENABLED = "false"
    const account = {
      id: "account-row-1",
      publisherId: "publisher-1",
      provider: "stripe_connect",
      providerAccountId: "acct_immutable",
      status: "ENABLED",
      isActive: true,
      transfersEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      payoutScheduleConfigured: true,
      defaultCurrency: "USD",
    }
    const payoutMethod = {
      id: "method-1",
      publisherId: "publisher-1",
      type: "stripe_connect",
      isActive: true,
      version: 1,
      encryptionKeyVersion: 1,
      details: "ciphertext",
      providerAccount: account,
    }
    const withdrawal = {
      id: "withdrawal-1",
      method: "stripe_connect",
      payoutMethodId: payoutMethod.id,
      publisherId: "publisher-1",
      amount: new Decimal(100),
      netAmount: new Decimal(97),
      currency: "USD",
      publicReference: "GP-WD-0001",
      publisher: { organizationId: "organization-1" },
    }
    const destinationSnapshot = {
      encryptedDetailsFingerprint: canonicalFingerprint({
        details: payoutMethod.details,
        encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
      }),
      providerAccountFingerprint: canonicalFingerprint(account),
    }
    const execution = {
      id: "execution-1",
      withdrawalId: withdrawal.id,
      stage: "CREATED",
      status: "PROCESSING",
      livemode: false,
      version: 0,
      idempotencyKey: "payout-withdrawal-1-v1",
      providerMetadata: {
        destinationSnapshot,
        providerSnapshot: {},
      },
    }
    const claim = {
      execution,
      withdrawal,
      payoutMethod,
      account,
      destinationSnapshot,
      providerSnapshot: {},
      providerRecord: { id: "provider-1" },
    }
    const quarantineTx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue({
          id: execution.id,
          withdrawalId: withdrawal.id,
          status: "PROCESSING",
          stage: "PROVIDER_SEND_CLAIMED",
          version: 2,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "finance-1" }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma: any = {
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue({
          id: withdrawal.id,
          method: "stripe_connect",
          currency: "USD",
          publicReference: withdrawal.publicReference,
          publisher: withdrawal.publisher,
        }),
      },
      payoutMethod: {
        findUnique: jest.fn().mockResolvedValue(payoutMethod),
      },
      payoutExecution: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const createStripeTransfer = jest.fn().mockResolvedValue({
      id: "tr_untrusted_initial",
      livemode: false,
      amount: 9_700,
      currency: "usd",
      destination: "acct_immutable",
      metadata: {
        withdrawal_reference: "GP-WD-WRONG",
        unsafeMarker: "MUST_NOT_PERSIST",
      },
    })
    jest.spyOn(stripeClient, "getStripeClient").mockReturnValue({
      transfers: { create: createStripeTransfer },
    } as any)
    const adapter = new StripeConnectPayoutAdapter()
    const createBankPayout = jest.spyOn(adapter, "createBankPayout")
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service: any = new PayoutExecutionService(
      prisma,
      audit as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn().mockReturnValue(adapter) } as any,
    )
    service.recordOperatorIntent = jest.fn().mockResolvedValue(undefined)
    service.runSerializable = jest
      .fn()
      .mockResolvedValueOnce(claim)
      .mockImplementation(async (work: any) => work(quarantineTx))
    service.claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution: {
        ...execution,
        stage: "PROVIDER_SEND_CLAIMED",
        version: 2,
      },
      withdrawal,
      recipientDetails: {
        connectedAccountId: "acct_immutable",
        providerAccountStatus: "ENABLED",
        payoutScheduleConfigured: true,
        publicReference: "GP-WD-0001",
      },
      providerConfig: {},
      claimedVersion: 2,
    })

    await expect(
      service.executeWithdrawal(
        withdrawal.id,
        "stripe_connect",
        "initiator-1",
        "Reviewed Stripe payout recovery test",
      ),
    ).rejects.toThrow(ConflictException)

    expect(createStripeTransfer).toHaveBeenCalledTimes(1)
    expect(createBankPayout).not.toHaveBeenCalled()
    const quarantineWrite =
      quarantineTx.payoutExecution.updateMany.mock.calls.find(
        ([write]: any[]) =>
          write.data.errorMessage ===
          "Provider response failed immutable command validation; payout reconciliation is required",
      )?.[0]
    expect(quarantineWrite).toBeDefined()
    expect(quarantineWrite.data).toEqual({
      errorMessage:
        "Provider response failed immutable command validation; payout reconciliation is required",
      version: { increment: 1 },
    })
    expect(JSON.stringify(quarantineWrite)).not.toContain(
      "tr_untrusted_initial",
    )
    expect(JSON.stringify(quarantineWrite)).not.toContain("MUST_NOT_PERSIST")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_PROVIDER_RESPONSE_QUARANTINED",
      }),
      quarantineTx,
    )
    expect(quarantineTx.notification.createMany).toHaveBeenCalledTimes(1)
  })

  it("keeps trusted Transfer evidence but never attaches an initial mismatched bank Payout response", async () => {
    const account = {
      id: "account-row-1",
      publisherId: "publisher-1",
      provider: "stripe_connect",
      providerAccountId: "acct_immutable",
      status: "ENABLED",
      isActive: true,
      transfersEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      payoutScheduleConfigured: true,
      defaultCurrency: "USD",
    }
    const payoutMethod = {
      id: "method-1",
      publisherId: "publisher-1",
      type: "stripe_connect",
      isActive: true,
      version: 1,
      encryptionKeyVersion: 1,
      details: "ciphertext",
      providerAccount: account,
    }
    const withdrawal = {
      id: "withdrawal-1",
      method: "stripe_connect",
      payoutMethodId: payoutMethod.id,
      publisherId: "publisher-1",
      amount: new Decimal(100),
      netAmount: new Decimal(97),
      currency: "USD",
      publicReference: "GP-WD-0001",
      publisher: { organizationId: "organization-1" },
    }
    const destinationSnapshot = {
      encryptedDetailsFingerprint: canonicalFingerprint({
        details: payoutMethod.details,
        encryptionKeyVersion: payoutMethod.encryptionKeyVersion,
      }),
      providerAccountFingerprint: canonicalFingerprint(account),
    }
    const execution: any = {
      id: "execution-1",
      withdrawalId: withdrawal.id,
      stage: "CREATED",
      status: "PROCESSING",
      livemode: false,
      version: 0,
      idempotencyKey: "payout-withdrawal-1-v1",
      fee: new Decimal(0),
      providerMetadata: {
        destinationSnapshot,
        providerSnapshot: {},
      },
    }
    const claim = {
      execution,
      withdrawal,
      payoutMethod,
      account,
      destinationSnapshot,
      providerSnapshot: {},
      providerRecord: { id: "provider-1" },
    }
    const quarantineTx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue({
          id: execution.id,
          withdrawalId: withdrawal.id,
          status: "PROCESSING",
          stage: "BANK_PAYOUT_SEND_CLAIMED",
          version: 4,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "finance-1" }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma: any = {
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue({
          id: withdrawal.id,
          method: "stripe_connect",
          currency: "USD",
          publicReference: withdrawal.publicReference,
          publisher: withdrawal.publisher,
        }),
      },
      payoutMethod: {
        findUnique: jest.fn().mockResolvedValue(payoutMethod),
      },
      payoutExecution: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const adapter = {
      validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
      createTransfer: jest.fn().mockResolvedValue({
        providerExecutionId: "tr_trusted",
        providerTransferId: "tr_trusted",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        status: "PROCESSING",
        metadata: {
          connectedAccountId: "acct_immutable",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-0001",
          livemode: false,
        },
      }),
      createBankPayout: jest.fn().mockResolvedValue({
        providerExecutionId: "po_untrusted_initial",
        providerPayoutId: "po_untrusted_initial",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        status: "PROCESSING",
        acceptedReference: "UNTRUSTED-REFERENCE",
        metadata: {
          connectedAccountId: "acct_other",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-0001",
          livemode: false,
          unsafeMarker: "MUST_NOT_PERSIST",
        },
      }),
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service: any = new PayoutExecutionService(
      prisma,
      audit as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn().mockReturnValue(adapter) } as any,
    )
    service.recordOperatorIntent = jest.fn().mockResolvedValue(undefined)
    service.runSerializable = jest
      .fn()
      .mockResolvedValueOnce(claim)
      .mockImplementation(async (work: any) => work(quarantineTx))
    service.claimExternalCall = jest
      .fn()
      .mockResolvedValueOnce({
        kind: "claimed",
        execution: {
          ...execution,
          stage: "PROVIDER_SEND_CLAIMED",
          version: 2,
        },
        withdrawal,
        recipientDetails: { connectedAccountId: "acct_immutable" },
        providerConfig: {},
        claimedVersion: 2,
      })
      .mockResolvedValueOnce({
        kind: "claimed",
        execution: {
          ...execution,
          providerExecutionId: "tr_trusted",
          providerTransferId: "tr_trusted",
          stage: "BANK_PAYOUT_SEND_CLAIMED",
          version: 4,
        },
        withdrawal,
        recipientDetails: { connectedAccountId: "acct_immutable" },
        providerConfig: {},
        claimedVersion: 4,
      })

    await expect(
      service.executeWithdrawal(
        withdrawal.id,
        "stripe_connect",
        "initiator-1",
        "Reviewed Stripe payout recovery test",
      ),
    ).rejects.toThrow(ConflictException)

    expect(adapter.createTransfer).toHaveBeenCalledTimes(1)
    expect(adapter.createBankPayout).toHaveBeenCalledTimes(1)
    const transferEvidence =
      quarantineTx.payoutExecution.updateMany.mock.calls.find(
        ([write]: any[]) => write.data.providerExecutionId === "tr_trusted",
      )?.[0]
    expect(transferEvidence).toBeDefined()
    expect(transferEvidence.data).toEqual(
      expect.objectContaining({
        providerExecutionId: "tr_trusted",
        providerTransferId: "tr_trusted",
      }),
    )
    const quarantineWrite =
      quarantineTx.payoutExecution.updateMany.mock.calls.find(
        ([write]: any[]) =>
          write.data.errorMessage ===
          "Provider response failed immutable command validation; payout reconciliation is required",
      )?.[0]
    expect(quarantineWrite).toBeDefined()
    expect(quarantineWrite.where.stage).toEqual({
      in: ["BANK_PAYOUT_SEND_CLAIMED"],
    })
    expect(quarantineWrite.data).toEqual({
      errorMessage:
        "Provider response failed immutable command validation; payout reconciliation is required",
      version: { increment: 1 },
    })
    expect(JSON.stringify(quarantineWrite)).not.toContain(
      "po_untrusted_initial",
    )
    expect(JSON.stringify(quarantineWrite)).not.toContain("MUST_NOT_PERSIST")
  })

  it("replays an ambiguous Stripe Transfer with the exact original key", async () => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_EXECUTION_ENABLED = "false"
    const execution = stripeClaimedExecution("PROVIDER_SEND_CLAIMED")
    const recoverClaimedTransfer = jest
      .fn()
      .mockRejectedValueOnce(new Error("connection reset after request"))
      .mockResolvedValueOnce({
        providerExecutionId: "tr_original",
        providerTransferId: "tr_original",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        status: "PROCESSING",
        metadata: {
          stage: "TRANSFER_CREATED",
          connectedAccountId: "acct_immutable",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-0001",
          livemode: false,
        },
      })
    const adapter = {
      validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
      createTransfer: jest.fn(),
      recoverClaimedTransfer,
    }
    const { service } = makeRecoveryService(adapter)
    const claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution,
      withdrawal: execution.withdrawal,
      recipientDetails: {
        connectedAccountId: "acct_immutable",
        providerAccountStatus: "ENABLED",
        payoutScheduleConfigured: true,
      },
      providerConfig: {},
      claimedVersion: 8,
    })
    service.claimExternalCall = claimExternalCall
    service.resumeStripeBankPayout = jest.fn().mockResolvedValue({
      executionId: execution.id,
      status: "PROCESSING",
    })

    await expect(
      service.recoverClaimedProviderSend(execution, "finance-1"),
    ).rejects.toThrow(/outcome remains unknown/i)
    await expect(
      service.recoverClaimedProviderSend(execution, "finance-1"),
    ).resolves.toMatchObject({ status: "PROCESSING" })

    expect(recoverClaimedTransfer).toHaveBeenCalledTimes(2)
    expect(
      recoverClaimedTransfer.mock.calls.map(([input]) => input.idempotencyKey),
    ).toEqual(["payout-withdrawal-1-v12", "payout-withdrawal-1-v12"])
    expect(adapter.createTransfer).not.toHaveBeenCalled()
    expect(claimExternalCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        claimedStage: "PROVIDER_SEND_CLAIMED",
      }),
    )
  })

  it.each([
    "BANK_PAYOUT_SEND_CLAIMED",
    "BANK_PAYOUT_RESUME_CLAIMED",
  ] as const)("replays an ambiguous %s call with the exact original bank key", async (stage) => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_EXECUTION_ENABLED = "false"
    const execution = stripeClaimedExecution(stage)
    const recoverClaimedBankPayout = jest
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({
        providerExecutionId: "po_original",
        providerPayoutId: "po_original",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        acceptedReference: "GPWD0001",
        status: "PROCESSING",
        metadata: {
          stage: "BANK_PAYOUT_CREATED",
          connectedAccountId: "acct_immutable",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-0001",
          livemode: false,
        },
      })
    const createBankPayout = jest.fn()
    const { service } = makeRecoveryService({
      createBankPayout,
      recoverClaimedBankPayout,
    })
    const claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution,
      withdrawal: execution.withdrawal,
      recipientDetails: { connectedAccountId: "acct_immutable" },
      providerConfig: {},
      claimedVersion: 8,
    })
    service.claimExternalCall = claimExternalCall

    await expect(
      service.recoverClaimedStripeBankPayout(execution, "finance-1"),
    ).rejects.toThrow(/outcome remains unknown/i)
    await expect(
      service.recoverClaimedStripeBankPayout(execution, "finance-1"),
    ).resolves.toMatchObject({
      status: "PROCESSING",
      providerExecutionId: "po_original",
    })

    expect(recoverClaimedBankPayout).toHaveBeenCalledTimes(2)
    expect(
      recoverClaimedBankPayout.mock.calls.map(
        ([input]) => input.idempotencyKey,
      ),
    ).toEqual(["payout-bank-withdrawal-1-v12", "payout-bank-withdrawal-1-v12"])
    expect(createBankPayout).not.toHaveBeenCalled()
    expect(claimExternalCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        claimedStage: stage,
        requireTransferWithoutPayout: true,
      }),
    )
  })

  it("atomically quarantines a mismatched replayed Transfer without attaching its response", async () => {
    const execution = stripeClaimedExecution("PROVIDER_SEND_CLAIMED")
    const untrustedResponse = {
      providerExecutionId: "tr_untrusted",
      providerTransferId: "tr_untrusted",
      providerAmountMinor: 9_700,
      providerCurrency: "USD",
      livemode: false,
      status: "PROCESSING",
      metadata: {
        connectedAccountId: "acct_other",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        providerPublicReference: "GP-WD-WRONG",
        livemode: false,
        unsafeMarker: "MUST_NOT_PERSIST",
      },
    }
    const adapter = {
      validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
      recoverClaimedTransfer: jest.fn().mockResolvedValue(untrustedResponse),
    }
    const { audit, service, tx } = makeRecoveryService(adapter)
    service.claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution,
      withdrawal: execution.withdrawal,
      recipientDetails: { connectedAccountId: "acct_immutable" },
      providerConfig: {},
      claimedVersion: 8,
    })

    await expect(
      service.recoverClaimedProviderSend(execution, "finance-1"),
    ).rejects.toThrow(ConflictException)

    const quarantineWrite = tx.payoutExecution.updateMany.mock.calls.at(-1)[0]
    expect(quarantineWrite).toEqual({
      where: {
        id: execution.id,
        withdrawalId: execution.withdrawalId,
        status: "PROCESSING",
        stage: { in: ["PROVIDER_SEND_CLAIMED"] },
        version: 8,
      },
      data: {
        errorMessage:
          "Stripe Transfer response failed immutable command validation; Finance reconciliation is required",
        version: { increment: 1 },
      },
    })
    expect(JSON.stringify(quarantineWrite)).not.toContain("tr_untrusted")
    expect(JSON.stringify(quarantineWrite)).not.toContain("MUST_NOT_PERSIST")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_PROVIDER_RESPONSE_QUARANTINED",
        metadata: expect.objectContaining({
          disposition: "UNTRUSTED_NOT_ATTACHED",
          responseKind: "STRIPE_TRANSFER",
        }),
      }),
      tx,
    )
    expect(tx.notification.createMany).toHaveBeenCalledTimes(1)
  })

  it("atomically quarantines a mismatched replayed bank Payout without attaching its response", async () => {
    const execution = stripeClaimedExecution("BANK_PAYOUT_SEND_CLAIMED")
    const adapter = {
      recoverClaimedBankPayout: jest.fn().mockResolvedValue({
        providerExecutionId: "po_untrusted",
        providerPayoutId: "po_untrusted",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        status: "PROCESSING",
        acceptedReference: "UNTRUSTED-REFERENCE",
        metadata: {
          connectedAccountId: "acct_immutable",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-WRONG",
          livemode: false,
          unsafeMarker: "MUST_NOT_PERSIST",
        },
      }),
    }
    const { audit, service, tx } = makeRecoveryService(adapter)
    service.claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution,
      withdrawal: execution.withdrawal,
      recipientDetails: { connectedAccountId: "acct_immutable" },
      providerConfig: {},
      claimedVersion: 8,
    })

    await expect(
      service.recoverClaimedStripeBankPayout(execution, "finance-1"),
    ).rejects.toThrow(ConflictException)

    const quarantineWrite = tx.payoutExecution.updateMany.mock.calls.at(-1)[0]
    expect(quarantineWrite.where.stage).toEqual({
      in: ["BANK_PAYOUT_SEND_CLAIMED"],
    })
    expect(quarantineWrite.data).toEqual({
      errorMessage:
        "Stripe Payout response failed immutable command validation; Finance reconciliation is required",
      version: { increment: 1 },
    })
    expect(JSON.stringify(quarantineWrite)).not.toContain("po_untrusted")
    expect(JSON.stringify(quarantineWrite)).not.toContain("MUST_NOT_PERSIST")
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_PROVIDER_RESPONSE_QUARANTINED",
        metadata: expect.objectContaining({
          responseKind: "STRIPE_PAYOUT",
        }),
      }),
      tx,
    )
  })

  it("quarantines a mismatched transfer-to-bank continuation without poisoning canonical payout identity", async () => {
    const execution = {
      ...stripeClaimedExecution("BANK_PAYOUT_RESUME_CLAIMED"),
      stage: "TRANSFER_RECOVERY_REQUIRED",
    }
    const adapter = {
      recoverClaimedBankPayout: jest.fn().mockResolvedValue({
        providerExecutionId: "po_untrusted_resume",
        providerPayoutId: "po_untrusted_resume",
        providerAmountMinor: 9_700,
        providerCurrency: "USD",
        livemode: false,
        status: "PROCESSING",
        metadata: {
          connectedAccountId: "acct_other",
          providerAmountMinor: 9_700,
          providerCurrency: "USD",
          providerPublicReference: "GP-WD-0001",
          livemode: false,
          unsafeMarker: "MUST_NOT_PERSIST",
        },
      }),
    }
    const { service, tx } = makeRecoveryService(adapter)
    service.claimExternalCall = jest.fn().mockResolvedValue({
      kind: "claimed",
      execution: {
        ...execution,
        stage: "BANK_PAYOUT_RESUME_CLAIMED",
      },
      withdrawal: execution.withdrawal,
      recipientDetails: { connectedAccountId: "acct_immutable" },
      claimedVersion: 8,
    })

    await expect(
      service.resumeStripeBankPayout(execution, "finance-1"),
    ).rejects.toThrow(ConflictException)

    const quarantineWrite = tx.payoutExecution.updateMany.mock.calls.at(-1)[0]
    expect(quarantineWrite.where.stage).toEqual({
      in: ["BANK_PAYOUT_RESUME_CLAIMED"],
    })
    expect(JSON.stringify(quarantineWrite)).not.toContain("po_untrusted_resume")
    expect(JSON.stringify(quarantineWrite)).not.toContain("MUST_NOT_PERSIST")
  })

  it("quarantines claims older than the bounded replay window and alerts only Finance", async () => {
    const now = new Date("2026-07-29T12:00:00.000Z")
    jest.useFakeTimers()
    jest.setSystemTime(now)
    const claimedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const fresh = {
      ...stripeClaimedExecution("BANK_PAYOUT_SEND_CLAIMED"),
      updatedAt: new Date(now.getTime() - 20 * 60 * 1000),
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisherId: "publisher-1",
          currency: "USD",
          debtBalance: new Decimal(0),
        },
      ]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: "claim-1",
          executionId: fresh.id,
          kind: "BANK_PAYOUT_SEND",
          idempotencyKey: "payout-bank-withdrawal-1-v12",
          idempotencyKeyFingerprint: idempotencyFingerprint(
            "payout-bank-withdrawal-1-v12",
          ),
          claimedAt,
          lastClaimedAt: new Date(now.getTime() - 20 * 60 * 1000),
        }),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "finance-1" }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const prisma: any = {
      $transaction: jest.fn(async (work: any) => work(tx)),
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service: any = new PayoutExecutionService(
      prisma,
      audit as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn() } as any,
    )

    await expect(
      service.claimExternalCall({
        executionId: fresh.id,
        withdrawalId: fresh.withdrawalId,
        publisherId: fresh.withdrawal.publisherId,
        payoutMethodId: fresh.withdrawal.payoutMethod.id,
        providerAccountRowId: fresh.withdrawal.payoutMethod.providerAccount.id,
        providerId: fresh.provider.id,
        providerName: "stripe_connect",
        expectedStages: ["BANK_PAYOUT_SEND_CLAIMED"],
        claimedStage: "BANK_PAYOUT_SEND_CLAIMED",
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        requireTransferWithoutPayout: true,
        userId: "finance-1",
        auditAction: "PAYOUT_BANK_SEND_REPLAY_CLAIMED",
      }),
    ).resolves.toMatchObject({ kind: "expired", executionId: fresh.id })

    expect(tx.payoutExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: "BANK_PAYOUT_CLAIM_EXPIRED",
        }),
      }),
    )
    expect(tx.staffMembership.findMany).toHaveBeenCalledWith({
      where: { role: { in: ["FINANCE", "SUPER_ADMIN"] } },
      select: { userId: true },
    })
    expect(tx.notification.createMany).toHaveBeenCalledTimes(1)
  })

  it("does not replay a fresh claim that may still belong to a live process", async () => {
    const now = new Date("2026-07-29T12:00:00.000Z")
    jest.useFakeTimers()
    jest.setSystemTime(now)
    const fresh = {
      ...stripeClaimedExecution("PROVIDER_SEND_CLAIMED"),
      updatedAt: new Date(now.getTime() - 5 * 60 * 1000),
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisherId: "publisher-1",
          currency: "USD",
          debtBalance: new Decimal(0),
        },
      ]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        updateMany: jest.fn(),
      },
      payoutExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: "claim-1",
          executionId: fresh.id,
          kind: "PROVIDER_SEND",
          idempotencyKey: fresh.idempotencyKey,
          idempotencyKeyFingerprint: idempotencyFingerprint(
            fresh.idempotencyKey,
          ),
          claimedAt: new Date(now.getTime() - 5 * 60 * 1000),
          lastClaimedAt: new Date(now.getTime() - 5 * 60 * 1000),
        }),
      },
    }
    const service: any = new PayoutExecutionService(
      {
        $transaction: jest.fn(async (work: any) => work(tx)),
      } as any,
      { log: jest.fn() } as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn() } as any,
    )

    await expect(
      service.claimExternalCall({
        executionId: fresh.id,
        withdrawalId: fresh.withdrawalId,
        publisherId: fresh.withdrawal.publisherId,
        payoutMethodId: fresh.withdrawal.payoutMethod.id,
        providerAccountRowId: fresh.withdrawal.payoutMethod.providerAccount.id,
        providerId: fresh.provider.id,
        providerName: "stripe_connect",
        expectedStages: ["PROVIDER_SEND_CLAIMED"],
        claimedStage: "PROVIDER_SEND_CLAIMED",
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        userId: "finance-1",
        auditAction: "PAYOUT_PROVIDER_SEND_REPLAY_CLAIMED",
      }),
    ).rejects.toThrow(ConflictException)
    expect(tx.payoutExecution.updateMany).not.toHaveBeenCalled()
  })

  it("rejects recovery before claim mutation or provider I/O after test-to-live credential drift", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_claim_recovery"
    process.env.STRIPE_LIVE_MODE_ENABLED = "true"
    const fresh = {
      ...stripeClaimedExecution("PROVIDER_SEND_CLAIMED"),
      updatedAt: new Date(Date.now() - 20 * 60 * 1000),
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisherId: "publisher-1",
          currency: "USD",
          debtBalance: new Decimal(0),
        },
      ]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        updateMany: jest.fn(),
      },
      payoutExecutionClaim: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    }
    const createTransfer = jest.fn()
    const service: any = new PayoutExecutionService(
      {
        $transaction: jest.fn(async (work: any) => work(tx)),
      } as any,
      { log: jest.fn() } as any,
      { decrypt: jest.fn() } as any,
      {
        getAdapter: jest.fn().mockReturnValue({ createTransfer }),
      } as any,
    )

    await expect(
      service.claimExternalCall({
        executionId: fresh.id,
        withdrawalId: fresh.withdrawalId,
        publisherId: fresh.withdrawal.publisherId,
        payoutMethodId: fresh.withdrawal.payoutMethod.id,
        providerAccountRowId: fresh.withdrawal.payoutMethod.providerAccount.id,
        providerId: fresh.provider.id,
        providerName: "stripe_connect",
        expectedStages: ["PROVIDER_SEND_CLAIMED"],
        claimedStage: "PROVIDER_SEND_CLAIMED",
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        userId: "finance-1",
        auditAction: "PAYOUT_PROVIDER_SEND_REPLAY_CLAIMED",
      }),
    ).rejects.toThrow(/credential mode changed/i)
    expect(tx.payoutExecutionClaim.findUnique).not.toHaveBeenCalled()
    expect(tx.payoutExecutionClaim.updateMany).not.toHaveBeenCalled()
    expect(tx.payoutExecution.updateMany).not.toHaveBeenCalled()
    expect(createTransfer).not.toHaveBeenCalled()
  })

  it("quarantines a replay whose first claim fingerprint is missing or changed", async () => {
    const now = new Date("2026-07-29T12:00:00.000Z")
    jest.useFakeTimers()
    jest.setSystemTime(now)
    const fresh = {
      ...stripeClaimedExecution("PROVIDER_SEND_CLAIMED"),
      updatedAt: new Date(now.getTime() - 20 * 60 * 1000),
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisherId: "publisher-1",
          currency: "USD",
          debtBalance: new Decimal(0),
        },
      ]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payoutExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: "claim-1",
          executionId: fresh.id,
          kind: "PROVIDER_SEND",
          idempotencyKey: fresh.idempotencyKey,
          idempotencyKeyFingerprint: "fingerprint-from-different-command",
          claimedAt: new Date(now.getTime() - 20 * 60 * 1000),
          lastClaimedAt: new Date(now.getTime() - 20 * 60 * 1000),
        }),
      },
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([{ userId: "finance-1" }]),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    }
    const audit = { log: jest.fn().mockResolvedValue(undefined) }
    const service: any = new PayoutExecutionService(
      {
        $transaction: jest.fn(async (work: any) => work(tx)),
      } as any,
      audit as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn() } as any,
    )

    await expect(
      service.claimExternalCall({
        executionId: fresh.id,
        withdrawalId: fresh.withdrawalId,
        publisherId: fresh.withdrawal.publisherId,
        payoutMethodId: fresh.withdrawal.payoutMethod.id,
        providerAccountRowId: fresh.withdrawal.payoutMethod.providerAccount.id,
        providerId: fresh.provider.id,
        providerName: "stripe_connect",
        expectedStages: ["PROVIDER_SEND_CLAIMED"],
        claimedStage: "PROVIDER_SEND_CLAIMED",
        requireAgedClaim: true,
        claimPurpose: "EXACT_RECOVERY",
        userId: "finance-1",
        auditAction: "PAYOUT_PROVIDER_SEND_REPLAY_CLAIMED",
      }),
    ).resolves.toMatchObject({ kind: "expired", executionId: fresh.id })

    expect(tx.payoutExecution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: "PROVIDER_SEND_CLAIM_EXPIRED",
          errorMessage: expect.stringMatching(/idempotency identity/i),
        }),
      }),
    )
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYOUT_CLAIM_IDENTITY_QUARANTINED",
        metadata: expect.objectContaining({
          reason: "IDEMPOTENCY_IDENTITY_MISMATCH",
          recordedIdempotencyKeyFingerprint:
            "fingerprint-from-different-command",
        }),
      }),
      tx,
    )
  })

  it.each([
    {
      name: "Finance enters recovery-only mode",
      expectedEligibilityCode: "FINANCE_OPERATIONS_PAUSED",
      configureReady: () => {
        process.env.FINANCE_RUNTIME_MODE = "normal"
        process.env.STRIPE_CONNECT_ENABLED = "true"
      },
      flipRuntime: () => {
        process.env.FINANCE_RUNTIME_MODE = "recovery_only"
      },
      useManualMethod: false,
    },
    {
      name: "Stripe Connect rollout is disabled",
      expectedEligibilityCode: "STRIPE_CONNECT_DISABLED",
      configureReady: () => {
        process.env.FINANCE_RUNTIME_MODE = "normal"
        process.env.STRIPE_CONNECT_ENABLED = "true"
      },
      flipRuntime: () => {
        process.env.STRIPE_CONNECT_ENABLED = "false"
      },
      useManualMethod: false,
    },
    {
      name: "manual-bank rollout is disabled",
      expectedEligibilityCode: "MANUAL_BANK_DISABLED",
      configureReady: () => {
        process.env.FINANCE_RUNTIME_MODE = "normal"
        process.env.STRIPE_CONNECT_ENABLED = "false"
        process.env.PAYOUT_LEGACY_METHODS_ENABLED = "true"
      },
      flipRuntime: () => {
        process.env.PAYOUT_LEGACY_METHODS_ENABLED = "false"
      },
      useManualMethod: true,
    },
  ])("blocks a new final send claim before durable mutation when $name", async ({
    configureReady,
    expectedEligibilityCode,
    flipRuntime,
    useManualMethod,
  }) => {
    process.env.NODE_ENV = "production"
    process.env.PAYOUT_EXECUTION_ENABLED = "true"
    configureReady()
    const fresh: any = validStripeFinalClaim("DESTINATION_VALIDATED")
    if (useManualMethod) {
      fresh.livemode = null
      fresh.provider = { ...fresh.provider, name: "manual" }
      fresh.withdrawal.method = "bank_transfer"
      fresh.withdrawal.payoutMethod = {
        ...fresh.withdrawal.payoutMethod,
        type: "bank_transfer",
        providerAccountId: null,
        providerAccount: null,
      }
    }
    const { audit, createTransfer, providerService, service, tx } =
      makeFinalClaimHarness(fresh)

    // The execution was created while the route was ready. Simulate the
    // operations switch changing before the locked external-send claim.
    flipRuntime()

    await expect(
      service.claimExternalCall(finalClaimParams(fresh, "NEW_SEND", false)),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: "PAYOUT_METHOD_NOT_EXECUTABLE",
        eligibilityCode: expectedEligibilityCode,
      }),
    })

    expect(tx.payoutExecutionClaim.findUnique).not.toHaveBeenCalled()
    expect(tx.payoutExecutionClaim.create).not.toHaveBeenCalled()
    expect(tx.payoutExecutionClaim.updateMany).not.toHaveBeenCalled()
    expect(tx.payoutExecution.updateMany).not.toHaveBeenCalled()
    expect(audit.log).not.toHaveBeenCalled()
    expect(providerService.getAdapter).not.toHaveBeenCalled()
    expect(createTransfer).not.toHaveBeenCalled()
  })

  it("rechecks a Stripe rollout flip after destination validation and before provider I/O", async () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "normal"
    process.env.PAYOUT_EXECUTION_ENABLED = "true"
    process.env.STRIPE_CONNECT_ENABLED = "true"
    const fresh = validStripeFinalClaim("DESTINATION_VALIDATED")
    const { service, tx } = makeFinalClaimHarness(fresh)
    const createTransfer = jest.fn()
    const adapter = {
      capabilities: { supportedCurrencies: ["USD"] },
      validateRecipient: jest.fn().mockResolvedValue({ valid: true }),
      createTransfer,
    }
    const providerService = {
      getAdapter: jest.fn().mockReturnValue(adapter),
    }
    ;(service as any).providerService = providerService
    ;(service as any).prisma.withdrawal = {
      findUnique: jest.fn().mockResolvedValue({
        id: fresh.withdrawal.id,
        method: fresh.withdrawal.method,
        currency: fresh.withdrawal.currency,
        publicReference: fresh.withdrawal.publicReference,
        publisher: fresh.withdrawal.publisher,
      }),
    }
    ;(service as any).prisma.payoutMethod = {
      findUnique: jest.fn().mockResolvedValue(fresh.withdrawal.payoutMethod),
    }
    const initialClaim = {
      execution: { ...fresh, stage: "CREATED", version: 0 },
      withdrawal: fresh.withdrawal,
      payoutMethod: fresh.withdrawal.payoutMethod,
      account: fresh.withdrawal.payoutMethod.providerAccount,
      destinationSnapshot: fresh.providerMetadata.destinationSnapshot,
      providerSnapshot: fresh.providerMetadata.providerSnapshot,
      providerRecord: fresh.provider,
    }
    service.recordOperatorIntent = jest.fn().mockResolvedValue(undefined)
    service.runSerializable = jest
      .fn()
      .mockResolvedValueOnce(initialClaim)
      .mockImplementation(async (work: any) => work(tx))
    service.updateExecutionWithParentLock = jest
      .fn()
      .mockImplementation(async () => {
        process.env.STRIPE_CONNECT_ENABLED = "false"
        return { count: 1 }
      })
    service.abortPreProviderExecution = jest.fn().mockResolvedValue(undefined)

    await expect(
      service.executeWithdrawal(
        fresh.withdrawal.id,
        "stripe_connect",
        "finance-actor-1",
        "Reviewed final Stripe rollout gate before provider send",
      ),
    ).rejects.toThrow("Payout validation failed before provider send")

    expect(adapter.validateRecipient).toHaveBeenCalledTimes(1)
    expect(createTransfer).not.toHaveBeenCalled()
    expect(tx.payoutExecutionClaim.findUnique).not.toHaveBeenCalled()
    expect(tx.payoutExecutionClaim.create).not.toHaveBeenCalled()
    expect(tx.payoutExecution.updateMany).not.toHaveBeenCalled()
    expect(service.abortPreProviderExecution).toHaveBeenCalledTimes(1)
  })

  it("preserves exact aged-claim recovery while new sends and Stripe rollout are disabled", async () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.PAYOUT_EXECUTION_ENABLED = "false"
    process.env.STRIPE_CONNECT_ENABLED = "false"
    const fresh = validStripeFinalClaim("PROVIDER_SEND_CLAIMED")
    const { audit, service, tx } = makeFinalClaimHarness(fresh)
    const claimedAt = new Date(Date.now() - 20 * 60 * 1000)
    tx.payoutExecutionClaim.findUnique.mockResolvedValue({
      id: "claim-1",
      executionId: fresh.id,
      kind: "PROVIDER_SEND",
      idempotencyKey: fresh.idempotencyKey,
      idempotencyKeyFingerprint: idempotencyFingerprint(fresh.idempotencyKey),
      claimedAt,
      lastClaimedAt: claimedAt,
    })

    await expect(
      service.claimExternalCall(
        finalClaimParams(fresh, "EXACT_RECOVERY", true),
      ),
    ).resolves.toMatchObject({
      kind: "claimed",
      execution: { stage: "PROVIDER_SEND_CLAIMED" },
      claimedVersion: fresh.version + 1,
    })

    expect(tx.payoutExecutionClaim.updateMany).toHaveBeenCalledTimes(1)
    expect(tx.payoutExecutionClaim.create).not.toHaveBeenCalled()
    expect(tx.payoutExecution.updateMany).toHaveBeenCalledTimes(1)
    expect(audit.log).toHaveBeenCalledTimes(1)
  })

  it("preserves the persisted Transfer-to-bank recovery continuation while new sends are disabled", async () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.PAYOUT_EXECUTION_ENABLED = "false"
    process.env.STRIPE_CONNECT_ENABLED = "false"
    const fresh = validStripeFinalClaim("TRANSFER_RECOVERY_REQUIRED")
    const { audit, service, tx } = makeFinalClaimHarness(fresh)

    await expect(
      service.claimExternalCall({
        ...finalClaimParams(fresh, "EXACT_RECOVERY", false),
        claimedStage: "BANK_PAYOUT_RESUME_CLAIMED",
        requireTransferWithoutPayout: true,
        auditAction: "PAYOUT_BANK_STAGE_RESUME_CLAIMED",
      }),
    ).resolves.toMatchObject({
      kind: "claimed",
      execution: { stage: "BANK_PAYOUT_RESUME_CLAIMED" },
      claimedVersion: fresh.version + 1,
    })

    expect(tx.payoutExecutionClaim.create).toHaveBeenCalledTimes(1)
    expect(tx.payoutExecutionClaim.updateMany).not.toHaveBeenCalled()
    expect(tx.payoutExecution.updateMany).toHaveBeenCalledTimes(1)
    expect(audit.log).toHaveBeenCalledTimes(1)
  })

  it("fails the final locked claim when routing changed after validation", async () => {
    process.env.NODE_ENV = "production"
    process.env.FINANCE_RUNTIME_MODE = "normal"
    process.env.PAYOUT_EXECUTION_ENABLED = "true"
    process.env.STRIPE_CONNECT_ENABLED = "true"
    const execution = stripeClaimedExecution("PROVIDER_SEND_CLAIMED")
    const account = {
      id: "account-row-1",
      publisherId: "publisher-1",
      provider: "stripe_connect",
      providerAccountId: "acct_immutable",
      status: "ENABLED",
      isActive: true,
      transfersEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      payoutScheduleConfigured: true,
      defaultCurrency: "USD",
    }
    const fresh = {
      ...execution,
      stage: "DESTINATION_VALIDATED",
      updatedAt: new Date(),
      amount: new Decimal(100),
      destinationAmount: new Decimal(97),
      sourceCurrency: "USD",
      destinationCurrency: "USD",
      provider: {
        ...execution.provider,
        isActive: true,
        version: 1,
        configEncryptionKeyVersion: 1,
        config: {},
      },
      providerMetadata: {
        destinationSnapshot: {
          // The validated snapshot was version 1; the locked current route is
          // version 2. No provider call may be claimed from stale validation.
          payoutMethodVersion: 1,
          encryptionKeyVersion: 1,
          providerAccountRowId: account.id,
        },
        providerSnapshot: {
          providerId: "provider-1",
          providerName: "stripe_connect",
          providerVersion: 1,
          configEncryptionKeyVersion: 1,
          configFingerprint: "not-reached",
        },
      },
      withdrawal: {
        ...execution.withdrawal,
        requestedBy: "publisher-owner-1",
        method: "stripe_connect",
        payoutMethodId: "method-1",
        allocations: [
          {
            amount: new Decimal(100),
            currency: "USD",
            releasedAt: null,
          },
        ],
        payoutMethod: {
          id: "method-1",
          publisherId: "publisher-1",
          type: "stripe_connect",
          isActive: true,
          version: 2,
          encryptionKeyVersion: 1,
          details: "ciphertext",
          providerAccountId: account.id,
          providerAccount: account,
        },
      },
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          publisherId: "publisher-1",
          currency: "USD",
          debtBalance: new Decimal(0),
        },
      ]),
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        updateMany: jest.fn(),
      },
      payoutExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      publisherMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "membership-1" }),
      },
      staffMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: "staff-membership-1" }),
      },
    }
    const service: any = new PayoutExecutionService(
      {
        $transaction: jest.fn(async (work: any) => work(tx)),
      } as any,
      { log: jest.fn() } as any,
      { decrypt: jest.fn() } as any,
      { getAdapter: jest.fn() } as any,
    )

    await expect(
      service.claimExternalCall({
        executionId: fresh.id,
        withdrawalId: fresh.withdrawalId,
        publisherId: fresh.withdrawal.publisherId,
        payoutMethodId: fresh.withdrawal.payoutMethod.id,
        providerAccountRowId: account.id,
        providerId: fresh.provider.id,
        providerName: "stripe_connect",
        expectedStages: ["DESTINATION_VALIDATED"],
        claimedStage: "PROVIDER_SEND_CLAIMED",
        requireAgedClaim: false,
        claimPurpose: "NEW_SEND",
        userId: "finance-1",
        auditAction: "PAYOUT_PROVIDER_SEND_CLAIMED",
      }),
    ).rejects.toThrow(/destination no longer matches current routing/i)
    expect(tx.payoutExecution.updateMany).not.toHaveBeenCalled()
  })
})
