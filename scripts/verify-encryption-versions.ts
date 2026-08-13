import { CURRENT_PAYOUT_KEY_VERSION } from "../apps/api/src/modules/publisher-payouts/payout-encryption.constants"
import {
  assertEmptyProviderConfigVersion,
  DEFAULT_PAYOUT_ENCRYPTION_BATCH_SIZE,
  isEmptyProviderConfig,
  isPlainRecord,
  MAX_PAYOUT_ENCRYPTION_BATCH_SIZE,
  parseBoundedPositiveInteger,
  payoutEnvelopeNeedsRotation,
} from "../apps/api/src/modules/publisher-payouts/payout-encryption-tools-core"
import { decodePayoutProviderConfig } from "../apps/api/src/modules/publisher-payouts/payout-provider-config"
import { loadRootEnv } from "./env"

interface PayoutMethodRow {
  id: string
  publisherId: string
  type: string
  details: unknown
  encryptionKeyVersion: number
  isActive: boolean
}

interface PayoutProviderRow {
  id: string
  name: string
  config: unknown
  configEncryptionKeyVersion: number
  isActive: boolean
}

interface VerificationFailure {
  table: "PayoutMethod" | "PayoutProvider"
  id: string
  reason: string
}

interface DistributionEntry {
  table: "PayoutMethod" | "PayoutProvider"
  version: number
  keyId: string
  count: number
}

interface CliOptions {
  batchSize: number
  json: boolean
  quiet: boolean
  requireActive: boolean
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parseOptions(args: string[]): CliOptions {
  const valueFlags = new Set([
    "--batch-size",
    // Retained only so an old runbook invocation cannot accidentally reduce
    // coverage. The value is validated, then ignored: verification is full.
    "--sample",
  ])
  const booleanFlags = new Set([
    "--json",
    "--quiet",
    "--decrypt",
    "--require-active",
  ])

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (valueFlags.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error(`${arg} requires a value`)
      }
      index++
      continue
    }
    if (!booleanFlags.has(arg)) throw new Error(`Unknown argument: ${arg}`)
  }

  const deprecatedSample = valueAfter(args, "--sample")
  if (deprecatedSample !== undefined) {
    parseBoundedPositiveInteger(deprecatedSample, "--sample", 1, 10_000)
  }

  return {
    batchSize: parseBoundedPositiveInteger(
      valueAfter(args, "--batch-size"),
      "--batch-size",
      DEFAULT_PAYOUT_ENCRYPTION_BATCH_SIZE,
      MAX_PAYOUT_ENCRYPTION_BATCH_SIZE,
    ),
    json: args.includes("--json"),
    quiet: args.includes("--quiet"),
    requireActive: args.includes("--require-active"),
  }
}

function assertDecryptedRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error("decrypted payload has an invalid shape")
  }
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (
    message.includes("invalid shape") ||
    message.includes("must be an object")
  ) {
    return "decrypted payload has an invalid shape"
  }
  if (message.includes("unknown") && message.includes("key")) {
    return "envelope key ID is not available in the configured decrypt key set"
  }
  if (message.includes("legacy") && message.includes("key")) {
    return "legacy decrypt key is not configured"
  }
  if (message.includes("context") || message.includes("authenticated data")) {
    return "ciphertext is not authenticated for this row identity"
  }
  if (message.includes("version") || message.includes("format")) {
    return "ciphertext format version is unsupported or inconsistent"
  }
  if (message.includes("config must be encrypted")) {
    return "provider config is neither authenticated ciphertext nor the empty sentinel"
  }
  return "ciphertext envelope could not be authenticated"
}

function distributionKey(
  table: DistributionEntry["table"],
  version: number,
  keyId: string,
): string {
  return `${table}\u0000${version}\u0000${keyId}`
}

function recordDistribution(
  distribution: Map<string, DistributionEntry>,
  table: DistributionEntry["table"],
  version: number,
  keyId: string,
): void {
  const key = distributionKey(table, version, keyId)
  const existing = distribution.get(key)
  if (existing) {
    existing.count++
    return
  }
  distribution.set(key, { table, version, keyId, count: 1 })
}

function envelopeLabel(
  encryption: { getEnvelopeKeyId(ciphertext: string): string | null },
  ciphertext: string,
  version: number,
): string {
  const keyId = encryption.getEnvelopeKeyId(ciphertext)
  return keyId ?? `legacy:v${version}`
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  loadRootEnv({ required: ["DATABASE_URL"] })

  const [
    { createPrismaClient },
    {
      PayoutEncryptionService,
      payoutMethodEncryptionContext,
      payoutProviderEncryptionContext,
    },
  ] = await Promise.all([
    import("../packages/database/src/create-prisma-client"),
    import(
      "../apps/api/src/modules/publisher-payouts/payout-encryption.service"
    ),
  ])

  const prisma: any = createPrismaClient()
  const encryption = new PayoutEncryptionService()
  const failures: VerificationFailure[] = []
  const distribution = new Map<string, DistributionEntry>()
  let methodsScanned = 0
  let activeMethodsScanned = 0
  let providersScanned = 0
  let activeProvidersScanned = 0
  let emptyProvidersSkipped = 0
  let methodCursor: string | undefined
  let providerCursor: string | undefined

  try {
    for (;;) {
      const rows: PayoutMethodRow[] = await prisma.payoutMethod.findMany({
        where: methodCursor ? { id: { gt: methodCursor } } : undefined,
        orderBy: { id: "asc" },
        take: options.batchSize,
        select: {
          id: true,
          publisherId: true,
          type: true,
          details: true,
          encryptionKeyVersion: true,
          isActive: true,
        },
      })
      if (rows.length === 0) break

      for (const row of rows) {
        methodsScanned++
        if (row.isActive) activeMethodsScanned++
        let keyLabel = "invalid-envelope"
        try {
          if (typeof row.details !== "string" || row.details.length === 0) {
            throw new Error("ciphertext format is invalid")
          }
          keyLabel = envelopeLabel(
            encryption,
            row.details,
            row.encryptionKeyVersion,
          )
          const context = payoutMethodEncryptionContext(row)
          const decrypted = encryption.decrypt(
            row.details,
            row.encryptionKeyVersion,
            context,
          )
          assertDecryptedRecord(decrypted)
          if (
            options.requireActive &&
            payoutEnvelopeNeedsRotation({
              storedVersion: row.encryptionKeyVersion,
              currentVersion: CURRENT_PAYOUT_KEY_VERSION,
              envelopeKeyId:
                keyLabel === "invalid-envelope" ||
                keyLabel.startsWith("legacy:")
                  ? null
                  : keyLabel,
              activeKeyId: encryption.activeKeyId,
            })
          ) {
            failures.push({
              table: "PayoutMethod",
              id: row.id,
              reason: "authenticated ciphertext does not use the active key",
            })
          }
        } catch (error) {
          failures.push({
            table: "PayoutMethod",
            id: row.id,
            reason: safeFailureReason(error),
          })
        }
        recordDistribution(
          distribution,
          "PayoutMethod",
          row.encryptionKeyVersion,
          keyLabel,
        )
        methodCursor = row.id
      }
    }

    for (;;) {
      const rows: PayoutProviderRow[] = await prisma.payoutProvider.findMany({
        where: providerCursor ? { id: { gt: providerCursor } } : undefined,
        orderBy: { id: "asc" },
        take: options.batchSize,
        select: {
          id: true,
          name: true,
          config: true,
          configEncryptionKeyVersion: true,
          isActive: true,
        },
      })
      if (rows.length === 0) break

      for (const row of rows) {
        providersScanned++
        if (row.isActive) activeProvidersScanned++
        if (isEmptyProviderConfig(row.config)) {
          emptyProvidersSkipped++
          try {
            assertEmptyProviderConfigVersion(row.configEncryptionKeyVersion)
          } catch {
            failures.push({
              table: "PayoutProvider",
              id: row.id,
              reason: "empty provider config must use encryption version 0",
            })
          }
          recordDistribution(
            distribution,
            "PayoutProvider",
            row.configEncryptionKeyVersion,
            "empty-config",
          )
          providerCursor = row.id
          continue
        }

        let keyLabel = "invalid-envelope"
        try {
          if (typeof row.config !== "string" || row.config.length === 0) {
            throw new Error("provider config must be encrypted ciphertext")
          }
          keyLabel = envelopeLabel(
            encryption,
            row.config,
            row.configEncryptionKeyVersion,
          )
          const context = payoutProviderEncryptionContext(row)
          const decrypted = decodePayoutProviderConfig(
            row.config,
            row.configEncryptionKeyVersion,
            (ciphertext, version) =>
              encryption.decrypt(ciphertext, version, context),
          )
          assertDecryptedRecord(decrypted)
          if (
            options.requireActive &&
            payoutEnvelopeNeedsRotation({
              storedVersion: row.configEncryptionKeyVersion,
              currentVersion: CURRENT_PAYOUT_KEY_VERSION,
              envelopeKeyId:
                keyLabel === "invalid-envelope" ||
                keyLabel.startsWith("legacy:")
                  ? null
                  : keyLabel,
              activeKeyId: encryption.activeKeyId,
            })
          ) {
            failures.push({
              table: "PayoutProvider",
              id: row.id,
              reason: "authenticated ciphertext does not use the active key",
            })
          }
        } catch (error) {
          failures.push({
            table: "PayoutProvider",
            id: row.id,
            reason: safeFailureReason(error),
          })
        }
        recordDistribution(
          distribution,
          "PayoutProvider",
          row.configEncryptionKeyVersion,
          keyLabel,
        )
        providerCursor = row.id
      }
    }

    const distributionRows = [...distribution.values()].sort((left, right) =>
      `${left.table}:${left.version}:${left.keyId}`.localeCompare(
        `${right.table}:${right.version}:${right.keyId}`,
      ),
    )
    const result = {
      activeKeyId: encryption.activeKeyId,
      currentFormatVersion: CURRENT_PAYOUT_KEY_VERSION,
      requireActive: options.requireActive,
      scanned: {
        payoutMethods: methodsScanned,
        activePayoutMethods: activeMethodsScanned,
        inactivePayoutMethods: methodsScanned - activeMethodsScanned,
        payoutProviders: providersScanned,
        activePayoutProviders: activeProvidersScanned,
        inactivePayoutProviders: providersScanned - activeProvidersScanned,
        emptyProviderConfigsSkipped: emptyProvidersSkipped,
      },
      distribution: distributionRows,
      failures,
      pass: failures.length === 0,
      cursors: {
        methodAfterId: methodCursor ?? null,
        providerAfterId: providerCursor ?? null,
      },
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, options.quiet ? 0 : 2))
    } else if (!options.quiet) {
      console.log(
        `Payout encryption verification scanned ${methodsScanned} payout method(s) ` +
          `(${activeMethodsScanned} active, ${methodsScanned - activeMethodsScanned} inactive) ` +
          `and ${providersScanned} provider row(s) ` +
          `(${emptyProvidersSkipped} empty config sentinel(s)).`,
      )
      console.log(
        `Active key ID: ${encryption.activeKeyId}; current envelope format: v${CURRENT_PAYOUT_KEY_VERSION}.`,
      )
      if (options.requireActive) {
        console.log(
          "Active-key gate enabled: legacy and decrypt-only envelopes fail verification.",
        )
      }
      for (const entry of distributionRows) {
        console.log(
          `${entry.table} v${entry.version} ${entry.keyId}: ${entry.count} row(s)`,
        )
      }
      if (failures.length === 0) {
        console.log(
          "PASS: every encrypted payout row authenticated successfully.",
        )
      } else {
        for (const failure of failures) {
          console.error(
            `FAIL ${failure.table} ${failure.id}: ${failure.reason}`,
          )
        }
        console.error(
          `FAIL: ${failures.length} encrypted payout row(s) could not be verified.`,
        )
      }
    }

    if (failures.length > 0) process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(
    `Payout encryption verification failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
