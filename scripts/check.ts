/**
 * Comprehensive pre-commit / pre-PR check. Runs the full validation gate.
 *
 * Equivalent to: pnpm repo:check
 * But with clearer output and timing.
 */

import { $ } from "./_utils"

interface Step {
  name: string
  cmd: string
  args: string[]
}

const STEPS: Step[] = [
  {
    name: "Biome (format + lint + imports)",
    cmd: "pnpm",
    args: ["lint:format"],
  },
  { name: "ESLint (hooks + TS rules)", cmd: "pnpm", args: ["lint"] },
  { name: "TypeScript (tsc --noEmit)", cmd: "pnpm", args: ["typecheck"] },
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

async function main() {
  console.log("GuestPost — Pre-submit check\n")

  const results: { name: string; ok: boolean; ms: number }[] = []

  for (const step of STEPS) {
    process.stdout.write(`  ${step.name}... `.padEnd(50))
    const start = Date.now()
    try {
      await $(step.cmd, step.args, { stdio: "pipe" })
      const ms = Date.now() - start
      console.log(`✅ ${ms}ms`)
      results.push({ name: step.name, ok: true, ms })
    } catch {
      const ms = Date.now() - start
      console.log(`❌ ${ms}ms`)
      results.push({ name: step.name, ok: false, ms })
    }
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0)

  console.log()
  console.log(
    `  Results: ${passed}/${STEPS.length} passed, ${failed} failed, ${totalMs}ms total`,
  )
  console.log()

  if (failed > 0) {
    console.log("  ❌ Some checks failed. Fix the issues above and try again.")
    process.exit(1)
  }

  console.log("  ✅ All checks passed!")
}

main().catch((err) => {
  console.error("Check failed:", err)
  process.exit(1)
})
