export const ORDER_CANCELLATION_DEFAULTS = {
  acceptanceWindowHours: 24,
  responseWindowHours: 24,
  acceptanceSweepMinutes: 15,
  responseSweepMinutes: 15,
} as const

export function parseBoundedPositiveInteger(
  raw: string | number | null | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const parsed = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), bounds.min), bounds.max)
}

export function resolveOrderCancellationConfig(
  env: Record<string, string | undefined>,
) {
  return {
    acceptanceWindowHours: parseBoundedPositiveInteger(
      env.ORDER_ACCEPTANCE_WINDOW_HOURS,
      ORDER_CANCELLATION_DEFAULTS.acceptanceWindowHours,
      { min: 1, max: 24 * 30 },
    ),
    responseWindowHours: parseBoundedPositiveInteger(
      env.CANCELLATION_RESPONSE_WINDOW_HOURS,
      ORDER_CANCELLATION_DEFAULTS.responseWindowHours,
      { min: 1, max: 24 * 30 },
    ),
    acceptanceSweepMinutes: parseBoundedPositiveInteger(
      env.ORDER_ACCEPTANCE_SWEEP_MINUTES,
      ORDER_CANCELLATION_DEFAULTS.acceptanceSweepMinutes,
      { min: 1, max: 24 * 60 },
    ),
    responseSweepMinutes: parseBoundedPositiveInteger(
      env.CANCELLATION_TIMEOUT_SWEEP_MINUTES,
      ORDER_CANCELLATION_DEFAULTS.responseSweepMinutes,
      { min: 1, max: 24 * 60 },
    ),
  }
}
