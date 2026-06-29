/**
 * Phase 7.8 #27 — drift guard for the repeatable-job registry.
 *
 * Lives in apps/api/src/__tests__ (which has jest infra) rather than
 * apps/worker (which doesn't), since the assertion is pure file-system
 * inspection — no worker imports needed.
 *
 * Asserts BOTH directions of the registry/index.ts coupling:
 *   1. Every name in REPEATABLE_JOB_NAMES matches a `repeat:`
 *      registration in apps/worker/src/index.ts. Catches stale entries.
 *   2. Every `repeat:` registration in apps/worker/src/index.ts has its
 *      job name (first arg to queue.add) listed in
 *      REPEATABLE_JOB_NAMES. Catches new repeatables added without
 *      updating the registry.
 *
 * If you add a new repeatable cron in worker/index.ts but forget to
 * update the registry (or vice versa), this test fails CI with the
 * specific missing name in the diff between the two sets.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const WORKER_INDEX_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "worker",
  "src",
  "index.ts",
)
const REGISTRY_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "worker",
  "src",
  "repeatable-job-registry.ts",
)

function extractRegistryNames(): Set<string> {
  const src = readFileSync(REGISTRY_PATH, "utf8")
  // Match the JOB_NAMES array literal directly.
  const jobNamesBlockMatch = src.match(
    /const\s+JOB_NAMES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
  )
  if (!jobNamesBlockMatch)
    throw new new Error("Could not locate JOB_NAMES array in registry file")()
  const namesRaw = jobNamesBlockMatch[1]
  const names = [...namesRaw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
  return new Set(names)
}

function extractWorkerRepeatables(): Set<string> {
  const src = readFileSync(WORKER_INDEX_PATH, "utf8")
  // Find every queue.add("<name>", ..., { ...repeat:... }) call.
  // Strategy: locate every `repeat:` occurrence, then walk backward to
  // find the enclosing queue.add(...). The first string-literal arg
  // after queue.add( is the job name.
  const names = new Set<string>()
  const repeatRe = /repeat\s*:/g
  let match: RegExpExecArray | null
  while ((match = repeatRe.exec(src)) !== null) {
    // Look back ~600 chars for the most recent queue.add(
    const lookback = src.slice(Math.max(0, match.index - 600), match.index)
    const addStart = lookback.lastIndexOf("queue.add(")
    if (addStart === -1) continue
    const afterAdd = lookback.slice(addStart + "queue.add(".length)
    const nameMatch = afterAdd.match(/^\s*["']([^"']+)["']/)
    if (nameMatch) names.add(nameMatch[1])
  }
  return names
}

describe("Phase 7.8 #27 — repeatable-job-registry drift guard", () => {
  it("extracts a non-empty registry set (sanity)", () => {
    expect(extractRegistryNames().size).toBeGreaterThan(0)
  })

  it("extracts a non-empty worker repeatable set (sanity)", () => {
    expect(extractWorkerRepeatables().size).toBeGreaterThan(0)
  })

  it("REPEATABLE_JOB_NAMES == every `repeat:` registration in worker/index.ts (both directions)", () => {
    const registry = extractRegistryNames()
    const worker = extractWorkerRepeatables()
    // Stale registry entries: names in registry but not in worker.
    const inRegistryMissingInWorker = [...registry].filter(
      (n) => !worker.has(n),
    )
    // Missing registry entries: repeatables in worker but not in registry.
    const inWorkerMissingInRegistry = [...worker].filter(
      (n) => !registry.has(n),
    )

    if (
      inRegistryMissingInWorker.length > 0 ||
      inWorkerMissingInRegistry.length > 0
    ) {
      const msg = [
        `Registry drift detected.`,
        `In REPEATABLE_JOB_NAMES but NOT in worker/index.ts: ${JSON.stringify(inRegistryMissingInWorker)}`,
        `In worker/index.ts but NOT in REPEATABLE_JOB_NAMES: ${JSON.stringify(inWorkerMissingInRegistry)}`,
      ].join("\n")
      throw new Error(msg)
    }

    expect(registry).toEqual(worker)
  })
})
