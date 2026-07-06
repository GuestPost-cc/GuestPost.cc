import type { AuthError, AuthenticatedUser, SignInResult } from "../types"
import { authClient } from "./auth-client"
import { mapBetterAuthError } from "./errors"

export async function signIn(input: {
  email: string
  password: string
}): Promise<SignInResult> {
  const { data, error } = await authClient.signIn.email({
    email: input.email,
    password: input.password,
  })

  if (error) throw mapBetterAuthError(error)

  if (!data?.user) {
    throw {
      code: "UNKNOWN",
      message: "Sign in failed",
      recoverable: true,
    } as AuthError
  }

  const user = data.user as unknown as AuthenticatedUser
  const session = await authClient.getSession()

  return {
    status: "authenticated",
    session: session.data?.session
      ? {
          id: session.data.session.id,
          userId: session.data.session.userId,
          expiresAt: new Date(session.data.session.expiresAt),
        }
      : { id: "", userId: user.id, expiresAt: new Date() },
    user,
  }
}

export async function signUp(input: {
  name: string
  email: string
  password: string
}): Promise<SignInResult> {
  const { data, error } = await authClient.signUp.email({
    name: input.name,
    email: input.email,
    password: input.password,
  })

  if (error) throw mapBetterAuthError(error)

  if (!data?.user) {
    throw {
      code: "UNKNOWN",
      message: "Sign up failed",
      recoverable: true,
    } as AuthError
  }

  const user = data.user as unknown as AuthenticatedUser
  const session = await authClient.getSession()

  return {
    status: "authenticated",
    session: session.data?.session
      ? {
          id: session.data.session.id,
          userId: session.data.session.userId,
          expiresAt: new Date(session.data.session.expiresAt),
        }
      : { id: "", userId: user.id, expiresAt: new Date() },
    user,
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
