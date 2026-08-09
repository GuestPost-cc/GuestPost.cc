export async function resolvePlatformFeeFractionCore(
  prisma: {
    platformSettings: {
      findFirst(): Promise<{ platformFeePct?: unknown } | null>
    }
  },
  envPercent: string | number | null | undefined,
): Promise<number> {
  const parsedEnv = Number(envPercent)
  let percent = Number.isFinite(parsedEnv) ? parsedEnv : 20

  try {
    const settings = await prisma.platformSettings.findFirst()
    const databasePercent = Number(settings?.platformFeePct)
    if (Number.isFinite(databasePercent)) percent = databasePercent
  } catch {
    // Database settings may not exist during an early migration rollout.
  }

  return Math.min(Math.max(percent, 0), 100) / 100
}

export interface PlatformFeePolicySnapshot {
  basisPoints: number
  fraction: number
  policyVersion: string
  settingsId: string
  settingsVersion: number
}

/**
 * Convert a percentage (20, 17.5, 17.25) into integer basis points without
 * accepting binary-float drift or hidden sub-basis-point precision.
 */
export function platformFeePercentToBasisPoints(value: unknown): number {
  const text = String(value)
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) {
    throw new Error("Platform fee percentage must have at most two decimals")
  }
  const basisPoints =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  if (!Number.isSafeInteger(basisPoints) || basisPoints > 10_000) {
    throw new Error("Platform fee percentage must be between 0 and 100")
  }
  return basisPoints
}

/**
 * Resolve the durable fee policy used by a new accounting row. Unlike the
 * backwards-compatible fraction helper above, this path is deliberately
 * fail-closed: migrations install exactly one versioned PlatformSettings row,
 * and a new liability must be traceable to it.
 */
export async function resolvePlatformFeePolicyCore(prisma: {
  platformSettings: {
    findMany(args: { take: number; orderBy: { id: "asc" } }): Promise<
      Array<{
        id?: unknown
        platformFeePct?: unknown
        version?: unknown
      }>
    >
  }
}): Promise<PlatformFeePolicySnapshot> {
  // Read up to two rows instead of findFirst(). Before the singleton database
  // index is deployed, findFirst() would silently turn an ambiguous policy set
  // into new money evidence. The finance writer must fail closed instead.
  const rows = await prisma.platformSettings.findMany({
    take: 2,
    orderBy: { id: "asc" },
  })
  const settings = rows.length === 1 ? rows[0] : null
  const settingsId = typeof settings?.id === "string" ? settings.id : ""
  const settingsVersion = Number(settings?.version)
  if (
    !settings ||
    !settingsId ||
    !Number.isSafeInteger(settingsVersion) ||
    settingsVersion < 1
  ) {
    throw new Error("Versioned PlatformSettings policy is unavailable")
  }

  const basisPoints = platformFeePercentToBasisPoints(settings.platformFeePct)
  const policyVersion = `platform-settings:${settingsId}:v${settingsVersion}`
  if (policyVersion.length > 128) {
    throw new Error("Versioned PlatformSettings policy identity is invalid")
  }
  return {
    basisPoints,
    fraction: basisPoints / 10_000,
    policyVersion,
    settingsId,
    settingsVersion,
  }
}
