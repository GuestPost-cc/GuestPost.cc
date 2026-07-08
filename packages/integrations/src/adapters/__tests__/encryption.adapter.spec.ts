import { IntegrationEncryptionService } from "../encryption.adapter"

describe("IntegrationEncryptionService", () => {
  let service: IntegrationEncryptionService

  beforeEach(() => {
    service = new IntegrationEncryptionService()
  })

  describe("encrypt and decrypt roundtrip", () => {
    it("encrypts and decrypts a simple payload", () => {
      const plaintext = { value: "super-secret-token" }
      const encrypted = service.encrypt(plaintext)
      expect(encrypted.ciphertext).not.toBe(JSON.stringify(plaintext))
      expect(encrypted.version).toBe(1)

      const decrypted = service.decrypt(encrypted.ciphertext, encrypted.version)
      expect(decrypted).toEqual(plaintext)
    })

    it("encrypts different values to different ciphertexts", () => {
      const payload1 = { value: "token-a" }
      const payload2 = { value: "token-b" }
      const enc1 = service.encrypt(payload1)
      const enc2 = service.encrypt(payload2)
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext)
    })

    it("encrypts same value to different ciphertexts (random IV)", () => {
      const payload = { value: "same-token" }
      const enc1 = service.encrypt(payload)
      const enc2 = service.encrypt(payload)
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext)

      const dec1 = service.decrypt(enc1.ciphertext, enc1.version)
      const dec2 = service.decrypt(enc2.ciphertext, enc2.version)
      expect(dec1).toEqual(payload)
      expect(dec2).toEqual(payload)
    })

    it("handles complex nested payloads", () => {
      const payload = {
        accessToken: "ya29.a0AfH6...",
        refreshToken: "1//0gYJ9...",
        scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
      }
      const encrypted = service.encrypt(payload)
      const decrypted = service.decrypt(encrypted.ciphertext, encrypted.version)
      expect(decrypted).toEqual(payload)
    })

    it("handles empty object", () => {
      const payload = {}
      const encrypted = service.encrypt(payload)
      const decrypted = service.decrypt(encrypted.ciphertext, encrypted.version)
      expect(decrypted).toEqual(payload)
    })

    it("handles unicode characters", () => {
      const payload = { value: "token-with-unicode-日本語-emoji-🎉" }
      const encrypted = service.encrypt(payload)
      const decrypted = service.decrypt(encrypted.ciphertext, encrypted.version)
      expect(decrypted).toEqual(payload)
    })

    it("handles very long values", () => {
      const longToken = "x".repeat(10000)
      const payload = { value: longToken }
      const encrypted = service.encrypt(payload)
      const decrypted = service.decrypt(encrypted.ciphertext, encrypted.version)
      expect(decrypted).toEqual(payload)
    })
  })

  describe("currentVersion", () => {
    it("returns 1 as the current version", () => {
      expect(service.currentVersion).toBe(1)
    })
  })

  describe("decrypt with wrong version", () => {
    it("throws on tampered ciphertext", () => {
      const payload = { value: "test" }
      const encrypted = service.encrypt(payload)
      const tampered = `${encrypted.ciphertext.slice(0, -4)}XXXX`
      expect(() => service.decrypt(tampered, encrypted.version)).toThrow()
    })

    it("throws on wrong version number", () => {
      const payload = { value: "test" }
      const encrypted = service.encrypt(payload)
      expect(() => service.decrypt(encrypted.ciphertext, 99)).toThrow()
    })
  })

  describe("version parameter defaults", () => {
    it("uses default version when not specified on encrypt", () => {
      const payload = { value: "test" }
      const encrypted = service.encrypt(payload)
      expect(encrypted.version).toBe(service.currentVersion)
    })

    it("uses default version when not specified on decrypt", () => {
      const payload = { value: "test" }
      const encrypted = service.encrypt(payload)
      const decrypted = service.decrypt(encrypted.ciphertext)
      expect(decrypted).toEqual(payload)
    })
  })
})
