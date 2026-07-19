"use client"

import {
  signIn as signInTransport,
  signOut as signOutTransport,
  signUp as signUpTransport,
} from "@guestpost/auth/client"
import { setBusinessContext } from "@guestpost/shared"
import * as Sentry from "@sentry/nextjs"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"

type User = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
  userType: "CUSTOMER" | "PUBLISHER" | "STAFF"
  publisherRole: "PUBLISHER_OWNER" | null
  publisherId: string | null
  banned: boolean
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (
    email: string,
    password: string,
    name: string,
    termsAccepted: boolean,
  ) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Auth provider for the publisher app (used by dashboard pages).
 *
 * The login page (`apps/publisher/src/app/page.tsx`) handles its own auth
 * flow and hard-redirects to /dashboard on success — it does NOT use this
 * provider. This provider's `signIn`/`signUp` are convenience wrappers for
 * any consumer that wants the AuthProvider-shaped API (e.g. programmatic
 * sign-in from a settings page).
 *
 * Signup creates a PUBLISHER directly; login never mutates account type.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const getBaseUrl = useCallback(() => {
    const envUrl = process.env.NEXT_PUBLIC_API_URL
    if (envUrl) return envUrl
    if (typeof window !== "undefined") {
      const host = window.location.hostname
      if (host !== "localhost" && host !== "127.0.0.1")
        return `http://${host}:4000`
    }
    return "http://localhost:4000"
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      if (res.ok) {
        const me = await res.json()
        if (me.userType !== "PUBLISHER") {
          setUser(null)
          return
        }
        setUser(me)
        return
      }
    } catch (e) {
      console.error("Session refresh failed:", e)
    }
    setUser(null)
  }, [getBaseUrl])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // Phase 7.0 — tag Sentry scope with publisher identity for forensics.
  useEffect(() => {
    const scope = Sentry.getCurrentScope()
    if (user) {
      Sentry.setUser({ id: user.id })
      setBusinessContext(scope, {
        userType: user.userType,
        publisherRole: user.publisherRole ?? undefined,
        publisherId: user.publisherId ?? undefined,
      })
    } else {
      Sentry.setUser(null)
      scope.setTag("userType", undefined)
      scope.setTag("publisherRole", undefined)
      scope.setTag("publisherId", undefined)
    }
  }, [user])

  const signIn = async (email: string, password: string) => {
    setLoading(true)
    try {
      await signInTransport({
        email,
        password,
        portal: "publisher",
      })

      const meRes = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      const me = await meRes.json()
      if (me.userType !== "PUBLISHER") {
        throw new Error(
          "This portal is for publishers only. Please sign in at the correct portal.",
        )
      }
      setUser(me)
      window.location.reload()
    } finally {
      setLoading(false)
    }
  }

  const signUp = async (
    email: string,
    password: string,
    name: string,
    termsAccepted: boolean,
  ) => {
    setLoading(true)
    try {
      // Birth-time provisioning: the databaseHooks in packages/auth set
      // userType=PUBLISHER and provision the publisher entity automatically.
      // No follow-up account-type mutation is needed.
      await signUpTransport({
        email,
        password,
        name,
        termsAccepted,
        portal: "publisher",
      })
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    await signOutTransport()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
