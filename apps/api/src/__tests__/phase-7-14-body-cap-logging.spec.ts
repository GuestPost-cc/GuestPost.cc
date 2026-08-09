/**
 * Phase 7.14 — structured-log emission regression guard for the body-cap
 * silent-failure finding (#14). Asserts that both worker fetch boundaries that
 * use readBodyWithCap emit the structured fields (reason, maxBodySize,
 * contentLength) in their BODY_TOO_LARGE handler.
 *
 * Same defense-in-depth class as phase-7-11-safe-fetch-adoption.spec.ts.
 * Catches a future refactor that strips the telemetry fields while
 * keeping the non-null return (which would leave ops blind again).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKER_SRC_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "worker",
  "src",
)

const TARGET_FILES = [
  join(WORKER_SRC_DIR, "delivery-verification-fetch.ts"),
  join(WORKER_SRC_DIR, "processors", "verification.processor.ts"),
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
