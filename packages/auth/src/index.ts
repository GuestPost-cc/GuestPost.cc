import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { bearer } from "better-auth/plugins/bearer"
import { prisma } from "@guestpost/database"
import { toNodeHandler } from "better-auth/node"

export { toNodeHandler }

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:4000",
  basePath: "/api/v1/auth",
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  magicLink: {
    enabled: true,
  },
  trustedOrigins: process.env.NODE_ENV === "production"
    ? (process.env.TRUSTED_ORIGINS?.split(",") ?? [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://localhost:3003",
        "http://localhost:4000",
      ])
    : ((req: any) => {
        const origin = req?.headers?.get?.("origin") || req?.headers?.origin
        return origin ? [origin, "http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003", "http://localhost:4000"] : [
          "http://localhost:3000",
          "http://localhost:3001",
          "http://localhost:3002",
          "http://localhost:3003",
          "http://localhost:4000",
        ]
      }) as any,
  advanced: {
    cookiePrefix: "guestpost",
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  plugins: [bearer()],
})
