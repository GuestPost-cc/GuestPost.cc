/**
 * Phase 7.14 — structured-log emission regression guard for the body-cap
 * silent-failure finding (#14). Asserts that both worker processors that
 * use readBodyWithCap emit the structured fields (reason, maxBodySize,
 * contentLength) in their catch handler for BODY_TOO_LARGE.
 *
 * Same defense-in-depth class as phase-7-11-safe-fetch-adoption.spec.ts.
 * Catches a future refactor that strips the telemetry fields while
 * keeping the non-null return (which would leave ops blind again).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PROCESSORS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "worker",
  "src",
  "processors",
)

const TARGET_FILES = [
  join(PROCESSORS_DIR, "delivery-verification.processor.ts"),
  join(PROCESSORS_DIR, "verification.processor.ts"),
]

const REQUIRED_FIELDS = [
  'reason: "body_size_exceeded"',
  "maxBodySize",
  "contentLength",
]

describe("Phase 7.14 — body-cap structured-log emission guard", () => {
  it.each(TARGET_FILES)("%s emits all body-cap structured fields", (file) => {
    const src = readFileSync(file, "utf-8")
    const missing = REQUIRED_FIELDS.filter((field) => !src.includes(field))
    expect(missing).toEqual([])
  })

  it("no uncapped body reads remain (re-assert Phase 7.11 guard)", () => {
    for (const file of TARGET_FILES) {
      const src = readFileSync(file, "utf-8")
      const uncapped = /\bawait\s+(?:res|response|resp|r)\.text\(\)/gm
      expect(src).not.toMatch(uncapped)
    }
  })
})
