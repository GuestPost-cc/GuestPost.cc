import {
  mergePayoutProviderMetadata,
  sanitizePayoutProviderMetadata,
} from "../payout-provider-metadata"

describe("payout provider metadata boundary", () => {
  it("keeps only bounded allow-listed scalar evidence", () => {
    expect(
      sanitizePayoutProviderMetadata({
        stage: "BANK_PAID",
        connectedAccountId: `acct_${"x".repeat(300)}`,
        arrivalDate: 1_800_000_000,
        rawStatus: "paid",
        secret: "sk_live_never_persist",
        responseBody: { account_number: "1234" },
        fee: Number.NaN,
      }),
    ).toEqual({
      stage: "BANK_PAID",
      connectedAccountId: `acct_${"x".repeat(186)}`,
      arrivalDate: 1_800_000_000,
      rawStatus: "paid",
    })
  })

  it("cannot overwrite immutable application namespaces", () => {
    const existing = {
      destinationSnapshot: { recipientFingerprint: "immutable" },
      providerSnapshot: { providerVersion: 7 },
      completion: { source: "PROVIDER_RESPONSE" },
    }
    expect(
      mergePayoutProviderMetadata(existing, {
        destinationSnapshot: { recipientFingerprint: "attacker" },
        providerSnapshot: null,
        completion: null,
        stage: "BANK_PAID",
      }),
    ).toEqual({
      ...existing,
      providerEvidence: { stage: "BANK_PAID" },
    })
  })
})
