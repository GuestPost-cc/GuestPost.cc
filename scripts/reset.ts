import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { $ } from "./_utils"
import { loadRootEnv } from "./env"

const ROOT = join(__dirname, "..")

async function main() {
  console.log("Resetting GuestPost development environment...\n")
  loadRootEnv({
    createDevelopmentFromExample: true,
    required: ["DATABASE_URL"],
  })

  // Step 1: Clean node_modules
  console.log("1. Removing node_modules...")
  const dirs = ["node_modules", ".turbo"]
  for (const dir of dirs) {
    const p = join(ROOT, dir)
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true })
      console.log(`   Removed: ${dir}`)
    }
  }

  // Step 2: Clean build artifacts
  console.log("\n2. Removing build artifacts...")
  const buildDirs = [
    "apps/*/.next",
    "apps/*/dist",
    "packages/*/dist",
    "apps/*/.turbo",
    "packages/*/.turbo",
  ]
  for (const pattern of buildDirs) {
    const [base, rest] = pattern.split("/*/", 2)
    const dir = join(ROOT, base)
    if (existsSync(dir)) {
      const entries = require("node:fs").readdirSync(dir, {
        withFileTypes: true,
      })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const target = join(dir, entry.name, rest || "")
          if (existsSync(target)) {
            rmSync(target, { recursive: true, force: true })
            console.log(`   Removed: ${base}/${entry.name}/${rest}`)
          }
        }
      }
    }
  }

  // Step 3: Fresh install
  console.log("\n3. Installing dependencies...")
  await $("pnpm", ["install"])

  // Step 4: Build shared packages
  console.log("\n4. Building shared packages...")
  await $("pnpm", [
    "run",
    "build",
    "--filter=@guestpost/shared",
    "--filter=@guestpost/database",
    "--filter=@guestpost/auth",
    "--filter=@guestpost/ui",
    "--filter=@guestpost/api-client",
  ])

  // Step 5: Fresh DB
  console.log("\n5. Resetting database...")
  await $("pnpm", ["services:down"])
  await $("pnpm", ["services:up"])
  // Wait for DB to be ready
  await new Promise((r) => setTimeout(r, 5000))
  await $("pnpm", [
    "--filter",
    "@guestpost/database",
    "exec",
    "prisma",
    "migrate",
    "deploy",
  ])
  await $("pnpm", [
    "--filter",
    "@guestpost/database",
    "exec",
    "prisma",
    "db",
    "seed",
  ])

  console.log(
    "\n✅ Reset complete. Run `pnpm dev:all` to start development servers.",
  )
}

main().catch((err) => {
  console.error("Reset failed:", err)
  process.exit(1)
})
