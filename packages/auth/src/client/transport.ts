import type { AuthError, AuthenticatedUser, SignInResult } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"
import { getSession as serverGetSession } from "./session"

export async function signIn(input: {
  email: string
  password: string
  portal?: "customer" | "publisher"
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
    token: data.token ?? undefined,
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
  } as Parameters<typeof authClient.signUp.email>[0] & {
    termsAccepted: boolean
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
    token: data.token ?? undefined,
  }
}

export async function signOut(): Promise<void> {
  const { error } = await authClient.signOut()
  if (error) throw mapBetterAuthError(error)
}

export async function forgotPassword(input: { email: string }): Promise<void> {
  const { error } = await (authClient as any).forgetPassword({
    email: input.email,
    redirectTo: "/reset-password",
  })
  if (error) throw mapBetterAuthError(error)
}

export async function resetPassword(input: {
  token: string
  password: string
}): Promise<void> {
  const { error } = await (authClient as any).resetPassword({
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
