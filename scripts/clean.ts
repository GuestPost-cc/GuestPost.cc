import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..")

const dirs = [
  "node_modules",
  "apps/*/node_modules",
  "packages/*/node_modules",
  "apps/*/.next",
  "apps/*/dist",
  "packages/*/dist",
  ".turbo",
  "apps/*/.turbo",
  "packages/*/.turbo",
]

function expandGlob(pattern: string): string[] {
  if (pattern.includes("*")) {
    const [base, rest] = pattern.split("/*/", 2)
    const dir = join(ROOT, base)
    if (!existsSync(dir)) return []
    const entries = require("node:fs").readdirSync(dir, { withFileTypes: true })
    return entries
      .filter((e: { isDirectory: () => unknown }) => e.isDirectory())
      .map((e: { name: string }) => join(dir, e.name, rest || ""))
  }
  return [join(ROOT, pattern)]
}

function clean() {
  console.log("Cleaning build artifacts...\n")

  let total = 0
  for (const pattern of dirs) {
    const paths = expandGlob(pattern)
    for (const p of paths) {
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true })
        console.log(`  Removed: ${p.replace(ROOT, ".")}`)
        total++
      }
    }
  }

  if (total === 0) {
    console.log("  Nothing to clean.")
  } else {
    console.log(`\n  Removed ${total} directory/directories.`)
  }
}

clean()
