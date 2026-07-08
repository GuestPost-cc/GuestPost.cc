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
const CURRENT_VERSION = 1

export interface EncryptedPayload {
  ciphertext: string
  version: number
}

export class IntegrationEncryptionService {
  private masterKey: Buffer

  constructor() {
    const hexKey = process.env.INTEGRATION_ENCRYPTION_KEY

    if (
      process.env.NODE_ENV === "production" &&
      (!hexKey || hexKey.length < 64)
    ) {
      throw new Error(
        "INTEGRATION_ENCRYPTION_KEY must be set to a 64+ character hex string in production",
      )
    }

    if (!hexKey || hexKey.length < 64) {
      this.masterKey = scryptSync(
        "dev-only-integration-key",
        "integration-dev-salt",
        KEY_LENGTH,
      )
    } else {
      this.masterKey = Buffer.from(hexKey.slice(0, 64), "hex")
    }
  }

  private deriveKey(version: number): Buffer {
    if (version === 0) return this.masterKey
    return scryptSync(this.masterKey, `integration-key-v${version}`, KEY_LENGTH)
  }

  encrypt(
    plaintext: Record<string, unknown>,
    version = CURRENT_VERSION,
  ): EncryptedPayload {
    const key = this.deriveKey(version)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)

    const plaintextStr = JSON.stringify(plaintext)
    const encrypted = Buffer.concat([
      cipher.update(plaintextStr, "utf8"),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    const combined = Buffer.concat([iv, tag, encrypted])
    return {
      ciphertext: combined.toString("base64"),
      version,
    }
  }

  decrypt(
    ciphertext: string,
    version = CURRENT_VERSION,
  ): Record<string, unknown> {
    const data = Buffer.from(ciphertext, "base64")
    const iv = data.subarray(0, IV_LENGTH)
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH)

    const key = this.deriveKey(version)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])

    return JSON.parse(decrypted.toString("utf8"))
  }

  get currentVersion(): number {
    return CURRENT_VERSION
  }
}
