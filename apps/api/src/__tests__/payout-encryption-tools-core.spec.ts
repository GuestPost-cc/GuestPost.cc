import {
  assertEmptyProviderConfigVersion,
  assertPayoutEncryptionMutationPosture,
  isEmptyProviderConfig,
  parseBoundedCursor,
  parseBoundedPositiveInteger,
  payoutEnvelopeNeedsRotation,
} from "../modules/publisher-payouts/payout-encryption-tools-core"

describe("payout encryption rotation tooling core", () => {
  it("bounds batch sizes and resumable cursors", () => {
    expect(
      parseBoundedPositiveInteger(undefined, "--batch-size", 25, 100),
    ).toBe(25)
    expect(parseBoundedPositiveInteger("100", "--batch-size", 25, 100)).toBe(
      100,
    )
    expect(() =>
      parseBoundedPositiveInteger("0", "--batch-size", 25, 100),
    ).toThrow("--batch-size must be an integer from 1 to 100")
    expect(() =>
      parseBoundedPositiveInteger("1.5", "--batch-size", 25, 100),
    ).toThrow("--batch-size must be an integer from 1 to 100")
    expect(parseBoundedCursor("pm_123", "--method-after-id")).toBe("pm_123")
    expect(() => parseBoundedCursor(" pm_123", "--method-after-id")).toThrow(
      "--method-after-id must be a non-empty identifier",
    )
  })

  it("recognizes only the exact empty provider-config sentinel at version 0", () => {
    expect(isEmptyProviderConfig({})).toBe(true)
    expect(isEmptyProviderConfig({ apiKey: "plaintext" })).toBe(false)
    expect(isEmptyProviderConfig([])).toBe(false)
    expect(() => assertEmptyProviderConfigVersion(0)).not.toThrow()
    expect(() => assertEmptyProviderConfigVersion(2)).toThrow(
      "empty provider config must use encryption version 0",
    )
  })

  it("requires both the current format and active key before key removal", () => {
    const active = {
      storedVersion: 2,
      currentVersion: 2,
      envelopeKeyId: "payout-active",
      activeKeyId: "payout-active",
    }
    expect(payoutEnvelopeNeedsRotation(active)).toBe(false)
    expect(payoutEnvelopeNeedsRotation({ ...active, storedVersion: 1 })).toBe(
      true,
    )
    expect(
      payoutEnvelopeNeedsRotation({
        ...active,
        envelopeKeyId: "payout-decrypt-only",
      }),
    ).toBe(true)
    expect(
      payoutEnvelopeNeedsRotation({ ...active, envelopeKeyId: null }),
    ).toBe(true)
  })

  it("fails mutation closed unless finance is locked and payout sends are explicitly disabled", () => {
    expect(() =>
      assertPayoutEncryptionMutationPosture({
        FINANCE_RUNTIME_MODE: "locked",
        PAYOUT_EXECUTION_ENABLED: "false",
      }),
    ).not.toThrow()

    for (const env of [
      {},
      {
        FINANCE_RUNTIME_MODE: "normal",
        PAYOUT_EXECUTION_ENABLED: "false",
      },
      {
        FINANCE_RUNTIME_MODE: "locked",
        PAYOUT_EXECUTION_ENABLED: "true",
      },
      { FINANCE_RUNTIME_MODE: "locked" },
    ]) {
      expect(() => assertPayoutEncryptionMutationPosture(env)).toThrow(
        "FINANCE_RUNTIME_MODE=locked and PAYOUT_EXECUTION_ENABLED=false",
      )
    }
  })
})
