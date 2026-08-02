import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const LEGACY_KEY_VERSION = 1
const MAX_KEYRING_ENTRIES = 16
const MAX_PLAINTEXT_BYTES = 256 * 1024
const MAX_CIPHERTEXT_CHARS = 512 * 1024
const MAX_AUTHENTICATED_CONTEXT_BYTES = 16 * 1024
const MAX_CONTEXT_COMPONENT_BYTES = 4 * 1024
const AUTHENTICATED_ENVELOPE_VERSION = 2
const EXACT_HEX_KEY = /^[0-9a-fA-F]{64}$/
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface EncryptedPayload {
  ciphertext: string
  version: number
}

export interface IntegrationTokenIdentity {
  provider: string
  externalUserId: string
  ownerType: string
  ownerId: string
}

export type IntegrationTokenPurpose = "access" | "refresh"

export interface EncryptOptions {
  version?: number
  authenticatedContext?: string
}

interface EncryptionKeyring {
  activeVersion: number
  masterKeys: Map<number, Buffer>
}

function hasConfiguredEnvironmentValue(name: string): boolean {
  return Object.hasOwn(process.env, name)
}

function assertContextComponent(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CONTEXT_COMPONENT_BYTES
  ) {
    throw new Error(`${label} must be a non-empty bounded string`)
  }
  return value
}

/**
 * Builds deterministic AES-GCM additional authenticated data for one token
 * field. The JSON tuple is unambiguous and binds ciphertext to both the
 * immutable ExternalAccount identity and the token's purpose.
 */
export function integrationTokenEncryptionContext(
  identity: IntegrationTokenIdentity,
  purpose: IntegrationTokenPurpose,
): string {
  if (purpose !== "access" && purpose !== "refresh") {
    throw new Error("Integration token purpose must be access or refresh")
  }
  return JSON.stringify([
    "guestpost.external-account-token",
    1,
    assertContextComponent(identity.provider, "Integration provider"),
    assertContextComponent(
      identity.externalUserId,
      "Integration external user id",
    ),
    assertContextComponent(identity.ownerType, "Integration owner type"),
    assertContextComponent(identity.ownerId, "Integration owner id"),
    purpose,
  ])
}

function parseVersion(value: unknown, label: string): number {
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > 2_147_483_647
  ) {
    throw new Error(`${label} must be a positive 32-bit integer`)
  }
  return version
}

function decodeMasterKey(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !EXACT_HEX_KEY.test(value)) {
    throw new Error(`${label} must be exactly 64 hexadecimal characters`)
  }
  const decoded = Buffer.from(value, "hex")
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(`${label} must decode to exactly 32 bytes`)
  }
  return decoded
}

function parseKeyringJson(serialized: string): Map<number, Buffer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new Error("INTEGRATION_ENCRYPTION_KEYS must be a JSON object")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INTEGRATION_ENCRYPTION_KEYS must be a JSON object")
  }

  const entries = Object.entries(parsed)
  if (entries.length < 1 || entries.length > MAX_KEYRING_ENTRIES) {
    throw new Error(
      `INTEGRATION_ENCRYPTION_KEYS must contain 1-${MAX_KEYRING_ENTRIES} keys`,
    )
  }

  const masterKeys = new Map<number, Buffer>()
  const seenMaterial = new Set<string>()
  for (const [rawVersion, rawKey] of entries) {
    const version = parseVersion(rawVersion, "Integration key version")
    if (masterKeys.has(version)) {
      throw new Error(`Duplicate integration key version ${version}`)
    }
    const key = decodeMasterKey(
      rawKey,
      `INTEGRATION_ENCRYPTION_KEYS[${version}]`,
    )
    const fingerprint = key.toString("hex")
    if (seenMaterial.has(fingerprint)) {
      throw new Error(
        "Integration encryption key versions must use distinct keys",
      )
    }
    seenMaterial.add(fingerprint)
    masterKeys.set(version, key)
  }
  return masterKeys
}

function loadKeyring(): EncryptionKeyring {
  const legacyKey = process.env.INTEGRATION_ENCRYPTION_KEY
  const serializedKeyring = process.env.INTEGRATION_ENCRYPTION_KEYS
  const activeVersionValue = process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION
  const hasLegacyKey = hasConfiguredEnvironmentValue(
    "INTEGRATION_ENCRYPTION_KEY",
  )
  const hasKeyring = hasConfiguredEnvironmentValue(
    "INTEGRATION_ENCRYPTION_KEYS",
  )
  const hasActiveVersion = hasConfiguredEnvironmentValue(
    "INTEGRATION_ENCRYPTION_ACTIVE_VERSION",
  )

  if (hasLegacyKey && hasKeyring) {
    throw new Error(
      "Configure INTEGRATION_ENCRYPTION_KEY or INTEGRATION_ENCRYPTION_KEYS, not both",
    )
  }

  if (hasKeyring) {
    if (!hasActiveVersion) {
      throw new Error(
        "INTEGRATION_ENCRYPTION_ACTIVE_VERSION is required with INTEGRATION_ENCRYPTION_KEYS",
      )
    }
    const masterKeys = parseKeyringJson(serializedKeyring as string)
    const activeVersion = parseVersion(
      activeVersionValue,
      "INTEGRATION_ENCRYPTION_ACTIVE_VERSION",
    )
    if (!masterKeys.has(activeVersion)) {
      throw new Error(
        "INTEGRATION_ENCRYPTION_ACTIVE_VERSION is not present in INTEGRATION_ENCRYPTION_KEYS",
      )
    }
    const highestConfiguredVersion = Math.max(...masterKeys.keys())
    if (activeVersion !== highestConfiguredVersion) {
      throw new Error(
        "INTEGRATION_ENCRYPTION_ACTIVE_VERSION must be the highest configured key version",
      )
    }
    if (activeVersion < AUTHENTICATED_ENVELOPE_VERSION) {
      throw new Error(
        `INTEGRATION_ENCRYPTION_KEYS requires an active version of at least ${AUTHENTICATED_ENVELOPE_VERSION}`,
      )
    }
    return { activeVersion, masterKeys }
  }

  if (hasActiveVersion) {
    const activeVersion = parseVersion(
      activeVersionValue,
      "INTEGRATION_ENCRYPTION_ACTIVE_VERSION",
    )
    if (!hasLegacyKey || activeVersion !== LEGACY_KEY_VERSION) {
      throw new Error(
        "INTEGRATION_ENCRYPTION_ACTIVE_VERSION requires INTEGRATION_ENCRYPTION_KEYS",
      )
    }
  }

  if (hasLegacyKey) {
    return {
      activeVersion: LEGACY_KEY_VERSION,
      masterKeys: new Map([
        [
          LEGACY_KEY_VERSION,
          decodeMasterKey(legacyKey, "INTEGRATION_ENCRYPTION_KEY"),
        ],
      ]),
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "INTEGRATION_ENCRYPTION_KEY or INTEGRATION_ENCRYPTION_KEYS is required in production",
    )
  }

  // Preserve compatibility with ciphertext created by the previous development
  // fallback. Persistent or production environments must always configure a
  // real key; this deterministic material is only for disposable local/test DBs.
  const developmentMasterKey = scryptSync(
    "dev-only-integration-key",
    "integration-dev-salt",
    KEY_LENGTH,
  )
  return {
    activeVersion: LEGACY_KEY_VERSION,
    masterKeys: new Map([[LEGACY_KEY_VERSION, developmentMasterKey]]),
  }
}

export class IntegrationEncryptionService {
  private readonly activeVersion: number
  private readonly masterKeys: Map<number, Buffer>

  constructor() {
    const keyring = loadKeyring()
    this.activeVersion = keyring.activeVersion
    this.masterKeys = keyring.masterKeys
  }

  private deriveKey(version: number): Buffer {
    const normalizedVersion = parseVersion(version, "Encryption key version")
    const masterKey = this.masterKeys.get(normalizedVersion)
    if (!masterKey) {
      throw new Error(
        `Unsupported integration encryption key version ${version}`,
      )
    }
    // Version 1 deliberately retains the previous derivation algorithm so
    // deployed ciphertext remains readable when the legacy key becomes keyring
    // entry 1. Independent master material per version enables hard rotation.
    return scryptSync(
      masterKey,
      `integration-key-v${normalizedVersion}`,
      KEY_LENGTH,
    )
  }

  encrypt(
    plaintext: Record<string, unknown>,
    options: EncryptOptions = {},
  ): EncryptedPayload {
    const version = options.version ?? this.activeVersion
    const plaintextStr = JSON.stringify(plaintext)
    if (
      typeof plaintextStr !== "string" ||
      Buffer.byteLength(plaintextStr, "utf8") > MAX_PLAINTEXT_BYTES
    ) {
      throw new Error("Invalid integration encryption plaintext")
    }

    const key = this.deriveKey(version)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    if (version >= AUTHENTICATED_ENVELOPE_VERSION) {
      const context = this.requireAuthenticatedContext(
        options.authenticatedContext,
      )
      cipher.setAAD(Buffer.from(context, "utf8"))
    } else if (options.authenticatedContext !== undefined) {
      throw new Error(
        "Authenticated integration encryption requires key version 2 or newer",
      )
    }
    const encrypted = Buffer.concat([
      cipher.update(plaintextStr, "utf8"),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    const combined = Buffer.concat([iv, tag, encrypted])
    const encoded = combined.toString("base64")
    return {
      ciphertext:
        version >= AUTHENTICATED_ENVELOPE_VERSION
          ? `v${version}:${encoded}`
          : encoded,
      version,
    }
  }

  decrypt(
    ciphertext: string,
    version: number,
    authenticatedContext?: string,
  ): Record<string, unknown> {
    const normalizedVersion = parseVersion(version, "Encryption key version")
    const key = this.deriveKey(normalizedVersion)
    const envelopePrefix = `v${normalizedVersion}:`
    if (typeof ciphertext !== "string") {
      throw new Error("Invalid integration encrypted payload")
    }
    const encoded =
      normalizedVersion >= AUTHENTICATED_ENVELOPE_VERSION &&
      ciphertext.startsWith(envelopePrefix)
        ? ciphertext.slice(envelopePrefix.length)
        : normalizedVersion >= AUTHENTICATED_ENVELOPE_VERSION
          ? ""
          : ciphertext
    if (
      encoded.length === 0 ||
      ciphertext.length > MAX_CIPHERTEXT_CHARS + envelopePrefix.length ||
      encoded.length % 4 !== 0 ||
      !CANONICAL_BASE64.test(encoded)
    ) {
      throw new Error("Invalid integration encrypted payload")
    }

    const data = Buffer.from(encoded, "base64")
    if (
      data.length < IV_LENGTH + TAG_LENGTH + 1 ||
      data.toString("base64") !== encoded
    ) {
      throw new Error("Invalid integration encrypted payload")
    }

    const iv = data.subarray(0, IV_LENGTH)
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    if (normalizedVersion >= AUTHENTICATED_ENVELOPE_VERSION) {
      const context = this.requireAuthenticatedContext(authenticatedContext)
      decipher.setAAD(Buffer.from(context, "utf8"))
    }
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])

    const parsed: unknown = JSON.parse(decrypted.toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid integration encrypted payload")
    }
    return parsed as Record<string, unknown>
  }

  private requireAuthenticatedContext(context: unknown): string {
    if (
      typeof context !== "string" ||
      context.length === 0 ||
      Buffer.byteLength(context, "utf8") > MAX_AUTHENTICATED_CONTEXT_BYTES
    ) {
      throw new Error(
        "Authenticated integration encryption context is required and must be bounded",
      )
    }
    return context
  }

  get currentVersion(): number {
    return this.activeVersion
  }

  get supportedVersions(): number[] {
    return [...this.masterKeys.keys()].sort((a, b) => a - b)
  }
}
