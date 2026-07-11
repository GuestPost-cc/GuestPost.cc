// Worker environment prelude.
//
// This file MUST be the very first import in index.ts. ES module evaluation
// processes imports depth-first: all of load-env.ts top-level code runs
// before index.ts other imports execute. Without this separation, the
// dotenv config() call was hoisted AFTER the import { prisma } from
// "@guestpost/database" line, causing createPrismaClient() to throw
// "DATABASE_URL is required" at module-load before process.env was populated.
//
// Behavior:
//   - NODE_ENV=development: loads .env.development via dotenv
//   - Any other NODE_ENV: no-op; validateEnv() in lib/env.ts handles
//     the missing-var exit(1)

import { resolve } from "node:path"
import { config } from "dotenv"

if (process.env.NODE_ENV === "development") {
  config({
    path: resolve(__dirname, "../../../.env.development"),
  })
}
