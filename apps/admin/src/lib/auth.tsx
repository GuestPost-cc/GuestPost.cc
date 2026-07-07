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
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  banned: boolean
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const token = getToken()
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include",
      })
      if (res.ok) {
        setUser(await res.json())
        return
      }
    } catch (e) {
      console.error("Session refresh failed:", e)
    }
    setUser(null)
  }, [])

  useEffect(() => {
    refresh().finally(() => setLoading(false))
  }, [refresh])

  // Phase 7.0 — tag Sentry scope with staff identity. Staff role is the most
  // useful tag for triage (FINANCE vs OPERATIONS vs SUPER_ADMIN actions).
  useEffect(() => {
    const scope = Sentry.getCurrentScope()
    if (user) {
      Sentry.setUser({ id: user.id })
      setBusinessContext(scope, {
        userType: user.userType,
        staffRole: user.staffRole ?? undefined,
      })
    } else {
      Sentry.setUser(null)
      scope.setTag("userType", undefined)
      scope.setTag("staffRole", undefined)
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
      if (me.userType !== "STAFF") {
        clearToken()
        throw new Error(
          "This portal is for staff only. Please sign in at the correct portal.",
        )
      }
      setUser(me)
      window.location.reload()
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
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
