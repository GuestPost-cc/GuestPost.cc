import { spawn } from "node:child_process"
import { loadDevelopmentEnv } from "./env"

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

function run(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: "inherit",
    })

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `pnpm ${args.join(" ")} stopped with ${
            signal ? `signal ${signal}` : `exit code ${code ?? 1}`
          }`,
        ),
      )
    })
  })
}

async function main(): Promise<void> {
  loadDevelopmentEnv({ required: ["NEXT_PUBLIC_API_URL"] })
  console.log("Loaded .env.development for the local development workflow")

  await run(["services:up"])
  await run(["clean:next-dev"])
  // `next build` is intentionally production-mode even though this workflow
  // launches development servers afterward. Keep the local API origin in the
  // environment, but do not pass NODE_ENV=development into the build: Next.js
  // treats that as a non-standard mode and can produce inconsistent bundles.
  // Force-refresh ignored workspace dist/ outputs. They are not versioned and
  // can otherwise survive a branch switch with declarations from another
  // commit, which makes Next resolve stale package APIs during its build.
  await run(["exec", "turbo", "build", "--force"], {
    ...process.env,
    NODE_ENV: "production",
  })
  await run(["db:migrations:status"])
  await run(["clean:next-dev"])
  await run([
    "exec",
    "concurrently",
    "--names",
    "api,worker,site,portal,pub,admin",
    "--prefix-colors",
    "blue,green,yellow,magenta,cyan,red",
    "cd apps/api && NODE_ENV=development node dist/main.js",
    "cd apps/worker && NODE_ENV=development node dist/index.js",
    "cd apps/website && npx next dev --port 3000",
    "cd apps/portal && npx next dev --port 3001",
    "cd apps/publisher && npx next dev --port 3002",
    "cd apps/admin && npx next dev --port 3003",
  ])
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
