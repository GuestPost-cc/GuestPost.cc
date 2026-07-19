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

const getBaseUrl = () => {
  const envUrl = process.env.NEXT_PUBLIC_API_URL
  if (envUrl) return envUrl
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1")
      return `http://${host}:4000`
  }
  return "http://localhost:4000"
}

type User = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
  userType: "CUSTOMER" | "PUBLISHER" | "STAFF"
  customerRole: "OWNER" | "MEMBER" | null
  organizationId: string | null
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
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      if (res.ok) {
        const me = await res.json()
        if (me.userType === "CUSTOMER") {
          setUser(me)
          return
        }
      }
    } catch (e) {
      console.error("Session refresh failed:", e)
    }
    setUser(null)
  }, [])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // Phase 7.0 — keep Sentry scope tagged with the identifying business
  // context so every captured exception (network error in a query, render
  // throw caught by error.tsx, etc.) surfaces with WHO it happened to.
  useEffect(() => {
    const scope = Sentry.getCurrentScope()
    if (user) {
      Sentry.setUser({ id: user.id })
      setBusinessContext(scope, {
        userType: user.userType,
        customerRole: user.customerRole ?? undefined,
        organizationId: user.organizationId ?? undefined,
      })
    } else {
      Sentry.setUser(null)
      scope.setTag("userType", undefined)
      scope.setTag("customerRole", undefined)
      scope.setTag("organizationId", undefined)
    }
  }, [user])

  const signIn = async (email: string, password: string) => {
    setLoading(true)
    try {
      await signInTransport({ email, password, portal: "customer" })
      const meRes = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      const me = await meRes.json()
      if (me.userType !== "CUSTOMER") {
        throw new Error(
          "This portal is for customers only. Please sign in at the correct portal.",
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
      await signUpTransport({
        email,
        password,
        name,
        termsAccepted,
        portal: "customer",
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
    <AuthContext.Provider
      value={{ user, loading, signIn, signUp, signOut, refresh }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
