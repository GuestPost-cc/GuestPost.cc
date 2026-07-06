import type { UserType } from "@guestpost/shared"
import { getSession } from "../server/get-session"

export interface RequireRoleOptions {
  role: UserType
  signInPath: string
}

export interface RequireRoleResult {
  authorized: boolean
  redirectUrl?: string
}

export async function checkRequireRole(
  request: Request,
  options: RequireRoleOptions,
): Promise<RequireRoleResult> {
  const result = await getSession(request)

  if (!result) {
    return {
      authorized: false,
      redirectUrl: options.signInPath,
    }
  }

  if (result.user.userType !== options.role) {
    return {
      authorized: false,
      redirectUrl: options.signInPath,
    }
  }

  return { authorized: true }
}
