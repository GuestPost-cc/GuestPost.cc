import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto"
import { Injectable, Logger } from "@nestjs/common"
import { CURRENT_PAYOUT_KEY_VERSION } from "./payout-encryption.constants"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

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

@Injectable()
export class PayoutEncryptionService {
  private readonly logger = new Logger(PayoutEncryptionService.name)
  private masterKey: Buffer
  private currentVersion: number

  constructor() {
    const hexKey = process.env.PAYOUT_ENCRYPTION_KEY
    if (!hexKey || hexKey.length < 64) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "PAYOUT_ENCRYPTION_KEY must be set to a 64+ character hex string in production",
        )
      }
      this.logger.warn(
        "PAYOUT_ENCRYPTION_KEY not set or too short — using dev-only derived key. NEVER run this in production.",
      )
      this.masterKey = scryptSync(
        "dev-only-key-do-not-use-in-production",
        "salt",
        KEY_LENGTH,
      )
      this.currentVersion = 0
    } else {
      this.masterKey = Buffer.from(hexKey.slice(0, 64), "hex")
      this.currentVersion = CURRENT_PAYOUT_KEY_VERSION
    }
  }

  encrypt(
    plaintext: Record<string, unknown>,
    version?: number,
  ): { ciphertext: string; version: number } {
    const key = this.deriveKey(version ?? this.currentVersion)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const json = JSON.stringify(plaintext)
    const encrypted = Buffer.concat([
      cipher.update(json, "utf8"),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()
    const combined = Buffer.concat([iv, tag, encrypted])
    return {
      ciphertext: combined.toString("base64"),
      version: version ?? this.currentVersion,
    }
  }

  decrypt(ciphertext: string, version: number): Record<string, unknown> {
    const key = this.deriveKey(version)
    const raw = Buffer.from(ciphertext, "base64")
    if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error("Invalid encrypted payload")
    }
    const iv = raw.subarray(0, IV_LENGTH)
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const data = raw.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return JSON.parse(decrypted.toString("utf8"))
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

  deriveKey(version: number): Buffer {
    if (version === 0) return this.masterKey
    const salt = `payout-key-v${version}`
    return scryptSync(this.masterKey, salt, KEY_LENGTH)
  }
}
