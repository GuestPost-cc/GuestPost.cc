"use client"

import {
  signIn as signInTransport,
  signOut as signOutTransport,
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
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      if (res.ok) {
        const me = await res.json()
        if (me.userType !== "STAFF") {
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
      await signInTransport({ email, password, portal: "staff" })
      const meRes = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
      })
      const me = await meRes.json()
      if (me.userType !== "STAFF") {
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
    await signOutTransport()
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
