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
        code: "USER_NOT_FOUND",
        message: "No account found with this email.",
        recoverable: true,
        httpStatus: error.status ?? 404,
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
    case "ACCOUNT_LINKED":
      return {
        code: "ACCOUNT_LINKED",
        message: "This email is already linked to a different sign-in method.",
        recoverable: true,
        httpStatus: error.status ?? 409,
      }
    case "ACCOUNT_COLLISION_USE_SEPARATE_PROFILE":
      return {
        code: "ACCOUNT_COLLISION_USE_SEPARATE_PROFILE",
        message:
          "This email already belongs to a customer workspace. Please use a separate account for publishing, or contact support.",
        recoverable: true,
        httpStatus: error.status ?? 409,
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
