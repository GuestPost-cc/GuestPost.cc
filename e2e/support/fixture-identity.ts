import { createHash } from "node:crypto"
import type { TestInfo } from "@playwright/test"

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

function fixtureRunId(): string {
  const configured = process.env.E2E_RUN_ID?.trim()
  if (configured) {
    if (!RUN_ID_PATTERN.test(configured)) {
      throw new Error(
        "E2E_RUN_ID must be 1-32 lowercase letters, numbers, or hyphens",
      )
    }
    return configured
  }

  if (process.env.CI) {
    throw new Error("E2E_RUN_ID is required in CI")
  }

  // A process-scoped local fallback prevents repeated runs against the same
  // disposable development database from colliding. CI always supplies an
  // explicit, reproducible run ID.
  return `local-${process.pid}`
}

export function fixtureEmail(
  testInfo: TestInfo,
  accountType: "customer" | "publisher",
): string {
  const testScope = [
    testInfo.testId,
    testInfo.project.name,
    testInfo.parallelIndex,
    testInfo.repeatEachIndex,
  ].join(":")
  const testKey = createHash("sha256")
    .update(testScope)
    .digest("hex")
    .slice(0, 12)

  // Retry-specific identities ensure a retry is independent even if the
  // first attempt committed signup before failing later in the journey.
  return `e2e-${accountType}-${fixtureRunId()}-${testKey}-r${testInfo.retry}@test.local`
}
