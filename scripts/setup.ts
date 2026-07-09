import { $ } from "./_utils"
import { loadRootEnv } from "./env"

async function main() {
  console.log("Setting up GuestPost development environment...")
  loadRootEnv({
    createDevelopmentFromExample: true,
    required: ["DATABASE_URL"],
  })

  console.log("\n1. Installing dependencies...")
  await $("pnpm", ["install"])

  console.log("\n2. Generating Prisma client...")
  await $("pnpm", [
    "--filter",
    "@guestpost/database",
    "exec",
    "prisma",
    "generate",
  ])

  console.log("\n3. Building shared packages...")
  await $("pnpm", [
    "run",
    "build",
    "--filter=@guestpost/shared",
    "--filter=@guestpost/database",
    "--filter=@guestpost/auth",
    "--filter=@guestpost/ui",
    "--filter=@guestpost/api-client",
  ])

  console.log("\n4. Running database migrations...")
  await $("pnpm", [
    "--filter",
    "@guestpost/database",
    "exec",
    "prisma",
    "migrate",
    "deploy",
  ])

  console.log("\n5. TypeScript check...")
  await $("pnpm", ["typecheck"])

  console.log("\n6. Format and lint check...")
  await $("pnpm", ["lint:format"])
  await $("pnpm", ["lint"])

  console.log(
    "\n✅ Setup complete. Run `pnpm dev:all` to start the development servers.",
  )
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
