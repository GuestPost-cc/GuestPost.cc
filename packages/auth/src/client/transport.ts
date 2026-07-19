import { CURRENT_TERMS_VERSION } from "@guestpost/shared"
import type { AuthError, AuthenticatedUser, SignInResult } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"
import { getSession as serverGetSession } from "./session"

export async function signIn(input: {
  email: string
  password: string
  portal?: "customer" | "publisher" | "staff"
}): Promise<SignInResult> {
  const { data, error } = await authClient.signIn.email(
    {
      email: input.email,
      password: input.password,
    },
    input.portal
      ? {
          headers: {
            "x-portal-type": input.portal,
          },
        }
      : undefined,
  )

  if (error) throw mapBetterAuthError(error)

  if (!data?.user) {
    throw {
      code: "UNKNOWN",
      message: "Sign in failed",
      recoverable: true,
    } as AuthError
  }

  const session = await serverGetSession()

  // Never report a successful login until the browser cookie has been
  // round-tripped through the authoritative session endpoint. This prevents
  // the UI from redirecting to a dashboard with a missing/rejected cookie and
  // entering the login ↔ dashboard flicker seen in production.
  if (
    !session.session ||
    !session.user ||
    session.session.userId !== data.user.id ||
    session.user.id !== data.user.id
  ) {
    throw {
      code: "SESSION_ESTABLISHMENT_FAILED",
      message:
        "Your credentials were accepted, but a secure session could not be established. Please try again.",
      recoverable: true,
      httpStatus: 503,
    } as AuthError
  }

  const user: AuthenticatedUser = {
    id: data.user.id,
    email: data.user.email as string,
    emailVerified: data.user.emailVerified ?? false,
    name: data.user.name ?? null,
    image: null,
    userType: session.user.userType,
    banned: session.user.banned ?? false,
  }

  return {
    status: "authenticated",
    session: {
      id: session.session.id,
      userId: session.session.userId,
      expiresAt: session.session.expiresAt,
    },
    user,
  }
}

export async function signUp(input: {
  name: string
  email: string
  password: string
  termsAccepted: boolean
  portal?: "customer" | "publisher"
}): Promise<SignInResult> {
  const payload = {
    name: input.name,
    email: input.email,
    password: input.password,
    termsAccepted: input.termsAccepted,
    termsVersion: CURRENT_TERMS_VERSION,
  } as Parameters<typeof authClient.signUp.email>[0] & {
    termsAccepted: boolean
    termsVersion: string
  }

  const { data, error } = await authClient.signUp.email(
    payload,
    input.portal
      ? {
          headers: {
            "x-portal-type": input.portal,
          },
        }
      : undefined,
  )

  if (error) throw mapBetterAuthError(error)

  if (!data?.user) {
    throw {
      code: "UNKNOWN",
      message: "Sign up failed",
      recoverable: true,
    } as AuthError
  }

  const session = await serverGetSession()

  const user: AuthenticatedUser = {
    id: data.user.id,
    email: data.user.email as string,
    emailVerified: data.user.emailVerified ?? false,
    name: data.user.name ?? null,
    image: null,
    userType: session.user?.userType,
    banned: (data.user as any).banned ?? false,
  }

  return {
    status: "authenticated",
    session: session.session
      ? {
          id: session.session.id,
          userId: session.session.userId,
          expiresAt: session.session.expiresAt,
        }
      : { id: "", userId: user.id, expiresAt: new Date() },
    user,
  }
}

export async function signOut(): Promise<void> {
  const { error } = await authClient.signOut()
  if (error) throw mapBetterAuthError(error)
}

export async function forgotPassword(input: {
  email: string
  redirectTo?: string
}): Promise<void> {
  const { error } = await authClient.requestPasswordReset({
    email: input.email,
    redirectTo:
      input.redirectTo ??
      (typeof window !== "undefined"
        ? `${window.location.origin}/reset-password`
        : "/reset-password"),
  })
  if (error) throw mapBetterAuthError(error)
}

export async function resetPassword(input: {
  token: string
  password: string
}): Promise<void> {
  const { error } = await authClient.resetPassword({
    newPassword: input.password,
    token: input.token,
  })
  if (error) throw mapBetterAuthError(error)
}

export async function refreshSession(): Promise<AuthenticatedUser | null> {
  const { data, error } = await authClient.getSession()
  if (error || !data?.user) return null
  return data.user as unknown as AuthenticatedUser
}
