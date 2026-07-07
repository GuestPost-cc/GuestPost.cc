export interface AuthSession {
  id: string
  userId: string
  expiresAt: Date
}

export interface AuthenticatedUser {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  image: string | null
  userType: "CUSTOMER" | "PUBLISHER" | "STAFF" | undefined
  banned: boolean
}

export type AuthProvider = "google" | "github" | "microsoft" | "passkey"

export type SignInResult =
  | {
      status: "authenticated"
      session: AuthSession
      user: AuthenticatedUser
      token?: string
    }
  | {
      status: "mfa_required"
      methods: AuthProvider[]
    }

export interface AuthError {
  code: string
  message: string
  recoverable: boolean
  httpStatus?: number
}
