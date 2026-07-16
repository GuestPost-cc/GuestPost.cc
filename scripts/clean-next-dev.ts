import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const appsDir = join(__dirname, "..", "apps")
const devOutputDirs = readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(appsDir, entry.name, ".next", "dev"))
  .filter(existsSync)

for (const dir of devOutputDirs) {
  rmSync(dir, { recursive: true, force: true })
  console.log(`Removed stale Next.js development output: ${dir}`)
}

if (devOutputDirs.length === 0) {
  console.log("No stale Next.js development output found.")
}
