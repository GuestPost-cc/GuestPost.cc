"use client"

import { useCallback, useState } from "react"
import { getErrorMessage, isAuthError } from "../client/errors"
import { signIn as signInTransport } from "../client/transport"
import type { AuthError } from "../types"

export interface UseSignInReturn {
  signIn: (input: {
    email: string
    password: string
    returnTo?: string
    portal?: "customer" | "publisher"
  }) => Promise<void>
  loading: boolean
  error: AuthError | null
}

export function useSignIn(): UseSignInReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)

  const signIn = useCallback(
    async (input: {
      email: string
      password: string
      returnTo?: string
      portal?: "customer" | "publisher"
    }) => {
      setLoading(true)
      setError(null)
      try {
        await signInTransport({
          email: input.email,
          password: input.password,
          portal: input.portal,
        })
        // Hard navigation — forces the dashboard middleware to re-evaluate
        // the freshly-rotated session cookie. router.push() leaves the
        // Next.js layout with stale session state and bounces the user back.
        const redirectTo =
          input.returnTo ||
          (input.portal === "publisher" ? "/dashboard" : "/dashboard")
        if (redirectTo && typeof window !== "undefined") {
          window.location.href = redirectTo
        }
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
    [],
  )

  return { signIn, loading, error }
}
