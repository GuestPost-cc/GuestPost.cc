import { CURRENT_PAYOUT_KEY_VERSION } from "../apps/api/src/modules/publisher-payouts/payout-encryption.constants"
import { createPrismaClient } from "../packages/database/src"

const SUPPORTED_VERSIONS = [0, CURRENT_PAYOUT_KEY_VERSION]

interface VersionGroup {
  table: string
  column: string
  version: number
  count: number
}

interface DecryptResult {
  table: string
  id: string
  version: number
  ok: boolean
  error?: string
}

function parseFlags() {
  const outputJson = process.argv.includes("--json")
  const quiet = process.argv.includes("--quiet")
  const doDecrypt = process.argv.includes("--decrypt")

  let sampleSize = 1
  const sampleIdx = process.argv.indexOf("--sample")
  if (sampleIdx >= 0) {
    const raw = Number(process.argv[sampleIdx + 1])
    if (Number.isNaN(raw) || raw < 1) {
      console.error("error: --sample must be a positive integer")
      process.exit(1)
    }
    sampleSize = Math.max(1, raw)
  }

  return { outputJson, quiet, doDecrypt, sampleSize }
}

async function main() {
  const { outputJson, quiet, doDecrypt, sampleSize } = parseFlags()
  const prisma = createPrismaClient()

  try {
    const groups: VersionGroup[] = []
    const errors: string[] = []
    const decryptResults: DecryptResult[] = []

    // Group PayoutMethod by encryptionKeyVersion
    const pm = await prisma.payoutMethod.groupBy({
      by: ["encryptionKeyVersion"],
      _count: true,
      where: { isActive: true },
    })
    for (const g of pm) {
      groups.push({
        table: "PayoutMethod",
        column: "encryptionKeyVersion",
        version: g.encryptionKeyVersion,
        count: g._count,
      })
      if (!SUPPORTED_VERSIONS.includes(g.encryptionKeyVersion)) {
        errors.push(
          `PayoutMethod.encryptionKeyVersion=${g.encryptionKeyVersion} (${g._count} rows) — not in supported set ${JSON.stringify(SUPPORTED_VERSIONS)}`,
        )
      }
    }
    if (pm.length === 0) {
      groups.push({
        table: "PayoutMethod",
        column: "encryptionKeyVersion",
        version: -1,
        count: 0,
      })
    }

    // Group PayoutProvider by configEncryptionKeyVersion
    const pp = await prisma.payoutProvider.groupBy({
      by: ["configEncryptionKeyVersion"],
      _count: true,
      where: { isActive: true },
    })
    for (const g of pp) {
      groups.push({
        table: "PayoutProvider",
        column: "configEncryptionKeyVersion",
        version: g.configEncryptionKeyVersion,
        count: g._count,
      })
      if (!SUPPORTED_VERSIONS.includes(g.configEncryptionKeyVersion)) {
        errors.push(
          `PayoutProvider.configEncryptionKeyVersion=${g.configEncryptionKeyVersion} (${g._count} rows) — not in supported set ${JSON.stringify(SUPPORTED_VERSIONS)}`,
        )
      }
    }
    if (pp.length === 0) {
      groups.push({
        table: "PayoutProvider",
        column: "configEncryptionKeyVersion",
        version: -1,
        count: 0,
      })
    }

    // --decrypt: one representative row per (table, version)
    if (doDecrypt && !outputJson) {
      // Lazy-import the real encryption service. Must set env before import.
      const origKey = process.env.PAYOUT_ENCRYPTION_KEY
      const origEnv = process.env.NODE_ENV
      process.env.NODE_ENV = "production"
      process.env.PAYOUT_ENCRYPTION_KEY = origKey || ""

      const { PayoutEncryptionService } = await import(
        "../apps/api/src/modules/publisher-payouts/payout-encryption.service"
      )
      const svc = new PayoutEncryptionService()

      // Restore env after construction
      process.env.NODE_ENV = origEnv
      if (!origKey) delete process.env.PAYOUT_ENCRYPTION_KEY

      const seen = new Set<string>()

      // Decrypt PayoutMethod samples
      for (const g of pm) {
        const key = `PayoutMethod:v${g.encryptionKeyVersion}`
        if (seen.has(key)) continue
        seen.add(key)
        const rows = await prisma.payoutMethod.findMany({
          where: {
            encryptionKeyVersion: g.encryptionKeyVersion,
            isActive: true,
            details: { not: null },
          },
          take: sampleSize,
          select: { id: true, details: true, encryptionKeyVersion: true },
        })
        for (const row of rows) {
          try {
            svc.decrypt(String(row.details), row.encryptionKeyVersion)
            decryptResults.push({
              table: "PayoutMethod",
              id: row.id,
              version: row.encryptionKeyVersion,
              ok: true,
            })
          } catch (err) {
            decryptResults.push({
              table: "PayoutMethod",
              id: row.id,
              version: row.encryptionKeyVersion,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
            errors.push(
              `PayoutMethod ${row.id} (v${row.encryptionKeyVersion}): decrypt failed — ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }

      // Decrypt PayoutProvider samples
      for (const g of pp) {
        const key = `PayoutProvider:v${g.configEncryptionKeyVersion}`
        if (seen.has(key)) continue
        seen.add(key)
        const rows = await prisma.payoutProvider.findMany({
          where: {
            configEncryptionKeyVersion: g.configEncryptionKeyVersion,
            isActive: true,
            config: { not: null },
          },
          take: sampleSize,
          select: { id: true, config: true, configEncryptionKeyVersion: true },
        })
        for (const row of rows) {
          try {
            svc.decrypt(String(row.config), row.configEncryptionKeyVersion)
            decryptResults.push({
              table: "PayoutProvider",
              id: row.id,
              version: row.configEncryptionKeyVersion,
              ok: true,
            })
          } catch (err) {
            decryptResults.push({
              table: "PayoutProvider",
              id: row.id,
              version: row.configEncryptionKeyVersion,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
            errors.push(
              `PayoutProvider ${row.id} (v${row.configEncryptionKeyVersion}): decrypt failed — ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
    }

    // --json output
    if (outputJson) {
      const result = {
        groups,
        errors,
        decrypt: doDecrypt ? decryptResults : undefined,
        supported: SUPPORTED_VERSIONS,
        pass: errors.length === 0,
      }
      console.log(JSON.stringify(result, null, quiet ? 0 : 2))
      process.exit(errors.length ? 1 : 0)
    }

    if (quiet) {
      process.exit(errors.length ? 1 : 0)
    }

    // Human-readable output
    console.log("\nEncryption key version distribution:\n")
    console.log("  Table             Column                     Ver  Rows")
    for (const g of groups) {
      if (g.version === -1 && g.count === 0) {
        console.log(
          `  ${g.table.padEnd(18)} ${g.column.padEnd(27)}  —    0  (no encrypted rows)`,
        )
      } else {
        console.log(
          `  ${g.table.padEnd(18)} ${g.column.padEnd(27)} ${String(g.version).padStart(3)}  ${g.count}`,
        )
      }
    }
    console.log(`\n  Supported versions: ${JSON.stringify(SUPPORTED_VERSIONS)}`)

    if (decryptResults.length > 0) {
      console.log("\n  Decrypt samples:")
      const failed = decryptResults.filter((r) => !r.ok)
      for (const r of decryptResults) {
        const icon = r.ok ? "✅" : "❌"
        const note = r.ok ? "" : ` — ${r.error}`
        console.log(`    ${icon} ${r.table} ${r.id} (v${r.version})${note}`)
      }
      if (failed.length > 0) {
        console.log(`\n  ❌ ${failed.length} decrypt sample(s) failed`)
      } else {
        console.log(`\n  ✅ All ${decryptResults.length} decrypt sample(s) OK`)
      }
    }

    if (errors.length > 0) {
      console.log("\n  Errors:")
      for (const e of errors) console.log(`    ❌ ${e}`)
      console.log("\n  ❌ FAIL")
      process.exit(1)
    }
    console.log(
      "\n  ✅ PASS — all encryption versions are in the supported set.",
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
