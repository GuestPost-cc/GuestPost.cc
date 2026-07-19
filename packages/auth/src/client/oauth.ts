import { CURRENT_TERMS_VERSION } from "@guestpost/shared"
import type { AuthProvider } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function signInWithProvider(
  provider: AuthProvider,
  options: {
    callbackURL: string
    errorCallbackURL: string
    portal: "customer" | "publisher"
    flow: "login" | "signup"
    termsAccepted?: boolean
  },
): Promise<void> {
  if (options.flow === "signup" && options.termsAccepted !== true) {
    throw {
      code: "TERMS_REQUIRED",
      message: "Accept the Terms of Service before creating an account.",
      recoverable: true,
      httpStatus: 400,
    }
  }

  const { error } = await authClient.signIn.social({
    provider: provider as any,
    callbackURL: options.callbackURL,
    errorCallbackURL: options.errorCallbackURL,
    newUserCallbackURL: options.callbackURL,
    requestSignUp: options.flow === "signup",
    additionalData: {
      authFlow: options.flow,
      portal: options.portal,
      ...(options.flow === "signup"
        ? {
            termsAccepted: true,
            termsVersion: CURRENT_TERMS_VERSION,
          }
        : {}),
    },
  })

  if (error) throw mapBetterAuthError(error)
}

export async function signInWithGoogle(
  options: Parameters<typeof signInWithProvider>[1],
): Promise<void> {
  return signInWithProvider("google", options)
}
