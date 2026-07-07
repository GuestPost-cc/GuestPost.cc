import type { AuthProvider } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function signInWithProvider(
  provider: AuthProvider,
  callbackURL?: string,
): Promise<void> {
  const { error } = await authClient.signIn.social({
    provider: provider as any,
    ...(callbackURL ? { callbackURL } : {}),
  })

  if (error) throw mapBetterAuthError(error)
}

export async function signInWithGoogle(callbackURL?: string): Promise<void> {
  return signInWithProvider("google", callbackURL)
}
