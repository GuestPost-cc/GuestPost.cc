import type { AuthProvider } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function signInWithProvider(
  provider: AuthProvider,
): Promise<void> {
  const { error } = await authClient.signIn.social({
    provider: provider as any,
  })

  if (error) throw mapBetterAuthError(error)
}

export async function signInWithGoogle(): Promise<void> {
  return signInWithProvider("google")
}
