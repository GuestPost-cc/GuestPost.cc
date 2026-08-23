/**
 * Publisher integrations "Link property" regression guard.
 *
 * The Link button on the integration detail page used to POST
 * `websiteId: ""` — a value the server schema (`z.string().cuid()` in
 * linkPropertyRequestSchema) always rejects, so the primary linking
 * flow could never succeed. The fix routes linking through a dialog
 * that resolves a real publisher website id first.
 *
 * Static-source guard (same class as phase-7-11-safe-fetch-adoption):
 * apps/publisher has no unit-test runner, and the end-to-end flow needs
 * live Google OAuth credentials, so CI can only enforce the contract by
 * grepping the page source for the forbidden placeholder payload.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PAGE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "publisher",
  "src",
  "app",
  "dashboard",
  "integrations",
  "[id]",
  "page.tsx",
)

const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp; why: string }> =
  [
    {
      name: "empty-string websiteId in link mutation",
      regex: /websiteId\s*:\s*(?:""|''|``)/gm,
      why: 'linkPropertyRequestSchema requires websiteId as a non-empty cuid. Passing "" is rejected with 400 before reaching the service. Resolve a real publisher website id (see the link-property dialog) before calling api.integrations.linkProperty.',
    },
  ]

describe("publisher integrations link-property regression guard", () => {
  it("integrations/[id]/page.tsx never sends an empty websiteId", () => {
    const content = readFileSync(PAGE_PATH, "utf-8")
    const hits: string[] = []

    for (const { name, regex, why } of FORBIDDEN_PATTERNS) {
      regex.lastIndex = 0
      const lines = content.split("\n")
      let m: RegExpExecArray | null
      while ((m = regex.exec(content)) !== null) {
        const lineIdx = content.slice(0, m.index).split("\n").length - 1
        hits.push(
          [
            `Rule : ${name}`,
            `Why  : ${why}`,
            `Hit  : ${PAGE_PATH}:${lineIdx + 1}  ${lines[lineIdx].trim()}`,
          ].join("\n"),
        )
      }
    }

    expect(hits).toEqual([])
  })

  it("linking requires selecting a real publisher website through the dialog", () => {
    const content = readFileSync(PAGE_PATH, "utf-8")

    expect(content).toMatch(/openLinkDialog/)
    expect(content).toMatch(/confirmLink/)
    expect(content).toMatch(/selectedWebsiteId/)
    expect(content).toContain("mutateAsync({")

    const confirmCall = content.match(
      /confirmLink[\s\S]*?mutateAsync\(\{([\s\S]*?)\}\)/,
    )
    expect(confirmCall).not.toBeNull()
    expect(confirmCall?.[1]).toContain("websiteId: selectedWebsiteId")
    expect(confirmCall?.[1]).not.toContain('websiteId: ""')
  })
})
