"use client"

import { useCallback, useState } from "react"
import { getErrorMessage, isAuthError } from "../client/errors"
import { signUp as signUpTransport } from "../client/transport"
import type { AuthError } from "../types"

export interface UseSignUpReturn {
  signUp: (input: {
    name: string
    email: string
    password: string
    returnTo?: string
    portal?: "customer" | "publisher"
  }) => Promise<void>
  loading: boolean
  error: AuthError | null
}

export function useSignUp(): UseSignUpReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)

  const signUp = useCallback(
    async (input: {
      name: string
      email: string
      password: string
      returnTo?: string
      portal?: "customer" | "publisher"
    }) => {
      setLoading(true)
      setError(null)
      try {
        await signUpTransport({
          name: input.name,
          email: input.email,
          password: input.password,
          portal: input.portal,
        })
        // Hard navigation — forces the dashboard middleware to re-evaluate
        // the freshly-rotated session cookie after birth-time provisioning.
        // router.push() leaves the Next.js layout with stale session state.
        const redirectTo = input.returnTo || "/dashboard"
        if (typeof window !== "undefined") {
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

  return { signUp, loading, error }
}
