import { defineConfig } from "@playwright/test"

// E2E journeys against the locally running stack (pnpm dev:all or built
// apps). Specs create their own throwaway accounts — no seed-data coupling.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_PORTAL_URL ?? "http://localhost:3001",
    trace: "retain-on-failure",
  },
})
