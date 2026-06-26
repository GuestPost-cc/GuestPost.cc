"use client"

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
import { clearToken, getToken, setToken } from "./api"

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
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const token = getToken()
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include",
      })
      if (res.ok) {
        const me = await res.json()
        // Guard: if the token changed during this request (e.g. a newer
        // signIn/signUp happened), discard the stale result.
        if (getToken() !== token) return
        // Same gate as signIn: a restored PUBLISHER/STAFF session must not
        // land in the customer portal.
        if (me.userType === "CUSTOMER") {
          setUser(me)
          return
        }
        // Wrong-audience token must not linger in this app's storage
        clearToken()
      }
    } catch (e) {
      console.error("Session refresh failed:", e)
    }
    // Only clear user if token is still what we started with
    if (getToken() === token) setUser(null)
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
      const res = await fetch(`${getBaseUrl()}/api/v1/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message ?? "Invalid credentials")
      }
      const data = await res.json()
      if (data.token) setToken(data.token)

      const meRes = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        headers: data.token
          ? { Authorization: `Bearer ${data.token}` }
          : undefined,
        credentials: "include",
      })
      const me = await meRes.json()
      if (me.userType !== "CUSTOMER") {
        clearToken()
        throw new Error(
          "This portal is for customers only. Please sign in at the correct portal.",
        )
      }
      setUser(me)
    } finally {
      setLoading(false)
    }
  }

  const signUp = async (email: string, password: string, name: string) => {
    setLoading(true)
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
        credentials: "include",
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.message ?? "Sign up failed")
      }
      const data = await res.json()
      if (data.token) setToken(data.token)
      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    await fetch(`${getBaseUrl()}/api/v1/auth/sign-out`, {
      method: "POST",
      credentials: "include",
    })
    clearToken()
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
