import { $ } from "./_utils"

async function main() {
  console.log("Verifying GuestPost development environment...\n")

  const steps: { name: string; cmd: string; args: string[] }[] = [
    { name: "Biome check", cmd: "pnpm", args: ["lint:format"] },
    { name: "ESLint", cmd: "pnpm", args: ["lint"] },
    { name: "TypeScript", cmd: "pnpm", args: ["typecheck"] },
    {
      name: "Dependency graph",
      cmd: "pnpm",
      args: [
        "depcruise",
        "apps",
        "packages",
        "scripts",
        "e2e",
        "--include-only",
        "^(apps|packages|scripts|e2e)/",
      ],
    },
  ]

  let failed = 0
  for (const step of steps) {
    process.stdout.write(`  ${step.name}... `.padEnd(30))
    try {
      await $(step.cmd, step.args, { stdio: "pipe" })
      console.log("✅")
    } catch {
      console.log("❌")
      failed++
    }
  }

  console.log(
    `\n${failed === 0 ? "✅ All checks passed." : `❌ ${failed} check(s) failed.`}`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("Verify failed:", err)
  process.exit(1)
})
