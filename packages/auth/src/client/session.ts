import type { AuthenticatedUser } from "../types"
import { authClient } from "./auth-client"

export async function getSession(): Promise<{
  session: { id: string; userId: string; expiresAt: Date } | null
  user: AuthenticatedUser | null
}> {
  const { data, error } = await authClient.getSession()
  if (error || !data) {
    return { session: null, user: null }
  }

  return {
    session: data.session
      ? {
          id: data.session.id,
          userId: data.session.userId,
          expiresAt: new Date(data.session.expiresAt),
        }
      : null,
    user: data.user ? (data.user as unknown as AuthenticatedUser) : null,
  }
}
