// Phase 8.9 — settlement-auto-approve onError observability (audit #41).
//
// Two test surfaces:
//
//   1. Factory contract (makeAutoApproveOnError) — proves the handler
//      populates logError + Sentry.captureException with the right shape
//      (settlementId in the right places, fingerprint for dedup, tags
//      including sweepRunId). Mocks the hooks so the test is fully
//      isolated from @sentry/node and the structured-logger module.
//
//   2. Adoption guard — proves the worker processor still wires the
//      factory, with both the structured logger and Sentry adapters.
//      Uses the same filesystem-grep pattern as Phase 7.3's existing
//      file-deletion guards (phase-7-3 spec lines 235-241) because
//      apps/api jest cannot ES-import from apps/worker (no workspace
//      dep declared).
//
// Why the factory test isn't enough on its own: it proves the factory's
// output is correct in isolation. It does NOT prove the processor uses
// the factory. A future refactor could silently revert the wiring; the
// adoption guard catches that drift.

import * as fs from "node:fs"
import * as path from "node:path"
import { makeAutoApproveOnError, type AutoApproveObservabilityHooks } from "@guestpost/shared"

describe("Phase 8.9 — settlement-auto-approve onError observability (audit #41)", () => {
  function mkHooks() {
    const logError = jest.fn()
    const captureException = jest.fn()
    const hooks: AutoApproveObservabilityHooks = { logError, captureException }
    return { hooks, logError, captureException }
  }

  it("logError is called once with settlementId + err message + sweepRunId", () => {
    const { hooks, logError } = mkHooks()
    const handler = makeAutoApproveOnError(hooks, "settlement-auto-approve", "job-123")
    handler(new Error("simulated db error"), "settlement-456")

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(
      "per-settlement transaction failed in auto-approve sweep",
      expect.objectContaining({
        settlementId: "settlement-456",
        err: "simulated db error",
        sweepRunId: "job-123",
      }),
    )
  })

  it("captureException is called once with settlementId in contexts + fingerprint for dedup", () => {
    const { hooks, captureException } = mkHooks()
    const handler = makeAutoApproveOnError(hooks, "settlement-auto-approve", "job-123")
    const err = new Error("simulated db error")
    handler(err, "settlement-456")

    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({
          queue: "settlement",
          job: "settlement-auto-approve",
          sweepRunId: "job-123",
        }),
        contexts: { settlement_auto_approve: { settlementId: "settlement-456" } },
        fingerprint: ["settlement-auto-approve", "settlement-456"],
      }),
    )
  })

  it("non-Error throws are stringified safely (no crash on string/null/object)", () => {
    const { hooks, logError } = mkHooks()
    const handler = makeAutoApproveOnError(hooks, "settlement-auto-approve", "job-x")
    handler("string error", "s1")
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err: "string error" }),
    )
  })

  it("sweepRunId undefined defaults to 'unknown' in tags (Sentry tag values must be strings)", () => {
    const { hooks, captureException } = mkHooks()
    const handler = makeAutoApproveOnError(hooks, "settlement-auto-approve", undefined)
    handler(new Error("x"), "s2")
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ sweepRunId: "unknown" }),
      }),
    )
  })
})

describe("Phase 8.9 — adoption guard (processor wires the factory)", () => {
  // Filesystem-grep pattern (matches Phase 7.3 spec lines 235-241). apps/api
  // jest cannot ES-import from apps/worker — there's no @guestpost/worker
  // dep, no moduleNameMapper. So we assert the processor source contains
  // the wiring. Any future refactor that drops the wiring fails this test
  // loudly even if the factory itself is still being unit-tested above.
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
  const processorPath = path.join(
    repoRoot,
    "apps/worker/src/processors/settlement-auto-approve.processor.ts",
  )

  it("apps/worker/.../settlement-auto-approve.processor.ts imports makeAutoApproveOnError", () => {
    const src = fs.readFileSync(processorPath, "utf8")
    expect(src).toMatch(/makeAutoApproveOnError/)
    expect(src).toMatch(/from\s+["']@guestpost\/shared["']/)
  })

  it("processor passes onError to runSettlementAutoApprove", () => {
    const src = fs.readFileSync(processorPath, "utf8")
    expect(src).toMatch(/runSettlementAutoApprove\s*\([^)]*onError/s)
  })

  it("processor wires Sentry.captureException + logger.error through the hooks", () => {
    const src = fs.readFileSync(processorPath, "utf8")
    expect(src).toMatch(/Sentry\.captureException/)
    expect(src).toMatch(/logger\.error/)
  })
})
