import { defineConfig, devices } from "@playwright/test"

const isCI = Boolean(process.env.CI)
const apiOrigin = "http://localhost:4000"
const customerOrigin = "http://localhost:3001"
const publisherOrigin = "http://localhost:3002"

// Browser tests deliberately target fixed loopback origins. They create real
// accounts, so accepting an arbitrary E2E_* URL here could mutate staging or
// production by mistake.
export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/playwright",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: [
    [isCI ? "line" : "list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      name: "api",
      command: isCI
        ? "NODE_ENV=test FINANCE_RUNTIME_MODE=locked pnpm --filter @guestpost/api start"
        : "pnpm --filter @guestpost/api dev",
      url: `${apiOrigin}/api/v1/health/ready`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "pipe",
    },
    {
      name: "customer-portal",
      command: isCI
        ? "NODE_ENV=production pnpm --filter @guestpost/portal start"
        : "pnpm --filter @guestpost/portal dev",
      url: `${customerOrigin}/signup`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "pipe",
    },
    {
      name: "publisher-portal",
      command: isCI
        ? "NODE_ENV=production pnpm --filter @guestpost/publisher start"
        : "pnpm --filter @guestpost/publisher dev",
      url: `${publisherOrigin}/signup`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "pipe",
    },
  ],
  projects: [
    {
      name: "customer-portal",
      testMatch: /customer-onboarding\.spec\.ts/,
      use: { baseURL: customerOrigin },
    },
    {
      name: "publisher-portal",
      testMatch: /publisher-onboarding\.spec\.ts/,
      use: { baseURL: publisherOrigin },
    },
  ],
})
