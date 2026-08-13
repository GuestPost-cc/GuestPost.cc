import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto"
import { Inject, Injectable, Optional } from "@nestjs/common"
import {
  CURRENT_PAYOUT_KEY_VERSION,
  MAX_PAYOUT_ENCRYPTION_KEY_ID_LENGTH,
  MAX_PAYOUT_ENCRYPTION_KEYS,
  MAX_PAYOUT_ENCRYPTION_PLAINTEXT_BYTES,
  PAYOUT_ENCRYPTION_ENVELOPE_PREFIX,
} from "./payout-encryption.constants"
import {
  loadPayoutEncryptionKeyProviderFromEnv,
  PAYOUT_ENCRYPTION_KEY_PROVIDER,
  type PayoutEncryptionKeyProvider,
} from "./payout-encryption-key-provider"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const ENVELOPE_PARTS = 3
const KEY_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]{1,${MAX_PAYOUT_ENCRYPTION_KEY_ID_LENGTH}}$`,
)
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type PayoutEncryptionContext =
  | {
      kind: "payout-method-details"
      id: string
      publisherId: string
      type: string
    }
  | {
      kind: "payout-provider-config"
      id: string
      name: string
    }

type PayoutMethodIdentity = {
  id: string
  publisherId: string
  type: string
}

type PayoutProviderIdentity = {
  id: string
  name: string
}

const SENSITIVE_FIELDS = [
  "accountNumber",
  "routingNumber",
  "iban",
  "swift",
  "accountHolderName",
  "bankName",
  "branchCode",
  "email",
  "recipientId",
  "connectedAccountId",
  "accessToken",
  "refreshToken",
]

export function payoutMethodEncryptionContext(
  identity: PayoutMethodIdentity,
): PayoutEncryptionContext {
  return {
    kind: "payout-method-details",
    id: requireContextValue(identity.id, "payout method ID"),
    publisherId: requireContextValue(identity.publisherId, "publisher ID"),
    type: requireContextValue(identity.type, "payout method type"),
  }
}

export function payoutProviderEncryptionContext(
  identity: PayoutProviderIdentity,
): PayoutEncryptionContext {
  return {
    kind: "payout-provider-config",
    id: requireContextValue(identity.id, "payout provider ID"),
    name: requireContextValue(identity.name, "payout provider name"),
  }
}

@Injectable()
export class PayoutEncryptionService {
  private readonly keyProvider: PayoutEncryptionKeyProvider

  constructor(
    @Optional()
    @Inject(PAYOUT_ENCRYPTION_KEY_PROVIDER)
    keyProvider?: PayoutEncryptionKeyProvider,
  ) {
    this.keyProvider =
      keyProvider ?? loadPayoutEncryptionKeyProviderFromEnv(process.env)
    this.validateProvider()
  }

  get currentVersion(): number {
    return CURRENT_PAYOUT_KEY_VERSION
  }

  get activeKeyId(): string {
    return this.keyProvider.activeKeyId
  }

  get decryptKeyIds(): readonly string[] {
    return this.keyProvider.keyIds
  }

  encrypt(
    plaintext: Record<string, unknown>,
    context: PayoutEncryptionContext,
  ): { ciphertext: string; version: number; keyId: string } {
    assertPlainObject(plaintext)
    const json = JSON.stringify(plaintext)
    if (typeof json !== "string") {
      throw new Error("Payout encryption payload is not serializable")
    }
    assertPlainObject(JSON.parse(json))
    const plaintextBytes = Buffer.byteLength(json, "utf8")
    if (
      plaintextBytes < 2 ||
      plaintextBytes > MAX_PAYOUT_ENCRYPTION_PLAINTEXT_BYTES
    ) {
      throw new Error("Payout encryption plaintext is outside allowed bounds")
    }

    const keyId = this.keyProvider.activeKeyId
    const key = requireProviderKey(this.keyProvider.getKey(keyId))
    const iv = randomBytes(IV_LENGTH)
    try {
      const cipher = createCipheriv(ALGORITHM, key, iv)
      cipher.setAAD(serializeContext(context))
      const encrypted = Buffer.concat([
        cipher.update(json, "utf8"),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()
      const payload = Buffer.concat([iv, tag, encrypted]).toString("base64")
      return {
        ciphertext: `${PAYOUT_ENCRYPTION_ENVELOPE_PREFIX}:${keyId}:${payload}`,
        version: CURRENT_PAYOUT_KEY_VERSION,
        keyId,
      }
    } finally {
      key.fill(0)
    }
  }

  decrypt(
    ciphertext: string,
    version: number,
    context?: PayoutEncryptionContext,
  ): Record<string, unknown> {
    if (version === CURRENT_PAYOUT_KEY_VERSION) {
      if (!context) {
        throw new Error("Payout v2 decryption requires immutable context")
      }
      return this.decryptV2(ciphertext, context)
    }
    if (version !== 0 && version !== 1) {
      throw new Error(
        `Unsupported payout encryption format version: ${version}`,
      )
    }
    if (ciphertext.startsWith(`${PAYOUT_ENCRYPTION_ENVELOPE_PREFIX}:`)) {
      throw new Error("Payout encryption version does not match its envelope")
    }
    return this.decryptLegacy(ciphertext, version)
  }

  getEnvelopeKeyId(ciphertext: string): string | null {
    if (!ciphertext.startsWith(`${PAYOUT_ENCRYPTION_ENVELOPE_PREFIX}:`)) {
      return null
    }
    return parseEnvelope(ciphertext).keyId
  }

  extractDisplayDetails(
    details: Record<string, unknown>,
    type: string,
  ): Record<string, unknown> {
    const display: Record<string, unknown> = {}
    if (type === "bank_transfer") {
      if (details.bankName) display.bankName = details.bankName
      if (details.accountNumber) {
        const s = String(details.accountNumber)
        display.last4 = s.length >= 4 ? s.slice(-4) : s
      }
    } else if (type === "paypal") {
      if (details.email) {
        const e = String(details.email)
        const at = e.indexOf("@")
        display.maskedEmail =
          at > 0
            ? `${e[0]}${"*".repeat(Math.min(at - 1, 4))}@${e.slice(at + 1)}`
            : "****"
      }
    } else if (type === "wise") {
      if (details.currency) display.currency = details.currency
      if (details.targetCurrency)
        display.targetCurrency = details.targetCurrency
    }
    return display
  }

  mask(details: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(details)) {
      if (SENSITIVE_FIELDS.includes(key) && typeof value === "string") {
        masked[key] =
          value.length > 4
            ? `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 4, 8))}`
            : "****"
      } else {
        masked[key] = value
      }
    }
    return masked
  }

  redactSensitive(message: string): string {
    for (const field of SENSITIVE_FIELDS) {
      const regex = new RegExp(`("${field}"\\s*:\\s*")([^"]+)(")`, "gi")
      message = message.replace(
        regex,
        (_, pre, __, post) => `${pre}[REDACTED]${post}`,
      )
    }
    return message
  }

  private decryptV2(
    ciphertext: string,
    context: PayoutEncryptionContext,
  ): Record<string, unknown> {
    const { keyId, payload } = parseEnvelope(ciphertext)
    const key = requireProviderKey(this.keyProvider.getKey(keyId))
    try {
      return decryptJson(payload, key, serializeContext(context))
    } finally {
      key.fill(0)
    }
  }

  private decryptLegacy(
    ciphertext: string,
    version: 0 | 1,
  ): Record<string, unknown> {
    const providedLegacyKey = this.keyProvider.getLegacyKey()
    if (!providedLegacyKey) {
      throw new Error(
        "Legacy payout ciphertext exists but PAYOUT_ENCRYPTION_KEY is unavailable",
      )
    }
    const masterKey = requireProviderKey(providedLegacyKey)
    let key: Buffer
    if (version === 0) {
      key = masterKey
    } else {
      try {
        key = scryptSync(masterKey, "payout-key-v1", KEY_LENGTH)
      } finally {
        masterKey.fill(0)
      }
    }
    try {
      return decryptJson(ciphertext, key)
    } finally {
      key.fill(0)
    }
  }

  private validateProvider() {
    const ids = this.keyProvider.keyIds
    if (
      ids.length < 1 ||
      ids.length > MAX_PAYOUT_ENCRYPTION_KEYS ||
      !ids.includes(this.keyProvider.activeKeyId)
    ) {
      throw new Error("Payout encryption key provider has an invalid key set")
    }
    const fingerprints = new Set<string>()
    for (const keyId of ids) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new Error("Payout encryption provider returned an invalid key ID")
      }
      const key = requireProviderKey(this.keyProvider.getKey(keyId))
      try {
        if (key.length !== KEY_LENGTH) {
          throw new Error("Payout encryption provider returned an invalid key")
        }
        const fingerprint = key.toString("hex")
        if (fingerprints.has(fingerprint)) {
          throw new Error("Payout encryption provider returned duplicate keys")
        }
        fingerprints.add(fingerprint)
      } finally {
        key.fill(0)
      }
    }
    const providedLegacyKey = this.keyProvider.getLegacyKey()
    if (providedLegacyKey) {
      const legacyKey = requireProviderKey(providedLegacyKey)
      try {
        if (fingerprints.has(legacyKey.toString("hex"))) {
          throw new Error(
            "Payout encryption provider reused the legacy key as a v2 key",
          )
        }
      } finally {
        legacyKey.fill(0)
      }
    }
  }
}

function parseEnvelope(ciphertext: string): { keyId: string; payload: string } {
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length < 46 ||
    ciphertext.length > 90_068
  ) {
    throw new Error("Invalid payout encryption v2 envelope")
  }
  const parts = ciphertext.split(":")
  if (
    parts.length !== ENVELOPE_PARTS ||
    parts[0] !== PAYOUT_ENCRYPTION_ENVELOPE_PREFIX ||
    !KEY_ID_PATTERN.test(parts[1])
  ) {
    throw new Error("Invalid payout encryption v2 envelope")
  }
  assertCanonicalBase64(parts[2])
  return { keyId: parts[1], payload: parts[2] }
}

function decryptJson(
  payload: string,
  key: Buffer,
  aad?: Buffer,
): Record<string, unknown> {
  assertCanonicalBase64(payload)
  const raw = Buffer.from(payload, "base64")
  if (
    raw.length < IV_LENGTH + TAG_LENGTH + 2 ||
    raw.length > MAX_PAYOUT_ENCRYPTION_PLAINTEXT_BYTES + IV_LENGTH + TAG_LENGTH
  ) {
    throw new Error("Invalid encrypted payout payload")
  }
  const iv = raw.subarray(0, IV_LENGTH)
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const data = raw.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  let parsed: unknown
  try {
    parsed = JSON.parse(decrypted.toString("utf8"))
  } catch {
    throw new Error("Decrypted payout payload is not valid JSON")
  } finally {
    decrypted.fill(0)
  }
  assertPlainObject(parsed)
  return parsed
}

function serializeContext(context: PayoutEncryptionContext): Buffer {
  let tuple: readonly string[]
  if (context.kind === "payout-method-details") {
    tuple = [
      "guestpost:payout:v2",
      context.kind,
      requireContextValue(context.id, "payout method ID"),
      requireContextValue(context.publisherId, "publisher ID"),
      requireContextValue(context.type, "payout method type"),
    ]
  } else if (context.kind === "payout-provider-config") {
    tuple = [
      "guestpost:payout:v2",
      context.kind,
      requireContextValue(context.id, "payout provider ID"),
      requireContextValue(context.name, "payout provider name"),
    ]
  } else {
    throw new Error("Unsupported payout encryption context")
  }
  return Buffer.from(JSON.stringify(tuple), "utf8")
}

function requireContextValue(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 191) {
    throw new Error(`Invalid ${label} for payout encryption context`)
  }
  return value
}

function assertCanonicalBase64(value: string) {
  if (
    value.length < 1 ||
    value.length > 90_000 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error("Invalid payout ciphertext encoding")
  }
  const decoded = Buffer.from(value, "base64")
  if (decoded.toString("base64") !== value) {
    throw new Error("Payout ciphertext must use canonical base64")
  }
}

function assertPlainObject(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Payout encryption payload must be a JSON object")
  }
}

function requireProviderKey(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== KEY_LENGTH) {
    if (Buffer.isBuffer(value)) value.fill(0)
    throw new Error("Payout encryption provider returned an invalid key")
  }
  return value
}
