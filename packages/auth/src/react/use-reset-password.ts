"use client"

import { useRouter } from "next/navigation"
import { useCallback, useState } from "react"
import { getErrorMessage, isAuthError } from "../client/errors"
import { resetPassword as resetPasswordTransport } from "../client/transport"
import type { AuthError } from "../types"

export interface UseResetPasswordReturn {
  submit: (input: { token: string; password: string }) => Promise<void>
  loading: boolean
  error: AuthError | null
}

export function useResetPassword(): UseResetPasswordReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)
  const router = useRouter()

  const submit = useCallback(
    async (input: { token: string; password: string }) => {
      setLoading(true)
      setError(null)
      try {
        await resetPasswordTransport({
          token: input.token,
          password: input.password,
        })
        router.push("/?reset=success")
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

  return { submit, loading, error }
}
