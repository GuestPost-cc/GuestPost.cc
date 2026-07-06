"use client"

import { useRouter } from "next/navigation"
import { useCallback, useState } from "react"
import { getErrorMessage, isAuthError } from "../client/errors"
import { signIn as signInTransport } from "../client/transport"
import type { AuthError } from "../types"

export interface UseSignInReturn {
  signIn: (input: {
    email: string
    password: string
    returnTo?: string
  }) => Promise<void>
  loading: boolean
  error: AuthError | null
}

export function useSignIn(): UseSignInReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)
  const router = useRouter()

  const signIn = useCallback(
    async (input: { email: string; password: string; returnTo?: string }) => {
      setLoading(true)
      setError(null)
      try {
        const result = await signInTransport({
          email: input.email,
          password: input.password,
        })
        const redirectTo =
          input.returnTo ||
          (result.status === "authenticated" ? "/dashboard" : null)
        if (redirectTo) router.push(redirectTo)
      } catch (err) {
        if (isAuthError(err)) {
          setError(err)
        } else {
          setError({
            code: "UNKNOWN",
            message: getErrorMessage(err),
            recoverable: true,
          })
        }
      } finally {
        setLoading(false)
      }
    },
    [router],
  )

  return { signIn, loading, error }
}
