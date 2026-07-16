import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("settlement worker queue routing", () => {
  const repoRoot = resolve(__dirname, "..", "..", "..", "..")

  it("runs auto-approve and auto-release workers on different queues", () => {
    const approveProcessor = readFileSync(
      resolve(
        repoRoot,
        "apps/worker/src/processors/settlement-auto-approve.processor.ts",
      ),
      "utf8",
    )
    const releaseProcessor = readFileSync(
      resolve(
        repoRoot,
        "apps/worker/src/processors/settlement-release.processor.ts",
      ),
      "utf8",
    )

    expect(approveProcessor).toContain("QUEUES.SETTLEMENT,")
    expect(releaseProcessor).toContain("QUEUES.SETTLEMENT_RELEASE,")
  })

  it("removes legacy auto-release repeatables from the shared queue", () => {
    const workerIndex = readFileSync(
      resolve(repoRoot, "apps/worker/src/index.ts"),
      "utf8",
    )

    expect(workerIndex).toMatch(
      /removeRepeatableJobsByName\(\s*QUEUES\.SETTLEMENT,\s*"settlement-auto-release"/,
    )
  })
})
