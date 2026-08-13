import { scryptSync } from "node:crypto"
import {
  MAX_PAYOUT_ENCRYPTION_KEY_ID_LENGTH,
  MAX_PAYOUT_ENCRYPTION_KEYS,
} from "./payout-encryption.constants"

const KEY_BYTES = 32
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/
const KEY_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]{1,${MAX_PAYOUT_ENCRYPTION_KEY_ID_LENGTH}}$`,
)

/**
 * Injection boundary for a managed key provider. Implementations may load and
 * unwrap keys using a KMS before Nest constructs this service; cryptographic
 * operations intentionally receive only bounded, opaque key IDs and 32-byte
 * data-encryption keys.
 */
export interface PayoutEncryptionKeyProvider {
  readonly activeKeyId: string
  readonly keyIds: readonly string[]
  /** Return a caller-owned copy; implementations must not expose mutable state. */
  getKey(keyId: string): Buffer
  /** Return a caller-owned legacy v0/v1 key copy when legacy reads are enabled. */
  getLegacyKey(): Buffer | undefined
}

export const PAYOUT_ENCRYPTION_KEY_PROVIDER = Symbol(
  "PAYOUT_ENCRYPTION_KEY_PROVIDER",
)

export type StaticPayoutEncryptionKeyProviderOptions = {
  activeKeyId: string
  keys: Readonly<Record<string, Buffer | string>>
  legacyKey?: Buffer | string
}

/**
 * Network-free provider used by the environment adapter and unit tests. It
 * defensively copies key material on ingress and egress.
 */
export class StaticPayoutEncryptionKeyProvider
  implements PayoutEncryptionKeyProvider
{
  readonly activeKeyId: string
  readonly keyIds: readonly string[]
  private readonly keys = new Map<string, Buffer>()
  private readonly legacyKey?: Buffer

  constructor(options: StaticPayoutEncryptionKeyProviderOptions) {
    const entries = Object.entries(options.keys)
    if (entries.length < 1 || entries.length > MAX_PAYOUT_ENCRYPTION_KEYS) {
      throw new Error(
        `Payout encryption keyring must contain between 1 and ${MAX_PAYOUT_ENCRYPTION_KEYS} keys`,
      )
    }
    if (!KEY_ID_PATTERN.test(options.activeKeyId)) {
      throw new Error("Payout encryption active key ID is invalid")
    }

    const fingerprints = new Set<string>()
    for (const [keyId, material] of entries) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error(`Payout encryption key ID is invalid: ${keyId}`)
      }
      const key = decodeKey(material, `Payout encryption key ${keyId}`)
      const fingerprint = key.toString("hex")
      if (fingerprints.has(fingerprint)) {
        key.fill(0)
        throw new Error("Payout encryption keyring contains duplicate keys")
      }
      fingerprints.add(fingerprint)
      this.keys.set(keyId, key)
    }
    if (!this.keys.has(options.activeKeyId)) {
      throw new Error("Payout encryption active key ID is not in the keyring")
    }

    if (options.legacyKey !== undefined) {
      const legacy = decodeKey(
        options.legacyKey,
        "Legacy payout encryption key",
      )
      if (fingerprints.has(legacy.toString("hex"))) {
        legacy.fill(0)
        throw new Error(
          "Legacy payout encryption key must not be reused as a v2 key",
        )
      }
      this.legacyKey = legacy
    }

    this.activeKeyId = options.activeKeyId
    this.keyIds = Object.freeze([...this.keys.keys()].sort())
  }

  getKey(keyId: string): Buffer {
    const key = this.keys.get(keyId)
    if (!key) throw new Error(`Unknown payout encryption key ID: ${keyId}`)
    return Buffer.from(key)
  }

  getLegacyKey(): Buffer | undefined {
    return this.legacyKey ? Buffer.from(this.legacyKey) : undefined
  }
}

export function loadPayoutEncryptionKeyProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PayoutEncryptionKeyProvider {
  const serializedKeys = env.PAYOUT_ENCRYPTION_KEYS
  const activeKeyId = env.PAYOUT_ENCRYPTION_ACTIVE_KEY_ID
  const legacyKey = env.PAYOUT_ENCRYPTION_KEY

  if (
    !serializedKeys &&
    !activeKeyId &&
    !legacyKey &&
    env.NODE_ENV === "test" &&
    typeof env.JEST_WORKER_ID === "string"
  ) {
    return isolatedTestProvider()
  }
  if (!serializedKeys) {
    throw new Error(
      "PAYOUT_ENCRYPTION_KEYS must be a JSON object containing bounded v2 keys",
    )
  }
  if (!activeKeyId) {
    throw new Error("PAYOUT_ENCRYPTION_ACTIVE_KEY_ID must be configured")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(serializedKeys)
  } catch {
    throw new Error("PAYOUT_ENCRYPTION_KEYS must be valid JSON")
  }
  if (!isStringRecord(parsed)) {
    throw new Error(
      "PAYOUT_ENCRYPTION_KEYS must be a JSON object of key IDs to 64-character hexadecimal keys",
    )
  }

  return new StaticPayoutEncryptionKeyProvider({
    activeKeyId,
    keys: parsed,
    legacyKey,
  })
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  )
}

function decodeKey(material: Buffer | string, label: string): Buffer {
  if (typeof material === "string") {
    if (!HEX_KEY_PATTERN.test(material)) {
      throw new Error(`${label} must be exactly 64 hexadecimal characters`)
    }
    return Buffer.from(material, "hex")
  }
  if (!Buffer.isBuffer(material) || material.length !== KEY_BYTES) {
    throw new Error(`${label} must be exactly ${KEY_BYTES} bytes`)
  }
  return Buffer.from(material)
}

function isolatedTestProvider(): PayoutEncryptionKeyProvider {
  // This deterministic material exists only inside a Jest worker with
  // NODE_ENV=test and no payout encryption setting. Every app/CLI runtime
  // outside that isolated harness fails closed.
  const active = scryptSync("guestpost-payout-v2-unit-test", "v2", KEY_BYTES)
  const decryptOnly = scryptSync(
    "guestpost-payout-v2-unit-test-old",
    "v2",
    KEY_BYTES,
  )
  const legacy = scryptSync(
    "guestpost-payout-legacy-unit-test",
    "legacy",
    KEY_BYTES,
  )
  return new StaticPayoutEncryptionKeyProvider({
    activeKeyId: "test-active",
    keys: { "test-active": active, "test-decrypt-only": decryptOnly },
    legacyKey: legacy,
  })
}
