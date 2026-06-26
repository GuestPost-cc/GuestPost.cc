import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import process from "node:process"

interface Check {
  name: string
  ok: boolean
  message: string
}

interface Section {
  title: string
  checks: Check[]
}

const ROOT = join(__dirname, "..")

// ─── System checks ───────────────────────────────────────────────────────────

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
    return { name, ok: false, message: "Not found" }
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
    return { name: "pnpm", ok: false, message: "Not found" }
  }
}

function checkMemory(): Check {
  const total = require("node:os").totalmem() / 1024 / 1024 / 1024
  return {
    name: "Memory",
    ok: total >= 4,
    message: `${total.toFixed(1)} GB total`,
  }
}

// ─── Environment checks ───────────────────────────────────────────────────────

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {}
  try {
    const content = readFileSync(path, "utf8")
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      const val = trimmed.slice(eq + 1)
      if (key) vars[key] = val
    }
  } catch {
    // file not found — skip
  }
  return vars
}

const REQUIRED = new Set(["DATABASE_URL", "REDIS_URL", "JWT_SECRET"])
const RECOMMENDED = new Set([
  "QUEUE_SIGNING_SECRET",
  "NEXT_PUBLIC_API_URL",
  "CORS_ORIGIN",
  "BETTER_AUTH_URL",
  "STRIPE_SECRET_KEY",
])

function loadEnv(): Record<string, string> {
  // Priority: .env > .env.development
  const envPath = join(ROOT, ".env")
  const devEnvPath = join(ROOT, ".env.development")
  if (existsSync(envPath)) return parseEnvFile(envPath)
  return parseEnvFile(devEnvPath)
}

function checkEnvironment(env: Record<string, string>): Section {
  const examplePath = join(ROOT, ".env.example")
  const example = parseEnvFile(examplePath)
  const envPath = join(ROOT, ".env")
  const hasDotEnv = existsSync(envPath)

  const checks: Check[] = []

  for (const [key, defaultValue] of Object.entries(example)) {
    const isSet = key in env && env[key] !== ""

    if (REQUIRED.has(key)) {
      if (!isSet && !defaultValue) {
        checks.push({
          name: key,
          ok: false,
          message: "Missing — application cannot start",
        })
      } else if (!isSet && defaultValue) {
        checks.push({ name: key, ok: true, message: "Using default" })
      } else {
        checks.push({ name: key, ok: true, message: "Present" })
      }
    } else if (RECOMMENDED.has(key)) {
      if (!isSet && !defaultValue) {
        checks.push({
          name: key,
          ok: false,
          message: "Missing — feature degraded",
        })
      } else if (!isSet && defaultValue) {
        checks.push({ name: key, ok: true, message: "Using default" })
      } else {
        checks.push({ name: key, ok: true, message: "Present" })
      }
    }
    // Optional vars — silently omitted
  }

  // Detect drift: keys in .env not in .env.example
  if (hasDotEnv) {
    const userEnv = parseEnvFile(envPath)
    const driftKeys = Object.keys(userEnv).filter((k) => !(k in example) && k)
    if (driftKeys.length > 0) {
      checks.push({
        name: "Unexpected env vars",
        ok: true,
        message: `${driftKeys.length} key(s) in .env not in .env.example`,
      })
    }
  }

  return { title: "Environment", checks }
}

// ─── Service checks ───────────────────────────────────────────────────────────

function probeTCP(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host)
    socket.setTimeout(timeoutMs)
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => {
      socket.destroy()
      resolve(false)
    })
    socket.on("timeout", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function parsePostgresURL(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url)
    return { host: u.hostname, port: parseInt(u.port || "5432", 10) }
  } catch {
    return null
  }
}

function parseRedisURL(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url)
    return { host: u.hostname, port: parseInt(u.port || "6379", 10) }
  } catch {
    return null
  }
}

function parseMinIOEndpoint(
  endpoint: string,
): { host: string; port: number } | null {
  const parts = endpoint.split(":")
  if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) }
  }
  return { host: endpoint, port: 9000 }
}

async function checkServices(env: Record<string, string>): Promise<Section> {
  const checks: Check[] = []

  // PostgreSQL
  const pgUrl = env.DATABASE_URL || ""
  const pgParsed = parsePostgresURL(pgUrl)
  if (pgParsed) {
    const ok = await probeTCP(pgParsed.host, pgParsed.port)
    checks.push({
      name: "PostgreSQL",
      ok,
      message: ok ? `${pgParsed.host}:${pgParsed.port}` : "Unreachable",
    })
  } else {
    checks.push({
      name: "PostgreSQL",
      ok: false,
      message: "DATABASE_URL not set",
    })
  }

  // Redis
  const redisUrl = env.REDIS_URL || ""
  const redisParsed = parseRedisURL(redisUrl)
  if (redisParsed) {
    const ok = await probeTCP(redisParsed.host, redisParsed.port)
    checks.push({
      name: "Redis",
      ok,
      message: ok ? `${redisParsed.host}:${redisParsed.port}` : "Unreachable",
    })
  } else {
    checks.push({ name: "Redis", ok: false, message: "REDIS_URL not set" })
  }

  // MinIO
  const minioEndpoint = env.MINIO_ENDPOINT || ""
  const minioParsed = parseMinIOEndpoint(minioEndpoint)
  if (minioParsed) {
    const ok = await probeTCP(minioParsed.host, minioParsed.port)
    checks.push({
      name: "MinIO",
      ok,
      message: ok ? `${minioParsed.host}:${minioParsed.port}` : "Unreachable",
    })
  } else {
    checks.push({ name: "MinIO", ok: false, message: "MINIO_ENDPOINT not set" })
  }

  // Mailpit (SMTP)
  const smtpHost = env.SMTP_HOST || ""
  const smtpPort = parseInt(env.SMTP_PORT || "1025", 10)
  if (smtpHost && smtpPort) {
    const ok = await probeTCP(smtpHost, smtpPort)
    checks.push({
      name: "Mailpit",
      ok,
      message: ok ? `${smtpHost}:${smtpPort}` : "Unreachable",
    })
  } else {
    checks.push({
      name: "Mailpit",
      ok: false,
      message: "SMTP_HOST/SMTP_PORT not set",
    })
  }

  return { title: "Services", checks }
}

// ─── Workspace checks ─────────────────────────────────────────────────────────

function checkWorkspace(): Section {
  const checks: Check[] = [
    {
      name: "node_modules",
      ok: existsSync(join(ROOT, "node_modules")),
      message: existsSync(join(ROOT, "node_modules"))
        ? "Present"
        : "Missing — run pnpm install",
    },
    {
      name: "Prisma client",
      ok: existsSync(join(ROOT, "packages/database/src/prisma/client.ts")),
      message: existsSync(join(ROOT, "packages/database/src/prisma/client.ts"))
        ? "Generated"
        : "Missing — run pnpm --filter @guestpost/database exec prisma generate",
    },
  ]

  // Validate pnpm workspace resolution
  try {
    execSync("pnpm ls --depth=0 -r", { encoding: "utf8", stdio: "pipe" })
    checks.push({ name: "pnpm workspace", ok: true, message: "Valid" })
  } catch {
    checks.push({
      name: "pnpm workspace",
      ok: false,
      message: "Workspace resolution failed",
    })
  }

  return { title: "Workspace", checks }
}

// ─── Repository health check ───────────────────────────────────────────────────

function checkRepository(): Section {
  const checks: Check[] = []

  try {
    execSync(
      "pnpm depcruise apps packages scripts e2e --include-only '^(apps|packages|scripts|e2e)/'",
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    )
    checks.push({
      name: "repo:health",
      ok: true,
      message: "Dependency graph valid",
    })
  } catch {
    checks.push({
      name: "repo:health",
      ok: false,
      message: "Dependency violations found",
    })
  }

  return { title: "Repository", checks }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printSection(section: Section): number {
  if (section.checks.length === 0) return 0

  console.log(`\n${section.title}`)
  let failures = 0
  for (const c of section.checks) {
    const icon = c.ok
      ? "  \u001B[32m\u2713\u001B[0m"
      : "  \u001B[31m\u2717\u001B[0m"
    console.log(`${icon} ${c.name.padEnd(28)} ${c.message}`)
    if (!c.ok) failures++
  }
  return failures
}

async function main() {
  const env = loadEnv()

  const sections: (Section | Promise<Section>)[] = [
    {
      title: "System",
      checks: [
        checkNodeVersion(),
        checkPnpmVersion(),
        checkCommand("Git", "git"),
        checkCommand("Docker", "docker"),
        checkMemory(),
      ],
    },
    checkEnvironment(env),
    checkServices(env),
    checkWorkspace(),
    checkRepository(),
  ]

  console.log("GuestPost — Development Environment Check")

  let totalFailures = 0
  for (const section of sections) {
    const resolved = await section
    totalFailures += printSection(resolved)
  }

  console.log()
  if (totalFailures > 0) {
    console.log(
      `\u001B[31m\u2717 ${totalFailures} check(s) failed.\u001B[0m See above for details.`,
    )
    process.exit(1)
  }
  console.log(
    "\u001B[32m\u2713 All checks passed. Your environment is ready.\u001B[0m",
  )
}

main().catch((err) => {
  console.error("Doctor check failed:", err)
  process.exit(1)
})
