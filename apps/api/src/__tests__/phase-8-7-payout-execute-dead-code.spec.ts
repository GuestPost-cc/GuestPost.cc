// Phase 8.7 — payout-execute dead-code regression guard (audit #38).
//
// PRINCIPLE: the worker's payout queue accepts exactly 2 job names —
// payout-check-status (repeatable poller) and payout-webhook (provider
// callbacks). The legacy "payout-execute" name is dead and must stay dead.
//
// Why this spec exists: handleExecute was a stub from day one
// (commit 145bd89, 2026-06-11) that returned { queued: true } without
// actually moving money. Phase 8.7 deleted the handler, the switch arm,
// and the QUEUE_JOBS.PAYOUT.EXECUTE constant. If anyone reintroduces the
// dead string OR the dead function OR the dead key, this spec fails
// loudly — both via negative assertions (no dead string anywhere) AND
// positive assertions (the supported set is exactly { WEBHOOK, CHECK_STATUS }).
//
// If the worker-side payout execution architecture is ever genuinely
// needed, deleting this spec must be a deliberate decision documented in
// the reintroduction PR — not an accidental side effect of "the test was
// failing so I removed it."

import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const SELF_FILENAME = "apps/api/src/__tests__/phase-8-7-payout-execute-dead-code.spec.ts"

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8")
}

function gitGrep(pattern: string, paths: string[]): string[] {
  // -F: fixed-string match; -n: line numbers; -- ends options.
  // Returns "" exit code 0 when matches found, exit code 1 when none.
  try {
    const out = execSync(
      `git -C ${repoRoot} grep -nF '${pattern}' -- ${paths.map((p) => `'${p}'`).join(" ")}`,
      { encoding: "utf8" },
    )
    return out.split("\n").filter((line) => line.length > 0)
  } catch (err: any) {
    // git grep returns exit 1 when zero matches — not an error.
    if (err.status === 1) return []
    throw err
  }
}

describe("Phase 8.7 — payout-execute dead-code regression guard (audit #38)", () => {
  // ─── Negative assertions: the dead string + structure cannot reappear ───

  it("no production code uses the literal 'payout-execute' (only this spec self-references)", () => {
    const hits = gitGrep('"payout-execute"', ["apps/", "packages/", "scripts/"])
    const offenders = hits.filter((line) => !line.startsWith(`${SELF_FILENAME}:`))
    if (offenders.length > 0) {
      throw new Error(
        `Phase 8.7 regression — found '"payout-execute"' outside this spec:\n${offenders.join("\n")}\n` +
          `The payout-execute handler was deleted (audit #38). If you need a worker-side ` +
          `payout execution path, design it deliberately — don't resurrect the dead stub.`,
      )
    }
  })

  it("payout.processor.ts no longer defines handleExecute", () => {
    const src = readRepoFile("apps/worker/src/processors/payout.processor.ts")
    expect(src).not.toMatch(/function\s+handleExecute\b/)
    expect(src).not.toMatch(/\bhandleExecute\s*\(/)
  })

  it("packages/shared/src/queues.ts no longer defines EXECUTE: \"payout-execute\"", () => {
    const src = readRepoFile("packages/shared/src/queues.ts")
    expect(src).not.toMatch(/EXECUTE:\s*"payout-execute"/)
  })

  it("payout.processor.ts switch no longer contains a payout-execute case arm", () => {
    const src = readRepoFile("apps/worker/src/processors/payout.processor.ts")
    expect(src).not.toMatch(/case\s+"payout-execute"\s*:/)
  })

  // ─── Positive assertions: lock in the surviving 2-arm shape ───

  it("payout.processor.ts switch covers exactly payout-webhook and payout-check-status", () => {
    const src = readRepoFile("apps/worker/src/processors/payout.processor.ts")
    expect(src).toMatch(/case\s+"payout-check-status"\s*:/)
    expect(src).toMatch(/case\s+"payout-webhook"\s*:/)
  })

  it("QUEUE_JOBS.PAYOUT exposes exactly { CHECK_STATUS, WEBHOOK } — no EXECUTE, no extras", () => {
    const keys = Object.keys(QUEUE_JOBS[QUEUES.PAYOUT]).sort()
    expect(keys).toEqual(["CHECK_STATUS", "WEBHOOK"])
  })

  it("QUEUE_JOBS.PAYOUT values map to the canonical job-name strings", () => {
    expect(QUEUE_JOBS[QUEUES.PAYOUT].CHECK_STATUS).toBe("payout-check-status")
    expect(QUEUE_JOBS[QUEUES.PAYOUT].WEBHOOK).toBe("payout-webhook")
  })
})
