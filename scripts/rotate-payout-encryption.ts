import { CURRENT_PAYOUT_KEY_VERSION } from "../apps/api/src/modules/publisher-payouts/payout-encryption.constants"
import {
  assertEmptyProviderConfigVersion,
  assertPayoutEncryptionMutationPosture,
  DEFAULT_PAYOUT_ENCRYPTION_BATCH_SIZE,
  isEmptyProviderConfig,
  isPlainRecord,
  MAX_PAYOUT_ENCRYPTION_BATCH_SIZE,
  parseBoundedCursor,
  parseBoundedPositiveInteger,
  payoutEnvelopeNeedsRotation,
} from "../apps/api/src/modules/publisher-payouts/payout-encryption-tools-core"
import { decodePayoutProviderConfig } from "../apps/api/src/modules/publisher-payouts/payout-provider-config"
import { loadRootEnv } from "./env"

const MAX_SERIALIZATION_ATTEMPTS = 3

interface PayoutMethodRow {
  id: string
  publisherId: string
  type: string
  details: unknown
  encryptionKeyVersion: number
  isActive: boolean
  version: number
}

interface PayoutProviderRow {
  id: string
  name: string
  config: unknown
  configEncryptionKeyVersion: number
  isActive: boolean
  version: number
}

interface EncryptionRuntime {
  activeKeyId: string
  getEnvelopeKeyId(ciphertext: string): string | null
  decrypt(
    ciphertext: string,
    version: number,
    context?: unknown,
  ): Record<string, unknown>
  encrypt(
    plaintext: Record<string, unknown>,
    context: unknown,
  ): { ciphertext: string; version: number; keyId: string }
}

interface InFlightExecution {
  id: string
  status: string
}

interface CliOptions {
  batchSize: number
  methodAfterId?: string
  providerAfterId?: string
  dryRun: boolean
  verifyOnly: boolean
  quiet: boolean
}

interface RotationCounters {
  scanned: number
  active: number
  current: number
  rotated: number
  wouldRotate: number
  emptySkipped: number
}

interface RotationFailure {
  table: "PayoutMethod" | "PayoutProvider"
  id: string
  reason: string
}

type RotationResult = "current" | "rotated"

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
    "--method-after-id",
    "--provider-after-id",
  ])
  const booleanFlags = new Set(["--dry-run", "--verify-only", "--quiet"])

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

  const dryRun = args.includes("--dry-run")
  const verifyOnly = args.includes("--verify-only")
  if (dryRun && verifyOnly) {
    throw new Error("Use either --dry-run or --verify-only, not both")
  }

  return {
    batchSize: parseBoundedPositiveInteger(
      valueAfter(args, "--batch-size"),
      "--batch-size",
      DEFAULT_PAYOUT_ENCRYPTION_BATCH_SIZE,
      MAX_PAYOUT_ENCRYPTION_BATCH_SIZE,
    ),
    methodAfterId: parseBoundedCursor(
      valueAfter(args, "--method-after-id"),
      "--method-after-id",
    ),
    providerAfterId: parseBoundedCursor(
      valueAfter(args, "--provider-after-id"),
      "--provider-after-id",
    ),
    dryRun,
    verifyOnly,
    quiet: args.includes("--quiet"),
  }
}

function assertDecryptedRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error("decrypted payload has an invalid shape")
  }
}

function needsRotation(
  encryption: EncryptionRuntime,
  ciphertext: string,
  version: number,
): boolean {
  return payoutEnvelopeNeedsRotation({
    storedVersion: version,
    currentVersion: CURRENT_PAYOUT_KEY_VERSION,
    envelopeKeyId: encryption.getEnvelopeKeyId(ciphertext),
    activeKeyId: encryption.activeKeyId,
  })
}

function encryptForActiveKey(
  encryption: EncryptionRuntime,
  plaintext: Record<string, unknown>,
  context: unknown,
): { ciphertext: string; version: number; keyId: string } {
  const next = encryption.encrypt(plaintext, context)
  if (
    next.version !== CURRENT_PAYOUT_KEY_VERSION ||
    next.keyId !== encryption.activeKeyId ||
    encryption.getEnvelopeKeyId(next.ciphertext) !== encryption.activeKeyId
  ) {
    throw new Error("active encryption provider returned inconsistent metadata")
  }
  const authenticated = encryption.decrypt(
    next.ciphertext,
    next.version,
    context,
  )
  assertDecryptedRecord(authenticated)
  return next
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (message.includes("nonterminal payout execution")) {
    return error instanceof Error
      ? error.message
      : "affected payout is in flight"
  }
  if (message.includes("changed during payout encryption rotation")) {
    return "row changed concurrently"
  }
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
  if (message.includes("provider config must be encrypted")) {
    return "provider config is neither authenticated ciphertext nor the empty sentinel"
  }
  if (message.includes("active encryption provider")) {
    return "active key provider returned an inconsistent envelope"
  }
  return "ciphertext envelope could not be authenticated"
}

function isSerializationFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown }
  const message =
    typeof candidate?.message === "string" ? candidate.message : ""
  return (
    candidate?.code === "P2034" ||
    message.includes("40001") ||
    message.toLowerCase().includes("serialization failure") ||
    message.toLowerCase().includes("write conflict")
  )
}

async function serializableWithRetry<T>(
  prisma: any,
  operation: (tx: any) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 30_000,
      })
    } catch (error) {
      if (
        !isSerializationFailure(error) ||
        attempt === MAX_SERIALIZATION_ATTEMPTS
      ) {
        throw error
      }
    }
  }
  throw new Error("unreachable payout encryption retry state")
}

async function methodExecutionBlocker(
  tx: any,
  payoutMethodId: string,
): Promise<InFlightExecution | undefined> {
  const rows = (await tx.$queryRawUnsafe(
    `SELECT pe."id", pe."status"::text AS "status"
       FROM "PayoutExecution" pe
       INNER JOIN "Withdrawal" w ON w."id" = pe."withdrawalId"
      WHERE w."payoutMethodId" = $1
        AND pe."status" IN ('PENDING', 'PROCESSING', 'FAILED')
      ORDER BY pe."id" ASC
      LIMIT 1
      FOR UPDATE OF pe`,
    payoutMethodId,
  )) as InFlightExecution[]
  return rows[0]
}

async function providerExecutionBlocker(
  tx: any,
  providerId: string,
): Promise<InFlightExecution | undefined> {
  const rows = (await tx.$queryRawUnsafe(
    `SELECT pe."id", pe."status"::text AS "status"
       FROM "PayoutExecution" pe
      WHERE pe."providerId" = $1
        AND pe."status" IN ('PENDING', 'PROCESSING', 'FAILED')
      ORDER BY pe."id" ASC
      LIMIT 1
      FOR UPDATE OF pe`,
    providerId,
  )) as InFlightExecution[]
  return rows[0]
}

async function rotateMethod(
  prisma: any,
  encryption: EncryptionRuntime,
  methodId: string,
  payoutMethodEncryptionContext: (row: PayoutMethodRow) => unknown,
): Promise<RotationResult> {
  return serializableWithRetry(prisma, async (tx) => {
    const observed = (await tx.payoutMethod.findUnique({
      where: { id: methodId },
      select: {
        id: true,
        publisherId: true,
        type: true,
        details: true,
        encryptionKeyVersion: true,
        isActive: true,
        version: true,
      },
    })) as PayoutMethodRow | null
    if (!observed) return "current"
    if (typeof observed.details !== "string" || observed.details.length === 0) {
      throw new Error("ciphertext format is invalid")
    }

    const observedContext = payoutMethodEncryptionContext(observed)
    const observedPlaintext = encryption.decrypt(
      observed.details,
      observed.encryptionKeyVersion,
      observedContext,
    )
    assertDecryptedRecord(observedPlaintext)
    if (
      !needsRotation(
        encryption,
        observed.details,
        observed.encryptionKeyVersion,
      )
    ) {
      return "current"
    }

    // Preserve the runtime claim path's Execution -> PayoutMethod lock order.
    // Under SERIALIZABLE, an execution inserted after this negative predicate
    // conflicts with the later routing-row update and forces a retry.
    const blocker = await methodExecutionBlocker(tx, observed.id)
    if (blocker) {
      throw new Error(
        `PayoutMethod has nonterminal payout execution ${blocker.id} (${blocker.status})`,
      )
    }

    const lockedRows = (await tx.$queryRawUnsafe(
      `SELECT "id", "publisherId", "type", "details",
              "encryptionKeyVersion", "isActive", "version"
         FROM "PayoutMethod"
        WHERE "id" = $1
        FOR UPDATE`,
      observed.id,
    )) as PayoutMethodRow[]
    const row = lockedRows[0]
    if (!row) return "current"
    if (typeof row.details !== "string" || row.details.length === 0) {
      throw new Error("ciphertext format is invalid")
    }
    const context = payoutMethodEncryptionContext(row)
    const plaintext = encryption.decrypt(
      row.details,
      row.encryptionKeyVersion,
      context,
    )
    assertDecryptedRecord(plaintext)
    if (!needsRotation(encryption, row.details, row.encryptionKeyVersion)) {
      return "current"
    }

    const next = encryptForActiveKey(encryption, plaintext, context)
    const updated = await tx.$executeRawUnsafe(
      `UPDATE "PayoutMethod"
          SET "details" = to_jsonb($1::text),
              "encryptionKeyVersion" = $2,
              "version" = "version" + 1,
              "updatedAt" = NOW()
        WHERE "id" = $3
          AND "details" = to_jsonb($4::text)
          AND "encryptionKeyVersion" = $5
          AND "version" = $6`,
      next.ciphertext,
      next.version,
      row.id,
      row.details,
      row.encryptionKeyVersion,
      row.version,
    )
    if (Number(updated) !== 1) {
      throw new Error("PayoutMethod changed during payout encryption rotation")
    }
    return "rotated"
  })
}

async function rotateProvider(
  prisma: any,
  encryption: EncryptionRuntime,
  providerId: string,
  payoutProviderEncryptionContext: (row: PayoutProviderRow) => unknown,
): Promise<RotationResult> {
  return serializableWithRetry(prisma, async (tx) => {
    const observed = (await tx.payoutProvider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        name: true,
        config: true,
        configEncryptionKeyVersion: true,
        isActive: true,
        version: true,
      },
    })) as PayoutProviderRow | null
    if (!observed) return "current"
    if (isEmptyProviderConfig(observed.config)) {
      assertEmptyProviderConfigVersion(observed.configEncryptionKeyVersion)
      return "current"
    }
    if (typeof observed.config !== "string" || observed.config.length === 0) {
      throw new Error("provider config must be encrypted ciphertext")
    }

    const observedContext = payoutProviderEncryptionContext(observed)
    const observedPlaintext = decodePayoutProviderConfig(
      observed.config,
      observed.configEncryptionKeyVersion,
      (ciphertext, version) =>
        encryption.decrypt(ciphertext, version, observedContext),
    )
    assertDecryptedRecord(observedPlaintext)
    if (
      !needsRotation(
        encryption,
        observed.config,
        observed.configEncryptionKeyVersion,
      )
    ) {
      return "current"
    }

    // Preserve the runtime claim path's Execution -> PayoutProvider lock order.
    const blocker = await providerExecutionBlocker(tx, observed.id)
    if (blocker) {
      throw new Error(
        `PayoutProvider has nonterminal payout execution ${blocker.id} (${blocker.status})`,
      )
    }

    const lockedRows = (await tx.$queryRawUnsafe(
      `SELECT "id", "name", "config", "configEncryptionKeyVersion",
              "isActive", "version"
         FROM "PayoutProvider"
        WHERE "id" = $1
        FOR UPDATE`,
      observed.id,
    )) as PayoutProviderRow[]
    const row = lockedRows[0]
    if (!row) return "current"
    if (isEmptyProviderConfig(row.config)) {
      assertEmptyProviderConfigVersion(row.configEncryptionKeyVersion)
      return "current"
    }
    if (typeof row.config !== "string" || row.config.length === 0) {
      throw new Error("provider config must be encrypted ciphertext")
    }
    const context = payoutProviderEncryptionContext(row)
    const plaintext = decodePayoutProviderConfig(
      row.config,
      row.configEncryptionKeyVersion,
      (ciphertext, version) => encryption.decrypt(ciphertext, version, context),
    )
    assertDecryptedRecord(plaintext)
    if (
      !needsRotation(encryption, row.config, row.configEncryptionKeyVersion)
    ) {
      return "current"
    }

    const next = encryptForActiveKey(encryption, plaintext, context)
    const updated = await tx.$executeRawUnsafe(
      `UPDATE "PayoutProvider"
          SET "config" = to_jsonb($1::text),
              "configEncryptionKeyVersion" = $2,
              "version" = "version" + 1,
              "updatedAt" = NOW()
        WHERE "id" = $3
          AND "config" = to_jsonb($4::text)
          AND "configEncryptionKeyVersion" = $5
          AND "version" = $6`,
      next.ciphertext,
      next.version,
      row.id,
      row.config,
      row.configEncryptionKeyVersion,
      row.version,
    )
    if (Number(updated) !== 1) {
      throw new Error(
        "PayoutProvider changed during payout encryption rotation",
      )
    }
    return "rotated"
  })
}

async function inspectMethodWithoutWrite(
  prisma: any,
  encryption: EncryptionRuntime,
  row: PayoutMethodRow,
  contextFactory: (row: PayoutMethodRow) => unknown,
  dryRun: boolean,
): Promise<"current" | "would-rotate"> {
  if (typeof row.details !== "string" || row.details.length === 0) {
    throw new Error("ciphertext format is invalid")
  }
  const context = contextFactory(row)
  const plaintext = encryption.decrypt(
    row.details,
    row.encryptionKeyVersion,
    context,
  )
  assertDecryptedRecord(plaintext)
  if (!needsRotation(encryption, row.details, row.encryptionKeyVersion)) {
    return "current"
  }
  if (dryRun) {
    const blocker = await methodExecutionBlocker(prisma, row.id)
    if (blocker) {
      throw new Error(
        `PayoutMethod has nonterminal payout execution ${blocker.id} (${blocker.status})`,
      )
    }
    encryptForActiveKey(encryption, plaintext, context)
  }
  return "would-rotate"
}

async function inspectProviderWithoutWrite(
  prisma: any,
  encryption: EncryptionRuntime,
  row: PayoutProviderRow,
  contextFactory: (row: PayoutProviderRow) => unknown,
  dryRun: boolean,
): Promise<"current" | "would-rotate" | "empty"> {
  if (isEmptyProviderConfig(row.config)) {
    assertEmptyProviderConfigVersion(row.configEncryptionKeyVersion)
    return "empty"
  }
  if (typeof row.config !== "string" || row.config.length === 0) {
    throw new Error("provider config must be encrypted ciphertext")
  }
  const context = contextFactory(row)
  const plaintext = decodePayoutProviderConfig(
    row.config,
    row.configEncryptionKeyVersion,
    (ciphertext, version) => encryption.decrypt(ciphertext, version, context),
  )
  assertDecryptedRecord(plaintext)
  if (!needsRotation(encryption, row.config, row.configEncryptionKeyVersion)) {
    return "current"
  }
  if (dryRun) {
    const blocker = await providerExecutionBlocker(prisma, row.id)
    if (blocker) {
      throw new Error(
        `PayoutProvider has nonterminal payout execution ${blocker.id} (${blocker.status})`,
      )
    }
    encryptForActiveKey(encryption, plaintext, context)
  }
  return "would-rotate"
}

function emptyCounters(): RotationCounters {
  return {
    scanned: 0,
    active: 0,
    current: 0,
    rotated: 0,
    wouldRotate: 0,
    emptySkipped: 0,
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  loadRootEnv({ required: ["DATABASE_URL"] })

  if (!options.dryRun && !options.verifyOnly) {
    assertPayoutEncryptionMutationPosture(process.env)
  }

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
  const encryption = new PayoutEncryptionService() as EncryptionRuntime
  const methodCounters = emptyCounters()
  const providerCounters = emptyCounters()
  const failures: RotationFailure[] = []
  let methodCursor = options.methodAfterId
  let providerCursor = options.providerAfterId

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
          version: true,
        },
      })
      if (rows.length === 0) break

      for (const row of rows) {
        methodCounters.scanned++
        if (row.isActive) methodCounters.active++
        try {
          if (options.dryRun || options.verifyOnly) {
            const result = await inspectMethodWithoutWrite(
              prisma,
              encryption,
              row,
              payoutMethodEncryptionContext,
              options.dryRun,
            )
            if (result === "current") methodCounters.current++
            else methodCounters.wouldRotate++
          } else {
            const result = await rotateMethod(
              prisma,
              encryption,
              row.id,
              payoutMethodEncryptionContext,
            )
            if (result === "rotated") methodCounters.rotated++
            else methodCounters.current++
          }
        } catch (error) {
          failures.push({
            table: "PayoutMethod",
            id: row.id,
            reason: safeFailureReason(error),
          })
        }
        methodCursor = row.id
      }

      if (!options.quiet) {
        console.log(
          `PayoutMethod checkpoint --method-after-id ${methodCursor}: ` +
            `${methodCounters.scanned} scanned, ${methodCounters.rotated} rotated, ` +
            `${methodCounters.wouldRotate} would rotate.`,
        )
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
          version: true,
        },
      })
      if (rows.length === 0) break

      for (const row of rows) {
        providerCounters.scanned++
        if (row.isActive) providerCounters.active++
        try {
          if (options.dryRun || options.verifyOnly) {
            const result = await inspectProviderWithoutWrite(
              prisma,
              encryption,
              row,
              payoutProviderEncryptionContext,
              options.dryRun,
            )
            if (result === "empty") providerCounters.emptySkipped++
            else if (result === "current") providerCounters.current++
            else providerCounters.wouldRotate++
          } else if (isEmptyProviderConfig(row.config)) {
            assertEmptyProviderConfigVersion(row.configEncryptionKeyVersion)
            providerCounters.emptySkipped++
          } else {
            const result = await rotateProvider(
              prisma,
              encryption,
              row.id,
              payoutProviderEncryptionContext,
            )
            if (result === "rotated") providerCounters.rotated++
            else providerCounters.current++
          }
        } catch (error) {
          failures.push({
            table: "PayoutProvider",
            id: row.id,
            reason: safeFailureReason(error),
          })
        }
        providerCursor = row.id
      }

      if (!options.quiet) {
        console.log(
          `PayoutProvider checkpoint --provider-after-id ${providerCursor}: ` +
            `${providerCounters.scanned} scanned, ${providerCounters.rotated} rotated, ` +
            `${providerCounters.wouldRotate} would rotate, ` +
            `${providerCounters.emptySkipped} empty config(s) skipped.`,
        )
      }
    }

    if (!options.quiet) {
      const mode = options.verifyOnly
        ? "verification"
        : options.dryRun
          ? "dry run"
          : "rotation"
      console.log(
        `Payout encryption ${mode} finished for active key ${encryption.activeKeyId} ` +
          `and envelope format v${CURRENT_PAYOUT_KEY_VERSION}.`,
      )
      console.log(
        `PayoutMethod: ${methodCounters.scanned} scanned ` +
          `(${methodCounters.active} active, ${methodCounters.scanned - methodCounters.active} inactive), ` +
          `${methodCounters.current} current, ${methodCounters.rotated} rotated, ` +
          `${methodCounters.wouldRotate} would rotate.`,
      )
      console.log(
        `PayoutProvider: ${providerCounters.scanned} scanned ` +
          `(${providerCounters.active} active, ${providerCounters.scanned - providerCounters.active} inactive), ` +
          `${providerCounters.current} current, ${providerCounters.rotated} rotated, ` +
          `${providerCounters.wouldRotate} would rotate, ` +
          `${providerCounters.emptySkipped} empty config(s) skipped.`,
      )
      for (const failure of failures) {
        console.error(`FAIL ${failure.table} ${failure.id}: ${failure.reason}`)
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} payout encryption row(s) failed; rerun from the beginning after resolving them`,
      )
    }
    if (
      options.verifyOnly &&
      methodCounters.wouldRotate + providerCounters.wouldRotate > 0
    ) {
      throw new Error(
        `${methodCounters.wouldRotate + providerCounters.wouldRotate} payout encryption row(s) are authenticated but do not use the active key`,
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(
    `Payout encryption rotation failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
