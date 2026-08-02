import { loadRootEnv } from "./env"

interface TokenRow {
  id: string
  provider: string
  externalUserId: string
  ownerType: string
  ownerId: string
  encryptedAccessToken: string
  encryptedRefreshToken: string
  encryptionKeyVersion: number
}

function batchSize(): number {
  const index = process.argv.indexOf("--batch-size")
  if (index < 0) return 25
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("--batch-size must be an integer from 1 to 100")
  }
  return value
}

function assertTokenPayload(
  payload: Record<string, unknown>,
  purpose: "access" | "refresh",
): void {
  if (typeof payload.value !== "string" || payload.value.length === 0) {
    throw new Error(`Decrypted ${purpose} token has an invalid payload`)
  }
}

function safeRotationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("Unsupported integration encryption key version")) {
    return "stored key version is not present in the configured keyring"
  }
  if (message.includes("stored key version is newer")) {
    return "stored key version is newer than the active key version"
  }
  if (message.includes("changed during key rotation")) {
    return "credential changed concurrently"
  }
  if (message.includes("invalid payload")) {
    return "decrypted token payload has an invalid shape"
  }
  return "credential envelope could not be authenticated"
}

async function main() {
  loadRootEnv({ required: ["DATABASE_URL"] })
  const [
    { createPrismaClient },
    { IntegrationEncryptionService, integrationTokenEncryptionContext },
  ] = await Promise.all([
    import("../packages/database/src/create-prisma-client"),
    import("../packages/integrations/src/adapters/encryption.adapter"),
  ])

  const prisma: any = createPrismaClient()
  const encryption = new IntegrationEncryptionService()
  const activeVersion = encryption.currentVersion
  const limit = batchSize()
  const verifyOnly = process.argv.includes("--verify-only")

  try {
    if (verifyOnly) {
      let cursor: string | undefined
      let verified = 0
      for (;;) {
        const rows: TokenRow[] = await prisma.externalAccount.findMany({
          where: {
            NOT: {
              status: "ERROR",
              encryptedAccessToken: "",
              encryptedRefreshToken: "",
            },
          },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: "asc" },
          take: limit,
          select: {
            id: true,
            provider: true,
            externalUserId: true,
            ownerType: true,
            ownerId: true,
            encryptedAccessToken: true,
            encryptedRefreshToken: true,
            encryptionKeyVersion: true,
          },
        })
        if (rows.length === 0) break
        for (const row of rows) {
          try {
            assertTokenPayload(
              encryption.decrypt(
                row.encryptedAccessToken,
                row.encryptionKeyVersion,
                integrationTokenEncryptionContext(row, "access"),
              ),
              "access",
            )
            assertTokenPayload(
              encryption.decrypt(
                row.encryptedRefreshToken,
                row.encryptionKeyVersion,
                integrationTokenEncryptionContext(row, "refresh"),
              ),
              "refresh",
            )
          } catch (error) {
            throw new Error(
              `Credential verification failed for account ${row.id}: ${safeRotationFailureReason(error)}`,
            )
          }
          verified++
        }
        cursor = rows.at(-1)!.id
      }
      console.log(
        `Verified ${verified} integration account credential pair(s); active key version is ${activeVersion}.`,
      )
      return
    }

    const newerRows = await prisma.externalAccount.count({
      where: {
        encryptionKeyVersion: { gt: activeVersion },
        NOT: {
          status: "ERROR",
          encryptedAccessToken: "",
          encryptedRefreshToken: "",
        },
      },
    })
    if (newerRows !== 0) {
      throw new Error(
        `${newerRows} integration account(s) use a key version newer than the configured active version; refusing a downgrade`,
      )
    }

    let rotated = 0
    let cursor: string | undefined
    const failures: Array<{ id: string; reason: string }> = []
    for (;;) {
      const candidates: TokenRow[] = await prisma.externalAccount.findMany({
        where: {
          encryptionKeyVersion: { lt: activeVersion },
          NOT: {
            status: "ERROR",
            encryptedAccessToken: "",
            encryptedRefreshToken: "",
          },
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
        take: limit,
        select: {
          id: true,
          provider: true,
          externalUserId: true,
          ownerType: true,
          ownerId: true,
          encryptedAccessToken: true,
          encryptedRefreshToken: true,
          encryptionKeyVersion: true,
        },
      })
      if (candidates.length === 0) break

      for (const candidate of candidates) {
        cursor = candidate.id
        try {
          const changed = await prisma.$transaction(async (tx: any) => {
            const lockedRows = (await tx.$queryRawUnsafe(
              `SELECT "id", "provider", "externalUserId", "ownerType", "ownerId",
                      "encryptedAccessToken", "encryptedRefreshToken", "encryptionKeyVersion"
                 FROM "ExternalAccount"
                WHERE "id" = $1
                FOR UPDATE`,
              candidate.id,
            )) as TokenRow[]
            const row = lockedRows[0]
            if (!row || row.encryptionKeyVersion === activeVersion) return 0
            if (row.encryptionKeyVersion > activeVersion) {
              throw new Error("stored key version is newer than active version")
            }

            const accessContext = integrationTokenEncryptionContext(
              row,
              "access",
            )
            const refreshContext = integrationTokenEncryptionContext(
              row,
              "refresh",
            )
            const access = encryption.decrypt(
              row.encryptedAccessToken,
              row.encryptionKeyVersion,
              accessContext,
            )
            const refresh = encryption.decrypt(
              row.encryptedRefreshToken,
              row.encryptionKeyVersion,
              refreshContext,
            )
            assertTokenPayload(access, "access")
            assertTokenPayload(refresh, "refresh")

            const nextAccess = encryption.encrypt(access, {
              authenticatedContext: accessContext,
            })
            const nextRefresh = encryption.encrypt(refresh, {
              authenticatedContext: refreshContext,
            })
            if (
              nextAccess.version !== activeVersion ||
              nextRefresh.version !== activeVersion
            ) {
              throw new Error("Integration encryption active version changed")
            }

            const updated = await tx.externalAccount.updateMany({
              where: {
                id: row.id,
                encryptionKeyVersion: row.encryptionKeyVersion,
                encryptedAccessToken: row.encryptedAccessToken,
                encryptedRefreshToken: row.encryptedRefreshToken,
              },
              data: {
                encryptedAccessToken: nextAccess.ciphertext,
                encryptedRefreshToken: nextRefresh.ciphertext,
                encryptionKeyVersion: activeVersion,
              },
            })
            if (updated.count !== 1) {
              throw new Error(
                "Integration credential changed during key rotation",
              )
            }
            return 1
          })
          rotated += changed
        } catch (error) {
          failures.push({
            id: candidate.id,
            reason: safeRotationFailureReason(error),
          })
        }
      }
      console.log(`Rotated ${rotated} integration account(s).`)
    }

    const remaining = await prisma.externalAccount.count({
      where: {
        encryptionKeyVersion: { not: activeVersion },
        NOT: {
          status: "ERROR",
          encryptedAccessToken: "",
          encryptedRefreshToken: "",
        },
      },
    })
    if (failures.length !== 0) {
      const safeFailureSummary = failures
        .map(({ id, reason }) => `${id}: ${reason}`)
        .join("; ")
      throw new Error(
        `Failed to rotate ${failures.length} integration account(s): ${safeFailureSummary}`,
      )
    }
    if (remaining !== 0) {
      throw new Error(
        `${remaining} integration account(s) remain on a non-active key version`,
      )
    }
    console.log(
      `Integration encryption rotation complete at version ${activeVersion}.`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(
    `Integration encryption rotation failed: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
