import { copyFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..")

export interface LoadRootEnvOptions {
  createDevelopmentFromExample?: boolean
  required?: string[]
}

export interface LoadRootEnvResult {
  createdDevelopmentEnv: boolean
  loadedFiles: string[]
}

function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {}

  if (!existsSync(path)) return vars

  const content = readFileSync(path, "utf8")
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const eq = trimmed.indexOf("=")
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    if (!key) continue

    let value = trimmed.slice(eq + 1).trim()

    // Strip inline # comments (dotenv-compatible behavior)
    // Don't strip # inside quoted values
    const quoteChar = value.startsWith('"')
      ? '"'
      : value.startsWith("'")
        ? "'"
        : null

    if (quoteChar) {
      // Strip surrounding quotes but keep internal content
      const endQuote = value.lastIndexOf(quoteChar)
      if (endQuote > 0) {
        value = value.slice(1, endQuote)
      } else {
        value = value.slice(1)
      }
    } else {
      // Unquoted: strip inline comment (first unescaped #)
      // dotenv doesn't handle escaped #, so we don't need to either
      const commentIndex = value.indexOf("#")
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trimEnd()
      }
    }

    vars[key] = value
  }

  return vars
}

export function loadRootEnv(
  options: LoadRootEnvOptions = {},
): LoadRootEnvResult {
  const envPath = join(ROOT, ".env")
  const developmentEnvPath = join(ROOT, ".env.development")
  const exampleEnvPath = join(ROOT, ".env.example")

  let createdDevelopmentEnv = false
  if (
    options.createDevelopmentFromExample &&
    !existsSync(envPath) &&
    !existsSync(developmentEnvPath) &&
    existsSync(exampleEnvPath)
  ) {
    copyFileSync(exampleEnvPath, developmentEnvPath)
    createdDevelopmentEnv = true
    console.log("Created .env.development from .env.example")
  }

  const developmentEnv = parseEnvFile(developmentEnvPath)
  const localEnv = parseEnvFile(envPath)
  const merged = { ...developmentEnv, ...localEnv }

  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }

  const missing = (options.required ?? []).filter(
    (key) => !process.env[key] || process.env[key]?.trim() === "",
  )
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(
        ", ",
      )}. Create .env.development from .env.example and fill the missing value(s), or export them before running this command.`,
    )
  }

  const loadedFiles = [
    existsSync(developmentEnvPath) ? ".env.development" : null,
    existsSync(envPath) ? ".env" : null,
  ].filter((file): file is string => file !== null)

  return { createdDevelopmentEnv, loadedFiles }
}
