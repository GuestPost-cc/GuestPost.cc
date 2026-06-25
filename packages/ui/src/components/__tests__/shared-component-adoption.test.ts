/**
 * Phase 7.9 #29 — adoption regression guard.
 *
 * Asserts the hand-rolled equivalents of the shared components stay
 * deleted. Same defense-in-depth pattern as the Phase 7.7 structured-
 * logger sweep and Phase 7.8 repeatable-job-registry drift guards.
 *
 * If a future contributor reintroduces:
 *   - OrderSupportPanel (or any function/const named that)
 *   - inline fulfillmentChannel === "PLATFORM" ternaries in JSX
 *   - a local ChannelBadge component
 * ...this spec fails CI with the matching file:line so the regression
 * is visible in the PR diff.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..")
const SCAN_ROOTS = ["apps/portal/src", "apps/admin/src", "apps/publisher/src"]

// Scope discipline: directories + filename patterns that legitimately
// reference these strings (test mocks, fixtures, generated files,
// build output, dependencies). The grep MUST exclude these or it
// fires on its own surroundings.
const EXCLUDE_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "__tests__",
  "__mocks__",
  "__fixtures__",
])
const EXCLUDE_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

function walk(dir: string, hits: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return hits
  }
  for (const name of entries) {
    if (EXCLUDE_DIR_NAMES.has(name)) continue
    const full = join(dir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      walk(full, hits)
    } else if (s.isFile()) {
      if (EXCLUDE_FILE_RE.test(name)) continue
      if (!/\.(tsx?|jsx?)$/.test(name)) continue
      hits.push(full)
    }
  }
  return hits
}

// Each rule = { name, re, why }. `re` matches the FORBIDDEN substring;
// the test fails if any non-excluded source file matches it.
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp; why: string }> = [
  {
    name: "OrderSupportPanel reintroduced",
    // Both function declaration and const-assignment forms.
    re: /(?:function\s+OrderSupportPanel\b|const\s+OrderSupportPanel\s*=)/,
    why:
      "OrderSupportPanel was a portal-local hand-roll of SupportPanel.\n" +
      "Use <SupportPanel> from @guestpost/ui instead and pass tickets +\n" +
      "isLoading from a parent useQuery.",
  },
  {
    name: 'Inline channel-label ternary ("Platform"/"Publisher" string)',
    // Only the BADGE pattern: `channel === "PLATFORM" ? "Platform" : ...`.
    // Boolean-only uses like `fulfillmentChannel === "PLATFORM"` that
    // dispatch on downstream business logic (e.g. assignedTo vs
    // assignedPublisher) are legitimate and not flagged.
    re: /fulfillmentChannel\s*===\s*["']PLATFORM["']\s*\?\s*["']Platform/,
    why:
      "Use <FulfillmentChannelBadge channel={...} /> from @guestpost/ui.\n" +
      "The component already maps PLATFORM/PUBLISHER/null to the right\n" +
      'label + styling; inline `"Platform" : "Publisher"` ternaries\n' +
      "duplicate that mapping and drift over time.",
  },
  {
    name: "Local ChannelBadge component definition",
    re: /(?:function\s+ChannelBadge\b|const\s+ChannelBadge\s*=)/,
    why:
      "Two admin pages used to declare their own ChannelBadge. Use the\n" +
      "shared <FulfillmentChannelBadge> from @guestpost/ui — same visual\n" +
      "category, single source of truth.",
  },
]

describe("Phase 7.9 #29 — shared-component adoption regression guard", () => {
  it("scans a non-empty set of app source files (sanity)", () => {
    let total = 0
    for (const root of SCAN_ROOTS) {
      total += walk(join(REPO_ROOT, root)).length
    }
    expect(total).toBeGreaterThan(50)
  })

  for (const rule of FORBIDDEN_PATTERNS) {
    it(`asserts no production source reintroduces "${rule.name}"`, () => {
      const hits: string[] = []
      for (const root of SCAN_ROOTS) {
        for (const file of walk(join(REPO_ROOT, root))) {
          const content = readFileSync(file, "utf8")
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            if (rule.re.test(lines[i])) {
              hits.push(
                `${relative(REPO_ROOT, file)}:${i + 1}  ${lines[i].trim()}`,
              )
            }
          }
        }
      }
      if (hits.length > 0) {
        throw new Error(
          [
            `\n${rule.name}`,
            rule.why,
            "",
            "Offending occurrences:",
            ...hits.map((h) => `  ${h}`),
          ].join("\n"),
        )
      }
      expect(hits).toEqual([])
    })
  }
})
