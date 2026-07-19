import { ForbiddenException } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"
import { CsrfMiddleware } from "../middleware/csrf.middleware"

describe("CsrfMiddleware", () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN
  let middleware: CsrfMiddleware
  let next: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    process.env.CORS_ORIGIN =
      "https://app.example.com,https://publisher.example.com"
    middleware = new CsrfMiddleware()
    next = jest.fn()
  })

  afterAll(() => {
    process.env.CORS_ORIGIN = originalCorsOrigin
  })

  function request(overrides: Partial<Request>): Request {
    return {
      method: "POST",
      path: "/api/v1/orders",
      headers: {},
      ...overrides,
    } as Request
  }

  const response = {} as Response

  it("allows safe methods", () => {
    middleware.use(request({ method: "GET" }), response, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it("defers Better Auth routes to Better Auth's own CSRF checks", () => {
    middleware.use(request({ path: "/api/v1/auth/sign-out" }), response, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it("allows requests that do not carry a browser session cookie", () => {
    middleware.use(request({}), response, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it("allows a protected same-site mutation from an exact trusted origin", () => {
    middleware.use(
      request({
        headers: {
          cookie: "__Secure-guestpost.session_token=signed",
          origin: "https://app.example.com",
          "sec-fetch-site": "same-site",
          "x-csrf-protection": "1",
        },
      }),
      response,
      next,
    )
    expect(next).toHaveBeenCalledTimes(1)
  })

  it("rejects a cookie-authenticated mutation without the custom header", () => {
    expect(() =>
      middleware.use(
        request({
          headers: {
            cookie: "__Secure-guestpost.session_token=signed",
            origin: "https://app.example.com",
            "sec-fetch-site": "same-site",
          },
        }),
        response,
        next,
      ),
    ).toThrow(ForbiddenException)
  })

  it("rejects an untrusted or cross-site origin even with the custom header", () => {
    expect(() =>
      middleware.use(
        request({
          headers: {
            cookie: "__Secure-guestpost.session_token=signed",
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
            "x-csrf-protection": "1",
          },
        }),
        response,
        next,
      ),
    ).toThrow(ForbiddenException)
  })

  it("does not treat a bearer header as a CSRF bypass", () => {
    expect(() =>
      middleware.use(
        request({
          headers: {
            authorization: "Bearer legacy-token",
            cookie: "__Secure-guestpost.session_token=signed",
            origin: "https://app.example.com",
          },
        }),
        response,
        next,
      ),
    ).toThrow(ForbiddenException)
  })
})
