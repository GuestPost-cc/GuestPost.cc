import {
  forgotPasswordSchema,
  loginSchema,
  signupSchema,
} from "@guestpost/shared"

const authRequestSchemas = {
  "/request-password-reset": forgotPasswordSchema,
  "/sign-in/email": loginSchema,
  "/sign-up/email": signupSchema,
} as const

export interface AuthRequestValidationSuccess {
  success: true
  data: Record<string, unknown>
}

export interface AuthRequestValidationFailure {
  success: false
  message: string
}

export type AuthRequestValidationResult =
  | AuthRequestValidationSuccess
  | AuthRequestValidationFailure

export function validateAuthRequest(
  path: string,
  body: unknown,
): AuthRequestValidationResult | null {
  const schema = authRequestSchemas[path as keyof typeof authRequestSchemas]
  if (!schema) return null

  const result = schema.safeParse(body)
  if (!result.success) {
    return {
      success: false,
      message: result.error.issues[0]?.message ?? "Invalid request",
    }
  }

  return { success: true, data: { ...result.data } }
}
