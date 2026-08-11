import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("financial document startup validation contract", () => {
  const requiredIssuerKeys = [
    "INVOICE_DOCUMENT_PREFIX",
    "INVOICE_ISSUER_LEGAL_NAME",
    "INVOICE_ISSUER_ADDRESS_LINE_1",
    "INVOICE_ISSUER_CITY",
    "INVOICE_ISSUER_POSTAL_CODE",
    "INVOICE_ISSUER_COUNTRY_CODE",
    "INVOICE_SUPPORT_EMAIL",
  ] as const

  it.each([
    ["API", join(__dirname, "..", "main.ts")],
    ["worker", join(__dirname, "../../../worker/src/lib/env.ts")],
  ])("validates production invoice configuration during %s boot", (_, path) => {
    const source = readFileSync(path, "utf8")

    expect(source).toContain("financialDocumentIssuerFromEnv(process.env)")
    expect(source).toMatch(/NODE_ENV\s*===\s*["']production["']/)
    expect(source).toMatch(/financial document configuration/i)
    expect(source).toContain("process.exit(1)")
  })

  it("declares every server-only issuer field in the production API manifest", () => {
    const manifest = readFileSync(
      join(__dirname, "../../../../render.yml"),
      "utf8",
    )
    const apiService = manifest.split("    name: guestpost-portal")[0]

    for (const key of requiredIssuerKeys) {
      expect(apiService).toContain(`- key: ${key}`)
    }
    expect(manifest).not.toMatch(/NEXT_PUBLIC_INVOICE_/)
    expect(manifest.match(/autoDeployTrigger: off/g)).toHaveLength(5)
    expect(manifest).not.toContain("autoDeployTrigger: checksPass")
  })
})
