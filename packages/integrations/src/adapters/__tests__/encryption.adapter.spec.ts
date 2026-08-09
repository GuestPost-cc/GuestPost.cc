import {
  IntegrationEncryptionService,
  integrationTokenEncryptionContext,
} from "../encryption.adapter"

const KEY_A = "a".repeat(64)
const KEY_B = "b".repeat(64)
const TOKEN_IDENTITY = {
  provider: "GOOGLE_SEARCH_CONSOLE",
  externalUserId: "google-user-1",
  ownerType: "PUBLISHER",
  ownerId: "publisher-1",
}

describe("IntegrationEncryptionService", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.NODE_ENV = "test"
    delete process.env.INTEGRATION_ENCRYPTION_KEY
    delete process.env.INTEGRATION_ENCRYPTION_KEYS
    delete process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it("round-trips authenticated ciphertext with the active key version", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const service = new IntegrationEncryptionService()
    const plaintext = { value: "super-secret-token" }

    const encrypted = service.encrypt(plaintext)

    expect(encrypted.version).toBe(1)
    expect(encrypted.ciphertext).not.toContain(plaintext.value)
    expect(service.decrypt(encrypted.ciphertext, encrypted.version)).toEqual(
      plaintext,
    )
  })

  it("uses a random IV for repeated plaintext", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const service = new IntegrationEncryptionService()
    const first = service.encrypt({ value: "same-token" })
    const second = service.encrypt({ value: "same-token" })

    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(service.decrypt(first.ciphertext, first.version)).toEqual({
      value: "same-token",
    })
    expect(service.decrypt(second.ciphertext, second.version)).toEqual({
      value: "same-token",
    })
  })

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(66)],
    ["non-hex prefix", `z${"a".repeat(63)}`],
    ["non-hex suffix", `${"a".repeat(63)}z`],
    ["whitespace", `${"a".repeat(63)} `],
  ])("rejects a configured legacy key that is %s", (_label, key) => {
    process.env.INTEGRATION_ENCRYPTION_KEY = key
    expect(() => new IntegrationEncryptionService()).toThrow(
      /exactly 64 hexadecimal characters/,
    )
  })

  it("requires a configured key in production", () => {
    process.env.NODE_ENV = "production"
    expect(() => new IntegrationEncryptionService()).toThrow(
      /INTEGRATION_ENCRYPTION_KEY/,
    )
  })

  it("accepts the legacy development derivation only outside production", () => {
    const service = new IntegrationEncryptionService()
    const encrypted = service.encrypt({ value: "local-only" })
    expect(encrypted.version).toBe(1)
    expect(service.decrypt(encrypted.ciphertext, 1)).toEqual({
      value: "local-only",
    })
  })

  it("writes with the active key while retaining old-version reads", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const legacyService = new IntegrationEncryptionService()
    const oldPayload = legacyService.encrypt({ value: "old-token" })

    delete process.env.INTEGRATION_ENCRYPTION_KEY
    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: KEY_A,
      2: KEY_B,
    })
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "2"
    const rotatingService = new IntegrationEncryptionService()
    const accessContext = integrationTokenEncryptionContext(
      TOKEN_IDENTITY,
      "access",
    )
    const newPayload = rotatingService.encrypt(
      { value: "new-token" },
      { authenticatedContext: accessContext },
    )

    expect(rotatingService.currentVersion).toBe(2)
    expect(rotatingService.supportedVersions).toEqual([1, 2])
    expect(newPayload.version).toBe(2)
    expect(rotatingService.decrypt(oldPayload.ciphertext, 1)).toEqual({
      value: "old-token",
    })
    expect(
      rotatingService.decrypt(newPayload.ciphertext, 2, accessContext),
    ).toEqual({ value: "new-token" })
    expect(newPayload.ciphertext).toMatch(/^v2:/)
  })

  it("rejects ambiguous, incomplete, or duplicate keyring configuration", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({ 1: KEY_A })
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "1"
    expect(() => new IntegrationEncryptionService()).toThrow(/not both/)

    delete process.env.INTEGRATION_ENCRYPTION_KEY
    delete process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION
    expect(() => new IntegrationEncryptionService()).toThrow(
      /ACTIVE_VERSION is required/,
    )

    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "2"
    expect(() => new IntegrationEncryptionService()).toThrow(/not present/)

    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: KEY_A,
      2: KEY_A,
    })
    expect(() => new IntegrationEncryptionService()).toThrow(/distinct keys/)
  })

  it("rejects malformed keyring JSON, versions, and key values", () => {
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "1"
    process.env.INTEGRATION_ENCRYPTION_KEYS = "[]"
    expect(() => new IntegrationEncryptionService()).toThrow(/JSON object/)

    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({ 0: KEY_A })
    expect(() => new IntegrationEncryptionService()).toThrow(/positive/)

    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: `${"a".repeat(63)}z`,
    })
    expect(() => new IntegrationEncryptionService()).toThrow(
      /exactly 64 hexadecimal characters/,
    )
  })

  it("rejects explicit empty configuration instead of using the dev key", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = ""
    expect(() => new IntegrationEncryptionService()).toThrow(
      /exactly 64 hexadecimal characters/,
    )

    delete process.env.INTEGRATION_ENCRYPTION_KEY
    process.env.INTEGRATION_ENCRYPTION_KEYS = ""
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "2"
    expect(() => new IntegrationEncryptionService()).toThrow(/JSON object/)

    delete process.env.INTEGRATION_ENCRYPTION_KEYS
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = ""
    expect(() => new IntegrationEncryptionService()).toThrow(
      /positive 32-bit integer/,
    )
  })

  it("requires the highest configured key version to remain active", () => {
    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: KEY_A,
      2: KEY_B,
    })
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "1"
    expect(() => new IntegrationEncryptionService()).toThrow(
      /highest configured key version/,
    )
  })

  it("binds v2 ciphertext to account identity and token purpose", () => {
    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: KEY_A,
      2: KEY_B,
    })
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "2"
    const service = new IntegrationEncryptionService()
    const accessContext = integrationTokenEncryptionContext(
      TOKEN_IDENTITY,
      "access",
    )
    const refreshContext = integrationTokenEncryptionContext(
      TOKEN_IDENTITY,
      "refresh",
    )
    const otherOwnerContext = integrationTokenEncryptionContext(
      { ...TOKEN_IDENTITY, ownerId: "publisher-2" },
      "access",
    )
    const encrypted = service.encrypt(
      { value: "bound-token" },
      { authenticatedContext: accessContext },
    )

    expect(service.decrypt(encrypted.ciphertext, 2, accessContext)).toEqual({
      value: "bound-token",
    })
    expect(() => service.decrypt(encrypted.ciphertext, 2)).toThrow(
      /context is required/,
    )
    expect(() =>
      service.decrypt(encrypted.ciphertext, 2, refreshContext),
    ).toThrow()
    expect(() =>
      service.decrypt(encrypted.ciphertext, 2, otherOwnerContext),
    ).toThrow()
  })

  it("rejects an unversioned stale-writer envelope for v2", () => {
    process.env.INTEGRATION_ENCRYPTION_KEYS = JSON.stringify({
      1: KEY_A,
      2: KEY_B,
    })
    process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION = "2"
    const service = new IntegrationEncryptionService()
    const context = integrationTokenEncryptionContext(TOKEN_IDENTITY, "access")

    expect(() =>
      service.decrypt(
        "AQEBAQEBAQEBAQEBzaPeg4xUkTi+O1v/Pmn/MDwxQ9vUlJqzAouW9s8LMauvqFSZ/o/rZhLf",
        2,
        context,
      ),
    ).toThrow(/Invalid integration encrypted payload/)
  })

  it("requires an explicit supported version for every decrypt", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const service = new IntegrationEncryptionService()
    const encrypted = service.encrypt({ value: "test" })

    expect(() => (service.decrypt as any)(encrypted.ciphertext)).toThrow(
      /positive 32-bit integer/,
    )
    expect(() => service.decrypt(encrypted.ciphertext, 2)).toThrow(
      /Unsupported integration encryption key version/,
    )
  })

  it.each([
    "not-base64",
    "AAAA",
    "AAAA====",
    "YWJjZA==\n",
  ])("rejects malformed or short ciphertext %p", (ciphertext) => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const service = new IntegrationEncryptionService()
    expect(() => service.decrypt(ciphertext, 1)).toThrow(
      /Invalid integration encrypted payload/,
    )
  })

  it("rejects tampered ciphertext", () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
    const service = new IntegrationEncryptionService()
    const encrypted = service.encrypt({ value: "test" })
    const raw = Buffer.from(encrypted.ciphertext, "base64")
    raw[raw.length - 1] ^= 0xff

    expect(() => service.decrypt(raw.toString("base64"), 1)).toThrow()
  })
})
