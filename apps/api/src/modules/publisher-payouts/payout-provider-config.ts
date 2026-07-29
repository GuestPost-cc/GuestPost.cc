type ProviderConfigDecryptor = (
  ciphertext: string,
  version: number,
) => Record<string, unknown>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Provider secrets must be authenticated ciphertext. An empty JSON object is
 * the only plaintext sentinel because built-in providers such as Stripe read
 * their credentials from the process environment rather than this row.
 */
export function decodePayoutProviderConfig(
  rawConfig: unknown,
  version: number,
  decrypt: ProviderConfigDecryptor,
): Record<string, unknown> {
  if (typeof rawConfig === "string" && rawConfig.length > 0) {
    const decrypted = decrypt(rawConfig, version)
    if (!isPlainRecord(decrypted)) {
      throw new Error("Decrypted payout provider config must be an object")
    }
    return decrypted
  }

  if (isPlainRecord(rawConfig) && Object.keys(rawConfig).length === 0) {
    return {}
  }

  throw new Error(
    "Payout provider config must be encrypted ciphertext or an empty object",
  )
}
