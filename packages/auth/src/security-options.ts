export const AUTH_SESSION_OPTIONS = {
  expiresIn: 8 * 60 * 60,
  updateAge: 30 * 60,
  freshAge: 30 * 60,
} as const

export const AUTH_ACCOUNT_OPTIONS = {
  accountLinking: {
    disableImplicitLinking: true,
  },
} as const

export function googleProviderOptions() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    prompt: "select_account" as const,
    disableImplicitSignUp: true,
  }
}

export function betterAuthBaseURL() {
  const rawAllowedHosts = process.env.BETTER_AUTH_ALLOWED_HOSTS
  const allowedHosts = rawAllowedHosts
    ?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)

  if (rawAllowedHosts?.trim() && !allowedHosts?.length) {
    throw new Error("BETTER_AUTH_ALLOWED_HOSTS must not be empty")
  }

  if (allowedHosts?.length) {
    if (
      allowedHosts.some((host) => {
        if (/[*?/@#]/.test(host)) return true
        const [hostname, port, ...extra] = host.split(":")
        return (
          extra.length > 0 ||
          hostname
            .split(".")
            .some(
              (label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
            ) ||
          (port !== undefined &&
            (!/^\d{1,5}$/.test(port) ||
              Number(port) < 1 ||
              Number(port) > 65535))
        )
      })
    ) {
      throw new Error(
        "BETTER_AUTH_ALLOWED_HOSTS must contain exact valid hostnames (no wildcards or URLs)",
      )
    }

    return {
      allowedHosts,
      protocol: process.env.NODE_ENV === "development" ? "http" : "https",
    } as const
  }

  return process.env.BETTER_AUTH_URL ?? "http://localhost:4000"
}
