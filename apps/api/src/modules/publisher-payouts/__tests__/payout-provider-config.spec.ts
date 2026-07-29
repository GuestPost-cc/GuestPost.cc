import { decodePayoutProviderConfig } from "../payout-provider-config"

describe("decodePayoutProviderConfig", () => {
  it("decrypts authenticated string config", () => {
    const decrypt = jest.fn().mockReturnValue({ apiKey: "secret" })

    expect(decodePayoutProviderConfig("ciphertext", 3, decrypt)).toEqual({
      apiKey: "secret",
    })
    expect(decrypt).toHaveBeenCalledWith("ciphertext", 3)
  })

  it("accepts only the empty plaintext sentinel", () => {
    const decrypt = jest.fn()

    expect(decodePayoutProviderConfig({}, 0, decrypt)).toEqual({})
    expect(decrypt).not.toHaveBeenCalled()
  })

  it.each([
    ["non-empty object", { apiKey: "plaintext-secret" }],
    ["array", []],
    ["empty string", ""],
    ["null", null],
  ])("rejects %s plaintext config", (_label, rawConfig) => {
    expect(() => decodePayoutProviderConfig(rawConfig, 0, jest.fn())).toThrow(
      "Payout provider config must be encrypted ciphertext or an empty object",
    )
  })

  it("rejects decrypted values that are not plain objects", () => {
    expect(() =>
      decodePayoutProviderConfig("ciphertext", 1, () => [] as any),
    ).toThrow("Decrypted payout provider config must be an object")
  })
})
