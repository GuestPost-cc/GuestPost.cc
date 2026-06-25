import { execSync } from "node:child_process"
import process from "node:process"

interface Check {
  name: string
  ok: boolean
  message: string
}

function checkCommand(
  name: string,
  cmd: string,
  versionArg = "--version",
): Check {
  try {
    const out = execSync(`${cmd} ${versionArg}`, {
      encoding: "utf8",
      stdio: "pipe",
    })
    const version = out.trim().split("\n")[0]
    return { name, ok: true, message: version }
  } catch {
    return { name, ok: false, message: "Not found!" }
  }
}

function checkNodeVersion(): Check {
  const v = process.version.slice(1)
  const major = parseInt(v.split(".")[0], 10)
  return {
    name: "Node.js",
    ok: major >= 18,
    message: major >= 18 ? v : `${v} — need 18+`,
  }
}

function checkPnpmVersion(): Check {
  try {
    const v = execSync("pnpm --version", { encoding: "utf8" }).trim()
    const major = parseInt(v.split(".")[0], 10)
    return {
      name: "pnpm",
      ok: major >= 8,
      message: major >= 8 ? v : `${v} — need 8+`,
    }
  } catch {
    return { name: "pnpm", ok: false, message: "Not found!" }
  }
}

function checkMemory(): Check {
  const mem = process.memoryUsage().heapTotal / 1024 / 1024
  const total = require("node:os").totalmem() / 1024 / 1024 / 1024
  return {
    name: "Memory",
    ok: total >= 4,
    message: `${total.toFixed(1)} GB total`,
  }
}

async function main() {
  const checks: Check[] = [
    checkNodeVersion(),
    checkPnpmVersion(),
    checkCommand("git", "git"),
    checkCommand("Docker", "docker"),
    checkCommand("pnpm", "pnpm"),
    checkCommand("node", "node"),
    checkMemory(),
  ]

  const fail = checks.filter((c) => !c.ok)
  const pass = checks.filter((c) => c.ok)

  console.log("\nGuestPost Development Environment Check\n")

  for (const c of checks) {
    const icon = c.ok ? "✅" : "❌"
    console.log(`  ${icon} ${c.name.padEnd(12)} ${c.message}`)
  }

  if (fail.length > 0) {
    console.log(
      `\n❌ ${fail.length} check(s) failed. Please fix the above issues.`,
    )
    process.exit(1)
  }

  console.log(`\n✅ All ${checks.length} checks passed.`)
}

main().catch((err) => {
  console.error("Doctor check failed:", err)
  process.exit(1)
})
