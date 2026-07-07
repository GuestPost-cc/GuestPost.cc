import type { UserType } from "@guestpost/shared"
import { getSession } from "./get-session"

export async function requireRole(
  request: Request,
  role: UserType,
): Promise<{ sessionId: string; userId: string }> {
  const result = await getSession(request)
  if (!result) {
    throw Object.assign(new Error("Authentication required"), {
      code: "NOT_AUTHENTICATED",
      recoverable: false,
      httpStatus: 401,
    })
  }

  if (result.user.userType !== role) {
    throw Object.assign(new Error(`Access denied: ${role} role required`), {
      code: "FORBIDDEN",
      recoverable: false,
      httpStatus: 403,
    })
  }

  return { sessionId: result.session.id, userId: result.user.id }
}
