// Jest-only stub for better-auth's ESM modules.
//
// Better Auth ships ESM (.mjs) and Jest's CJS loader can't require it.
// The api jest config moduleNameMapper redirects `@guestpost/auth` to
// its TypeScript source, which transitively `import`s `better-auth`,
// `better-auth/adapters/prisma`, `better-auth/plugins/bearer`,
// `better-auth/node`, and `better-auth/api` — every one of which
// would crash the test loader.
//
// These stubs implement only the surface our code touches at module
// load time. Identity for `createAuthMiddleware` matches the v1.6.14
// runtime (verified during Phase 7.8 pre-impl: createAuthMiddleware
// is essentially a passthrough wrapper). The rest return empty
// objects since they're only constructed at module load, never
// invoked by unit tests.

export const betterAuth = () => ({
  api: {},
  handler: () => undefined,
})

export const prismaAdapter = () => ({})
export const bearer = () => ({})
export const toNodeHandler = (x: unknown) => x
export const createAuthMiddleware = (fn: unknown) => fn
export const getOAuthState = async () => null

export class APIError extends Error {
  body: Record<string, unknown>
  status: string

  constructor(status: string, body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : status)
    this.status = status
    this.body = body
  }

  static from(status: string, body: Record<string, unknown>) {
    return new APIError(status, body)
  }
}
