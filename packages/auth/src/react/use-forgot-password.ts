"use client"

import { useCallback, useState } from "react"
import { getErrorMessage, isAuthError } from "../client/errors"
import { forgotPassword as forgotPasswordTransport } from "../client/transport"
import type { AuthError } from "../types"

export interface UseForgotPasswordReturn {
  submit: (input: { email: string }) => Promise<void>
  loading: boolean
  error: AuthError | null
  success: boolean
}

export function useForgotPassword(): UseForgotPasswordReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<AuthError | null>(null)
  const [success, setSuccess] = useState(false)

  const submit = useCallback(async (input: { email: string }) => {
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      await forgotPasswordTransport({ email: input.email })
      setSuccess(true)
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
  }, [])

  return { submit, loading, error, success }
}
