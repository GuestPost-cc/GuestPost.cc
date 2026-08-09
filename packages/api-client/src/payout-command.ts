import { ApiError } from "./client"

export function payoutErrorPresentation(
  error: unknown,
  fallback = "Payout action failed",
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
