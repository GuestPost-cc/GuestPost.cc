export interface VerificationRateLimitConfig {
  cooldownMs: number
  hourlyCap: number
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

export function resolveVerificationRateLimitConfig(
  env: NodeJS.ProcessEnv,
): VerificationRateLimitConfig {
  return {
    cooldownMs:
      positiveInteger(env, "VERIFY_COOLDOWN_SECONDS", 60, 3_600) * 1_000,
    hourlyCap: positiveInteger(env, "VERIFY_HOURLY_CAP", 20, 1_000),
  }
}
