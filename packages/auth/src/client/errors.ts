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
    default:
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
