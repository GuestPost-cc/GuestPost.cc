import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function getCsrfToken(): Promise<string | null> {
  try {
    const { data, error } = await authClient.getSession()
    if (error) throw mapBetterAuthError(error)
    return data?.session?.id ?? null
  } catch {
    return null
  }
}
