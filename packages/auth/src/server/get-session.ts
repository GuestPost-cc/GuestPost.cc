import { auth } from "../index"
import type { AuthenticatedUser, AuthSession } from "../types"

interface SessionResult {
  session: AuthSession
  user: AuthenticatedUser
}

export async function getSession(
  request: Request,
): Promise<SessionResult | null> {
  try {
    const result = await auth.api.getSession({
      headers: request.headers,
    })

    if (!result?.session || !result?.user) return null

    const user = result.user as any
    return {
      session: {
        id: result.session.id,
        userId: result.session.userId,
        expiresAt: new Date(result.session.expiresAt),
      },
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name ?? null,
        image: user.image ?? null,
        userType: user.userType,
        banned: user.banned ?? false,
      },
    }
  } catch {
    return null
  }
}

export async function requireSession(request: Request): Promise<SessionResult> {
  const result = await getSession(request)
  if (!result) {
    throw Object.assign(new Error("Authentication required"), {
      code: "NOT_AUTHENTICATED",
      recoverable: false,
      httpStatus: 401,
    })
  }
  return result
}

export async function signOutSession(request: Request): Promise<void> {
  try {
    await auth.api.signOut({
      headers: request.headers,
    })
  } catch {
    // swallow — best-effort
  }
}

export async function invalidateSession(sessionId: string): Promise<void> {
  try {
    await auth.api.revokeSession({
      body: { token: sessionId },
      headers: new Headers(),
    } as any)
  } catch {
    // swallow — best-effort
  }
}
