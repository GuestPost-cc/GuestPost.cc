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
