export const DEFAULT_PAYOUT_ENCRYPTION_BATCH_SIZE = 25
export const MAX_PAYOUT_ENCRYPTION_BATCH_SIZE = 100
export const MAX_PAYOUT_ENCRYPTION_CURSOR_LENGTH = 191

export function parseBoundedPositiveInteger(
  raw: string | undefined,
  flag: string,
  fallback: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${flag} must be an integer from 1 to ${maximum}`)
  }
  return value
}

export function parseBoundedCursor(
  raw: string | undefined,
  flag: string,
): string | undefined {
  if (raw === undefined) return undefined
  if (
    raw.trim() !== raw ||
    raw.length < 1 ||
    raw.length > MAX_PAYOUT_ENCRYPTION_CURSOR_LENGTH
  ) {
    throw new Error(
      `${flag} must be a non-empty identifier no longer than ${MAX_PAYOUT_ENCRYPTION_CURSOR_LENGTH} characters`,
    )
  }
  return raw
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function isEmptyProviderConfig(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0
}

export function assertEmptyProviderConfigVersion(version: number): void {
  if (version !== 0) {
    throw new Error("empty provider config must use encryption version 0")
  }
}

export function payoutEnvelopeNeedsRotation(params: {
  storedVersion: number
  currentVersion: number
  envelopeKeyId: string | null
  activeKeyId: string
}): boolean {
  return (
    params.storedVersion !== params.currentVersion ||
    params.envelopeKeyId !== params.activeKeyId
  )
}

export function assertPayoutEncryptionMutationPosture(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "FINANCE_RUNTIME_MODE" | "PAYOUT_EXECUTION_ENABLED">
  >,
): void {
  if (
    env.FINANCE_RUNTIME_MODE !== "locked" ||
    env.PAYOUT_EXECUTION_ENABLED !== "false"
  ) {
    throw new Error(
      "Payout encryption mutation requires FINANCE_RUNTIME_MODE=locked and PAYOUT_EXECUTION_ENABLED=false",
    )
  }
}
