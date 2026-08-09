import { ApiError } from "./client"

export interface DepositIdempotencyState {
  fingerprint: string
  key: string
}

export interface DepositCommandIdentity {
  walletId: string
  amount: number
  currency: string
}

/**
 * Binds a browser idempotency key to the immutable deposit command. An exact
 * retry reuses the key; changing amount, currency, or wallet creates a new
 * command identity instead of colliding with the prior server-side attempt.
 */
export function bindDepositIdempotencyKey(
  current: DepositIdempotencyState | null,
  command: DepositCommandIdentity,
  createKey: () => string,
): DepositIdempotencyState {
  const fingerprint = [
    command.walletId,
    command.amount.toFixed(2),
    command.currency,
  ].join(":")
  if (current?.fingerprint === fingerprint) return current
  return { fingerprint, key: createKey() }
}

export function depositErrorPresentation(
  error: unknown,
  fallback = "Failed to initiate deposit",
): { message: string; requestId?: string } {
  const message =
    error instanceof Error && error.message ? error.message : fallback
  return {
    message,
    ...(error instanceof ApiError && error.requestId
      ? { requestId: error.requestId }
      : {}),
  }
}
