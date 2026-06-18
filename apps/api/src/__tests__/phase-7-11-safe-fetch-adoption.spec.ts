/**
 * Phase 7.11 — adoption regression guard for the SSRF/DoS hardening
 * lift. Greps apps/worker/src/processors/*.ts for the forbidden
 * patterns that lived there before commit 2:
 *
 *   - function/const isSafePublicUrl     → must come from @guestpost/shared
 *   - PRIVATE_IP_PATTERNS = [...]        → must come from @guestpost/shared
 *   - await res.text() / response.text() → must use readBodyWithCap
 *
 * Same defense-in-depth class as Phase 7.7's structured-logger sweep
 * guard and Phase 7.9's shared-component-adoption guard. Catches a
 * future processor that copy-pastes the old vulnerable pattern.
 */
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

// apps/api/src/__tests__ → repo root → apps/worker/src/processors
const PROCESSORS_DIR = join(__dirname, "..", "..", "..", "..", "apps", "worker", "src", "processors")

// Each forbidden pattern is described as { name, regex, why }. The
// regex must use the multiline flag so line-by-line reporting is
// straightforward. `why` is shown in the failure message so a future
// reader knows what the rule protects.
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp; why: string }> = [
  {
    name: "local isSafePublicUrl declaration",
    regex: /^\s*(function|const)\s+isSafePublicUrl\b/gm,
    why: "Phase 7.11 lifted isSafePublicUrl to @guestpost/shared. Use `import { isSafePublicUrl } from \"@guestpost/shared\"`. The dispatcher-based safeFetch enforces DNS-rebinding protection that a local copy would miss (#14).",
  },
  {
    name: "local PRIVATE_IP_PATTERNS declaration",
    regex: /^\s*const\s+PRIVATE_IP_PATTERNS\s*=\s*\[/gm,
    why: "Phase 7.11 lifted PRIVATE_IP_PATTERNS to @guestpost/shared. Use `import { PRIVATE_IP_PATTERNS } from \"@guestpost/shared\"`. The shared module includes IPv4-mapped IPv6 patterns (e.g. ::ffff:127.0.0.1) that a local copy would miss.",
  },
  {
    name: "uncapped response body read",
    regex: /\bawait\s+(?:res|response|resp|r)\.text\(\)/gm,
    why: "Phase 7.11 (#13) requires response bodies to be read with a size cap. Use `await readBodyWithCap(res, MAX_HTML_BYTES)`. A 1GB malicious response at concurrency 4 OOMs the worker pod.",
  },
]

function listProcessorFiles(): string[] {
  const out: string[] = []
  for (const name of readdirSync(PROCESSORS_DIR)) {
    const full = join(PROCESSORS_DIR, name)
    if (statSync(full).isFile() && /\.ts$/.test(name)) out.push(full)
  }
  return out
}

interface Hit {
  file: string
  line: number
  match: string
  rule: string
  why: string
}

function findHits(): Hit[] {
  const hits: Hit[] = []
  for (const file of listProcessorFiles()) {
    const content = readFileSync(file, "utf-8")
    const lines = content.split("\n")
    for (const { name, regex, why } of FORBIDDEN_PATTERNS) {
      regex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = regex.exec(content)) !== null) {
        const lineIdx = content.slice(0, m.index).split("\n").length - 1
        hits.push({
          file: file.replace(`${process.cwd()}/`, ""),
          line: lineIdx + 1,
          match: lines[lineIdx].trim(),
          rule: name,
          why,
        })
      }
    }
  }
  return hits
}

describe("Phase 7.11 — safeFetch adoption regression guard", () => {
  it("apps/worker/src/processors/*.ts has no local isSafePublicUrl / PRIVATE_IP_PATTERNS / uncapped body read", () => {
    const hits = findHits()
    if (hits.length === 0) {
      expect(hits).toEqual([])
      return
    }

    const grouped = new Map<string, Hit[]>()
    for (const h of hits) {
      const key = h.rule
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key)!.push(h)
    }

    const lines: string[] = ["Phase 7.11 forbidden patterns found in apps/worker/src/processors:"]
    for (const [rule, group] of grouped) {
      lines.push("")
      lines.push(`  Rule: ${rule}`)
      lines.push(`  Why : ${group[0].why}`)
      for (const h of group) {
        lines.push(`    ${h.file}:${h.line}  ${h.match}`)
      }
    }
    throw new Error(lines.join("\n"))
  })
})
