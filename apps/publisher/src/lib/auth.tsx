"use client"

import { getSession } from "@guestpost/auth/client"
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
  publisherRole: "PUBLISHER_OWNER" | null
  publisherId: string | null
  banned: boolean
}

interface AuthContextValue {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, name: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      let token = getToken()
      if (!token) {
        const session = await getSession()
        if (session?.token) {
          token = session.token
          setToken(session.token)
        }
      }
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: "include",
      })
      if (res.ok) {
        const me = await res.json()
        if (me.userType !== "PUBLISHER") {
          clearToken()
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
      if (me.userType !== "PUBLISHER") {
        clearToken()
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

      // Accounts register as CUSTOMER by default — convert this fresh account
      // into a publisher (backend refuses staff/existing-membership accounts;
      // new publishers start at NEW tier with the full withdrawal hold).
      const convertRes = await fetch(
        `${getBaseUrl()}/api/v1/identity/become-publisher`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(data.token ? { Authorization: `Bearer ${data.token}` } : {}),
          },
          credentials: "include",
          body: JSON.stringify({ publisherName: name }),
        },
      )
      if (!convertRes.ok) {
        const err = await convertRes.json().catch(() => ({}))
        clearToken()
        throw new Error(
          err.message ?? "Could not set up your publisher account",
        )
      }

      await refresh()
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    const token = getToken()
    await fetch(`${getBaseUrl()}/api/v1/auth/sign-out`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: "include",
    })
    clearToken()
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
