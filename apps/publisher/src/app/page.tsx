"use client"

import { useState, Suspense } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@guestpost/ui"
import { useAuth } from "../lib/auth"

function LoginContent() {
  const { signIn, signUp } = useAuth()
  const router = useRouter()
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      if (isSignUp) {
        await signUp(email, password, name)
      } else {
        await signIn(email, password)
      }
      router.push("/dashboard")
    } catch (err: any) {
      setError(err.message ?? "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[400px]">
        <div className="flex flex-col space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isSignUp ? "Publisher Sign Up" : "Publisher Sign In"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSignUp ? "Create an account to start publishing" : "Sign in to manage your orders and content"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {isSignUp && (
            <input
              type="text"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Loading..." : isSignUp ? "Create Account" : "Sign In"}
          </Button>
        </form>

        <div className="space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? (
              <>Already have an account?{" "}
                <button onClick={() => setIsSignUp(false)} className="underline underline-offset-4 hover:text-primary">
                  Sign in
                </button>
              </>
            ) : (
              <>Don&apos;t have an account?{" "}
                <button onClick={() => setIsSignUp(true)} className="underline underline-offset-4 hover:text-primary">
                  Sign up
                </button>
              </>
            )}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            <a href="http://localhost:3000" className="underline underline-offset-4 hover:text-primary">
              Back to homepage
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <LoginContent />
    </Suspense>
  )
}
