/**
 * Phase 7.11 — Worker SSRF + DoS hardening (audit findings #13 + #14).
 *
 * Tests the safeFetch / readBodyWithCap / validateResolvedAddress
 * primitives lifted into @guestpost/shared. The two worker processors
 * (delivery-verification.processor.ts + verification.processor.ts)
 * adopt these in commit 2; the adoption regression guard at
 * phase-7-11-safe-fetch-adoption.spec.ts ensures they stay adopted.
 */
// Deep import: safe-fetch is intentionally NOT re-exported from
// @guestpost/shared's root index (it imports node:dns + undici, which
// the Next.js apps can't bundle). See packages/shared/src/index.ts.
import {
  isSafePublicUrl,
  validateResolvedAddress,
  readBodyWithCap,
  SafeFetchError,
  PRIVATE_IP_PATTERNS,
} from "@guestpost/shared/dist/safe-fetch"

describe("Phase 7.11 — isSafePublicUrl (pre-flight URL check)", () => {
  describe("protocol enforcement", () => {
    it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/html,<h1>x</h1>"])(
      "rejects non-http(s) protocol: %s",
      (url) => {
        expect(isSafePublicUrl(url)).toBe(false)
      },
    )

    it("accepts http://", () => {
      expect(isSafePublicUrl("http://example.com/")).toBe(true)
    })

    it("accepts https://", () => {
      expect(isSafePublicUrl("https://example.com/")).toBe(true)
    })
  })

  describe("internal-network hostname rejection", () => {
    it.each([
      "http://localhost/",
      "http://foo.localhost/",
      "http://service.local/",
      "http://intranet.internal/",
      "http://api.svc.local/",
    ])("rejects %s", (url) => {
      expect(isSafePublicUrl(url)).toBe(false)
    })
  })

  describe("literal private IP rejection (IPv4)", () => {
    it.each([
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://169.254.169.254/",  // AWS metadata
      "http://0.0.0.0/",
    ])("rejects %s", (url) => {
      expect(isSafePublicUrl(url)).toBe(false)
    })
  })

  describe("literal private IP rejection (IPv6)", () => {
    it.each([
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
    ])("rejects %s", (url) => {
      expect(isSafePublicUrl(url)).toBe(false)
    })
  })

  describe("public hosts accepted", () => {
    it("accepts public IPv4", () => {
      expect(isSafePublicUrl("http://1.1.1.1/")).toBe(true)
      expect(isSafePublicUrl("http://8.8.8.8/")).toBe(true)
    })

    it("accepts public IPv6", () => {
      expect(isSafePublicUrl("http://[2001:4860:4860::8888]/")).toBe(true)
    })

    it("accepts URLs with paths + query strings", () => {
      expect(isSafePublicUrl("https://example.com/foo/bar?a=1&b=2")).toBe(true)
    })
  })

  describe("malformed input", () => {
    it("rejects malformed URLs gracefully", () => {
      expect(isSafePublicUrl("not a url")).toBe(false)
      expect(isSafePublicUrl("")).toBe(false)
      expect(isSafePublicUrl("http://")).toBe(false)
    })
  })
})

describe("Phase 7.11 — validateResolvedAddress (pure DNS-rebinding validator)", () => {
  describe("accepts public addresses", () => {
    it.each(["1.1.1.1", "8.8.8.8", "142.250.190.46"])("returns null for public IPv4: %s", (addr) => {
      expect(validateResolvedAddress("example.com", addr)).toBeNull()
    })

    it("returns null for public IPv6", () => {
      expect(validateResolvedAddress("example.com", "2001:4860:4860::8888")).toBeNull()
    })
  })

  describe("rejects private IPv4 ranges", () => {
    it.each([
      ["127.0.0.1", "loopback"],
      ["10.5.5.5", "10.0.0.0/8"],
      ["192.168.1.1", "192.168.0.0/16"],
      ["172.16.0.1", "172.16.0.0/12"],
      ["172.31.255.255", "172.16.0.0/12 upper"],
      ["169.254.169.254", "link-local + AWS metadata"],
      ["0.0.0.0", "unspecified"],
    ])("returns SafeFetchError(DNS_REBINDING) for %s (%s)", (addr) => {
      const err = validateResolvedAddress("evil.example.com", addr)
      expect(err).not.toBeNull()
      expect(err!.code).toBe("DNS_REBINDING")
      expect(err!.message).toContain(addr)
      expect(err!.message).toContain("evil.example.com")
    })
  })

  describe("rejects private IPv6", () => {
    it.each(["::1", "fe80::1", "fc00::1", "fd12:3456:789a::1"])(
      "returns error for %s",
      (addr) => {
        const err = validateResolvedAddress("evil.example.com", addr)
        expect(err).not.toBeNull()
        expect(err!.code).toBe("DNS_REBINDING")
      },
    )
  })

  describe("rejects IPv4-mapped IPv6 (the bonus catch)", () => {
    it.each(["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254"])(
      "returns error for %s",
      (addr) => {
        const err = validateResolvedAddress("evil.example.com", addr)
        expect(err).not.toBeNull()
        expect(err!.code).toBe("DNS_REBINDING")
      },
    )
  })

  describe("defensive: empty address", () => {
    it("returns null for empty string (caller should check dns.lookup err first)", () => {
      expect(validateResolvedAddress("example.com", "")).toBeNull()
    })
  })
})

describe("Phase 7.11 — readBodyWithCap (response body size limit)", () => {
  function mkResponse(chunks: Uint8Array[]): Response {
    let i = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++])
        else controller.close()
      },
    })
    return new Response(stream)
  }

  it("returns body under the cap", async () => {
    const body = "hello world"
    const res = mkResponse([new TextEncoder().encode(body)])
    expect(await readBodyWithCap(res, 1024)).toBe(body)
  })

  it("returns body when exactly at the cap", async () => {
    const body = "a".repeat(100)
    const res = mkResponse([new TextEncoder().encode(body)])
    expect(await readBodyWithCap(res, 100)).toBe(body)
  })

  it("throws SafeFetchError(BODY_TOO_LARGE) when one byte over cap", async () => {
    const body = "a".repeat(101)
    const res = mkResponse([new TextEncoder().encode(body)])
    await expect(readBodyWithCap(res, 100)).rejects.toThrow(SafeFetchError)
    try {
      await readBodyWithCap(mkResponse([new TextEncoder().encode(body)]), 100)
    } catch (err: any) {
      expect(err.code).toBe("BODY_TOO_LARGE")
      expect(err.message).toContain("100")
    }
  })

  it("returns empty string for null body", async () => {
    const res = new Response(null)
    expect(await readBodyWithCap(res, 1024)).toBe("")
  })

  it("decodes UTF-8 across chunk boundaries (3-byte codepoint split)", async () => {
    // U+1F600 (grinning face) encodes as F0 9F 98 80 (4 bytes).
    // Split into 2 chunks: [F0 9F] + [98 80]. Decoder must handle.
    const chunk1 = new Uint8Array([0xf0, 0x9f])
    const chunk2 = new Uint8Array([0x98, 0x80])
    const res = mkResponse([chunk1, chunk2])
    expect(await readBodyWithCap(res, 1024)).toBe("\u{1F600}")
  })

  it("cancels the reader on overrun (no leaked connection)", async () => {
    // Stream that stays open indefinitely after enqueueing the
    // oversize chunk. If readBodyWithCap doesn't call cancel(), this
    // test would hang on the next read() — the assertion proves the
    // capped reader aborts the connection cleanly.
    const encoded = new TextEncoder().encode("a".repeat(101))
    let cancelCalled = false
    let enqueued = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!enqueued) {
          controller.enqueue(encoded)
          enqueued = true
        }
        // Deliberately do NOT close — only the reader's cancel() should
        // stop this stream.
      },
      cancel() {
        cancelCalled = true
      },
    })
    const res = new Response(stream)
    await expect(readBodyWithCap(res, 100)).rejects.toThrow(SafeFetchError)
    expect(cancelCalled).toBe(true)
  })
})

describe("Phase 7.11 — PRIVATE_IP_PATTERNS sanity (regression guard)", () => {
  it("includes IPv4-mapped IPv6 patterns (the bonus catch from this phase)", () => {
    const ipv4Mapped = PRIVATE_IP_PATTERNS.filter((p) => p.source.includes("ffff"))
    expect(ipv4Mapped.length).toBeGreaterThanOrEqual(5)
  })

  it("rejects every IPv4 private range via the same patterns isSafePublicUrl uses", () => {
    expect(PRIVATE_IP_PATTERNS.some((p) => p.test("127.0.0.1"))).toBe(true)
    expect(PRIVATE_IP_PATTERNS.some((p) => p.test("10.0.0.1"))).toBe(true)
    expect(PRIVATE_IP_PATTERNS.some((p) => p.test("169.254.169.254"))).toBe(true)
  })
})
