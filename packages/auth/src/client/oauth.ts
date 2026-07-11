import type { AuthProvider } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function signInWithProvider(
  provider: AuthProvider,
  callbackURL?: string,
  portal?: "customer" | "publisher",
): Promise<void> {
  const resolvedCallbackURL = callbackURL
    ? appendPortalToCallbackURL(callbackURL, portal)
    : undefined

  const { error } = await authClient.signIn.social({
    provider: provider as any,
    ...(resolvedCallbackURL ? { callbackURL: resolvedCallbackURL } : {}),
  })

  if (error) throw mapBetterAuthError(error)
}

export async function signInWithGoogle(
  callbackURL?: string,
  portal?: "customer" | "publisher",
): Promise<void> {
  return signInWithProvider("google", callbackURL, portal)
}

function appendPortalToCallbackURL(
  callbackURL: string,
  portal?: "customer" | "publisher",
): string {
  if (!portal) return callbackURL
  try {
    const url = new URL(callbackURL, window.location.origin)
    url.searchParams.set("portal", portal)
    return url.toString()
  } catch {
    const separator = callbackURL.includes("?") ? "&" : "?"
    return `${callbackURL}${separator}portal=${encodeURIComponent(portal)}`
  }
}
