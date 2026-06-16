// Phase 7.7 B — console.* sweep regression guard.
//
// PRINCIPLE: no `console.*` in production runtime code paths.
//
// Phase 7.7 introduces structured-logger; B is the foundation commit.
// Phase 7.7.x will incrementally sweep the remaining files file-by-file
// (each commit removes entries from CURRENTLY_ALLOWED_WITH_CONSOLE below).
//
// This test does NOT block today's partial sweep. It DOES block:
//   - any NEW file adding console.* (not on the allowlist)
//   - the explicitly-allowed files growing their console.* count
//     beyond their snapshotted baseline
//
// As Phase 7.7.x sweeps a file, remove it from the map (or drop its
// count to 0). When the map is empty except for the always-allowed
// entries (logger module + main.ts boot fallback), the sweep is done.

import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")

// Map of repo-relative path → max allowed console.* call count.
// Files NOT in this map MUST have zero console.* calls.
//
// Post-Phase-7.7.x state: the worker sweep is complete (all 8 files cleared).
// Only forever-allowed entries remain:
//
//   - apps/api/src/main.ts: absolute-last-resort boot/startup error handlers.
//     These fire BEFORE the Nest app + logger module are guaranteed to be
//     initialized — must remain console.* so a crashing boot still produces
//     visible diagnostics.
//
//   - apps/{admin,portal,publisher}/src/lib/auth.tsx: browser-side session-
//     refresh error handler. The structured-logger module is Node-only (uses
//     process.stdout/stderr); a browser-safe logger is a separate concern.
//     console.error is the correct API here. One call per file.
//
// If any other file appears with console.*, either sweep it to use createLogger
// from @guestpost/shared/dist/observability/structured-logger (preferred) or
// add to this map with a comment justifying why it's exempt.
const CURRENTLY_ALLOWED_WITH_CONSOLE: Record<string, number> = {
  "apps/api/src/main.ts": 6, // boot/startup last-resort
  "apps/admin/src/lib/auth.tsx": 1, // browser-side session-refresh error
  "apps/portal/src/lib/auth.tsx": 1, // browser-side session-refresh error
  "apps/publisher/src/lib/auth.tsx": 1, // browser-side session-refresh error
}

function countConsoleCalls(filepath: string): number {
  const content = fs.readFileSync(filepath, "utf8")
  // Match `console.log(`, `console.warn(`, `console.error(`, `console.info(`,
  // `console.debug(`. Anchored on `(` to exclude string-literal mentions.
  const matches = content.match(/console\.(log|warn|error|info|debug)\s*\(/g)
  return matches?.length ?? 0
}

function listProductionTsFiles(rootDirs: string[]): string[] {
  // Single git ls-files call avoids touching node_modules / dist.
  const result = execSync(
    `git -C ${repoRoot} ls-files ${rootDirs.map((d) => `'${d}'`).join(" ")}`,
    { encoding: "utf8" },
  )
  return result
    .split("\n")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .filter((f) => !f.includes("__tests__/"))
    .filter((f) => !f.endsWith(".spec.ts"))
    .filter((f) => !f.endsWith(".test.ts"))
}

describe("Phase 7.7 B — console.* sweep regression guard", () => {
  it("no production file outside the allowlist uses console.*", () => {
    const files = listProductionTsFiles(["apps/api/src", "apps/worker/src"])
    const offenders: Array<{ file: string; count: number; allowed: number }> = []
    for (const relPath of files) {
      const count = countConsoleCalls(path.join(repoRoot, relPath))
      const allowed = CURRENTLY_ALLOWED_WITH_CONSOLE[relPath] ?? 0
      if (count > allowed) {
        offenders.push({ file: relPath, count, allowed })
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  ${o.file}: ${o.count} > allowed ${o.allowed}`)
        .join("\n")
      throw new Error(
        `Phase 7.7 B sweep regression — ${offenders.length} file(s) have more console.* calls than allowed.\n` +
          `Either (1) sweep the file to use createLogger from @guestpost/shared/dist/observability/structured-logger,\n` +
          `or (2) update CURRENTLY_ALLOWED_WITH_CONSOLE in this spec with a clear comment + Phase 7.7.x ref.\n\n` +
          detail,
      )
    }
  })

  it("the allowlist entries still match their declared baselines (catches sweep-completion)", () => {
    // If an allowlisted file's count drops BELOW its baseline (e.g. partial
    // sweep landed without updating the map), this test fails loudly so the
    // map can be tightened. Keeps the allowlist honest as Phase 7.7.x lands.
    const drifted: Array<{ file: string; expected: number; actual: number }> = []
    for (const [relPath, expected] of Object.entries(CURRENTLY_ALLOWED_WITH_CONSOLE)) {
      const full = path.join(repoRoot, relPath)
      if (!fs.existsSync(full)) continue // file deleted is fine
      const actual = countConsoleCalls(full)
      if (actual < expected) {
        drifted.push({ file: relPath, expected, actual })
      }
    }
    if (drifted.length > 0) {
      const detail = drifted
        .map((d) => `  ${d.file}: ${d.actual} < declared ${d.expected} — sweep landed, tighten the allowlist`)
        .join("\n")
      throw new Error(
        `Phase 7.7 B allowlist drift — ${drifted.length} file(s) have fewer console.* calls than declared.\n` +
          `Update CURRENTLY_ALLOWED_WITH_CONSOLE to match (or remove the entry if count is now 0).\n\n` +
          detail,
      )
    }
  })

  it("the structured-logger source itself exists at the expected path", () => {
    // Anchors the rest of the suite — confirms the foundation module shipped.
    const loggerPath = path.join(
      repoRoot,
      "packages/shared/src/observability/structured-logger.ts",
    )
    expect(fs.existsSync(loggerPath)).toBe(true)
    const content = fs.readFileSync(loggerPath, "utf8")
    expect(content).toMatch(/export function createLogger/)
  })
})
