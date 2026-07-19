import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"

const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8")

test("integration workers are loaded only by lanes that consume their queues", () => {
  const imports = source.slice(0, source.indexOf("const REALTIME_WORKERS"))
  assert.doesNotMatch(imports, /@guestpost\/integrations\/workers/)

  const loader = source.slice(
    source.indexOf("async function createIntegrationWorkers"),
    source.indexOf("const ON_DEMAND_QUEUES"),
  )
  assert.match(loader, /await import\(\s*"@guestpost\/integrations\/workers"/)

  const onDemand = source.slice(
    source.indexOf('if (mode === "on-demand")'),
    source.indexOf("const taskName = process.env.WORKER_TASK"),
  )
  assert.match(onDemand, /await createIntegrationWorkers\(\)/)

  const scheduled = source.slice(
    source.indexOf("const taskName = process.env.WORKER_TASK"),
    source.indexOf("bootstrap().catch"),
  )
  assert.doesNotMatch(scheduled, /createIntegrationWorkers/)
})
