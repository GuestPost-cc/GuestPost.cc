import type { AuthError } from "../types"

export type { AuthError } from "../types"

export function mapBetterAuthError(
  error:
    | { code?: string; message?: string; status?: number }
    | null
    | undefined,
): AuthError {
  if (!error) {
    return {
      code: "UNKNOWN",
      message: "Something went wrong",
      recoverable: true,
    }
  }

  switch (error.code) {
    case "INVALID_PASSWORD":
    case "INVALID_EMAIL_OR_PASSWORD":
      return {
        code: "INVALID_CREDENTIALS",
        message: "Incorrect email or password.",
        recoverable: true,
        httpStatus: error.status ?? 401,
      }
    case "USER_NOT_FOUND":
      return {
        code: "INVALID_CREDENTIALS",
        message: "Incorrect email or password.",
        recoverable: true,
        httpStatus: error.status ?? 401,
      }
    case "INVALID_EMAIL":
      return {
        code: "VALIDATION_ERROR",
        message: "Enter a valid email address.",
        recoverable: true,
        httpStatus: error.status ?? 400,
      }
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return {
        code: "ACCOUNT_EXISTS",
        message: "An account with this email already exists. Sign in instead.",
        recoverable: true,
        httpStatus: error.status ?? 422,
      }
    case "EMAIL_NOT_VERIFIED":
      return {
        code: "EMAIL_NOT_VERIFIED",
        message: "Please verify your email before signing in.",
        recoverable: true,
        httpStatus: error.status ?? 403,
      }
    case "ACCOUNT_SUSPENDED":
    case "USER_BANNED":
      return {
        code: "ACCOUNT_SUSPENDED",
        message:
          error.message ??
          "This account is suspended. Contact support if you believe this is a mistake.",
        recoverable: true,
        httpStatus: error.status ?? 403,
      }
    case "ACCOUNT_LINKED":
      return {
        code: "ACCOUNT_LINKED",
        message: "This email is already linked to a different sign-in method.",
        recoverable: true,
        httpStatus: error.status ?? 409,
      }
    case "WRONG_PORTAL":
    case "WRONG_AUDIENCE":
      return {
        code: "WRONG_PORTAL",
        message:
          error.message ??
          "This account belongs to a different portal. Use the correct portal or another account.",
        recoverable: true,
        httpStatus: error.status ?? 403,
      }
    case "TERMS_REQUIRED":
      return {
        code: "TERMS_REQUIRED",
        message:
          "Accept the current Terms of Service before creating an account.",
        recoverable: true,
        httpStatus: error.status ?? 400,
      }
    case "RATE_LIMITED":
      return {
        code: "RATE_LIMITED",
        message: "Too many attempts. Please try again later.",
        recoverable: true,
        httpStatus: error.status ?? 429,
      }
    case "PASSWORD_TOO_SHORT":
      return {
        code: "VALIDATION_ERROR",
        message: "Password must be at least 8 characters.",
        recoverable: true,
        httpStatus: error.status ?? 422,
      }
    case "PASSWORD_TOO_LONG":
      return {
        code: "VALIDATION_ERROR",
        message: "Password must be 128 characters or fewer.",
        recoverable: true,
        httpStatus: error.status ?? 422,
      }
    default:
      if (error.status === 429) {
        return {
          code: "RATE_LIMITED",
          message: "Too many attempts. Please try again later.",
          recoverable: true,
          httpStatus: 429,
        }
      }
      if (error.status && error.status >= 500) {
        return {
          code: "UNKNOWN",
          message: "We couldn't complete your request. Please try again.",
          recoverable: true,
          httpStatus: error.status,
        }
      }
      return {
        code: error.code ?? "UNKNOWN",
        message: error.message ?? "Something went wrong",
        recoverable: true,
        httpStatus: error.status,
      }
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "recoverable" in error
  )
}

export function getErrorMessage(error: unknown): string {
  if (isAuthError(error)) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong"
}

export function getOAuthErrorMessage(code: string | null): string | null {
  if (!code) return null
  const normalized = code.trim().toLowerCase()
  switch (normalized) {
    case "access_denied":
      return "Google sign-in was cancelled. You can try again when you're ready."
    case "signup_disabled":
      return "No account exists for this Google profile. Create an account first."
    case "wrong_portal":
    case "wrong_audience":
      return "This account is registered for a different portal. Open the correct portal or use another Google account."
    case "terms_required":
      return "Accept the current Terms of Service before creating an account."
    case "account_suspended":
    case "user_banned":
      return "This account is suspended. Contact support if you believe this is a mistake."
    case "state_mismatch":
    case "state_not_found":
    case "invalid_state":
      return "The secure Google sign-in request expired or could not be verified. Please try again."
    case "account_not_linked":
    case "account_already_linked_to_different_user":
    case "unable_to_link_account":
      return "This Google profile is already associated with another account. Sign in using the original method or contact support."
    default:
      return "Google sign-in could not be completed. Please try again."
  }
}
