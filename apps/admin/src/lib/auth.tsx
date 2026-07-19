"use client"

import {
  getErrorMessage,
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
  sessionError: string | null
  signIn: (email: string, password: string) => Promise<User>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<User | null> => {
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/identity/me`, {
        credentials: "include",
        cache: "no-store",
      })
      if (res.ok) {
        const me = (await res.json()) as User
        if (me.userType !== "STAFF") {
          setUser(null)
          setSessionError(
            "This portal is for staff only. Sign in with a staff account.",
          )
          return null
        }
        setUser(me)
        setSessionError(null)
        return me
      }
      if (res.status === 403) {
        const body = await res.json().catch(() => null)
        const message =
          body?.code === "ACCOUNT_SUSPENDED" ||
          /suspend|banned/i.test(body?.message ?? "")
            ? "This administrator account is suspended. Contact a Super Admin if you believe this is a mistake."
            : "Your administrator session is not authorized. Sign in again."
        setSessionError(message)
      }
    } catch (e) {
      console.error("Session refresh failed:", e)
      setSessionError(
        "We could not verify your administrator session. Please try again.",
      )
    }
    setUser(null)
    return null
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

  const signIn = async (email: string, password: string): Promise<User> => {
    setLoading(true)
    setSessionError(null)
    try {
      await signInTransport({ email, password, portal: "staff" })
      const me = await refresh()
      if (!me) {
        throw new Error(
          "Your administrator session could not be established. Please sign in again.",
        )
      }
      return me
    } catch (error) {
      setSessionError(getErrorMessage(error))
      throw error
    } finally {
      setLoading(false)
    }
  }

  const signOut = async () => {
    await signOutTransport()
    setUser(null)
    setSessionError(null)
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, sessionError, signIn, signOut }}
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
