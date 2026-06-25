import { renderVerificationEmail } from "../email-templates/verification"

describe("Phase 7.10 — verification email template", () => {
  describe("happy path", () => {
    it("includes the verify-email URL inside an <a href>", () => {
      const url =
        "https://app.example.com/api/v1/auth/verify-email?token=abc123"
      const html = renderVerificationEmail({ name: "Alice", url })
      expect(html).toContain(`href="${url}"`)
    })

    it("greets the user by name when name is present", () => {
      const html = renderVerificationEmail({
        name: "Alice",
        url: "https://x/y",
      })
      expect(html).toContain("Hi Alice")
    })

    it("falls back to a generic greeting when name is null", () => {
      const html = renderVerificationEmail({ name: null, url: "https://x/y" })
      expect(html).toMatch(/Hi —/) // em-dash separator after the bare "Hi"
      expect(html).not.toMatch(/Hi null/)
    })
  })

  describe("XSS escaping", () => {
    it("escapes <script> tags injected into the user name", () => {
      const html = renderVerificationEmail({
        name: "<script>alert('xss')</script>",
        url: "https://x/y",
      })
      expect(html).not.toContain("<script>alert")
      expect(html).toContain("&lt;script&gt;alert")
    })

    it("escapes HTML entities in the URL attribute", () => {
      // A malicious url that tries to break out of the href attribute.
      const html = renderVerificationEmail({
        name: null,
        url: `https://evil.example/path"onmouseover="alert('xss')`,
      })
      // The literal closing-quote-plus-onmouseover should not appear unescaped
      // inside the href attribute.
      expect(html).not.toMatch(
        /href="https:\/\/evil\.example\/path"onmouseover/,
      )
      // The unsafe quote is escaped to its entity.
      expect(html).toContain("&quot;onmouseover=")
    })

    it("escapes &, <, > in the URL when rendered as plain text fallback", () => {
      const html = renderVerificationEmail({
        name: null,
        url: "https://x/y?a=1&b=<script>",
      })
      // The plain-text <code> rendering of the URL must escape <, >, &.
      expect(html).toContain("&amp;b=&lt;script&gt;")
    })
  })

  describe("structure sanity", () => {
    it("returns a complete HTML document", () => {
      const html = renderVerificationEmail({
        name: "Alice",
        url: "https://x/y",
      })
      expect(html).toContain("<!DOCTYPE html>")
      expect(html).toContain("</body></html>")
    })
  })
})
