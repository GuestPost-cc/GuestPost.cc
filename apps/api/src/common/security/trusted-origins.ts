const DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:4000",
]

export function getAllowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  return configured?.length ? configured : DEVELOPMENT_ORIGINS
}

export function isTrustedOrigin(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const candidate = new URL(value).origin
    return getAllowedOrigins().some((allowed) => {
      try {
        return new URL(allowed).origin === candidate
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
