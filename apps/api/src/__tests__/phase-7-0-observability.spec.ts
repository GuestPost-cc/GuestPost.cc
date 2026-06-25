// Phase 7.0 — Observability primitives unit tests
//
// Tests live here (in apps/api) because that's where jest is configured.
// All three primitives ship in packages/shared/src/observability.

import {
  buildBeforeSend,
  buildStartupConfig,
  initSentry,
  logSentryStartup,
  REDACTED_KEYS,
  RUNTIME_TAGS,
  redactSensitiveData,
  type SentryRuntimeTag,
  type SentryScopeLike,
  setBusinessContext,
} from "@guestpost/shared"
// Deep import — request-context uses node:async_hooks; not in the shared
// browser-safe barrel.
import {
  generateRequestId,
  getRequestId,
  isValidRequestId,
  requireRequestId,
  runWithRequestId,
} from "@guestpost/shared/dist/observability/request-context"

describe("Phase 7.0 — sentry-init", () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("RUNTIME_TAGS includes all 14 expected values", () => {
    const expected: SentryRuntimeTag[] = [
      "api",
      "worker",
      "portal-client",
      "portal-server",
      "portal-edge",
      "publisher-client",
      "publisher-server",
      "publisher-edge",
      "admin-client",
      "admin-server",
      "admin-edge",
      "website-client",
      "website-server",
      "website-edge",
    ]
    expect([...RUNTIME_TAGS].sort()).toEqual([...expected].sort())
  })

  it("buildStartupConfig throws on invalid runtime tag", () => {
    expect(() =>
      buildStartupConfig({
        runtime: "web-client" as unknown as SentryRuntimeTag,
      }),
    ).toThrow(/invalid runtime tag/)
  })

  it("buildStartupConfig resolves DSN from SENTRY_DSN for backend runtimes", () => {
    process.env.SENTRY_DSN = "https://test@sentry.example/1"
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const config = buildStartupConfig({ runtime: "api" })
    expect(config.dsn).toBe("https://test@sentry.example/1")
  })

  it("buildStartupConfig prefers NEXT_PUBLIC_SENTRY_DSN for -client / -edge runtimes", () => {
    process.env.SENTRY_DSN = "https://backend@sentry.example/1"
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://frontend@sentry.example/2"
    const config = buildStartupConfig({ runtime: "portal-client" })
    expect(config.dsn).toBe("https://frontend@sentry.example/2")
  })

  it("buildStartupConfig resolves release from GIT_COMMIT_SHA", () => {
    process.env.GIT_COMMIT_SHA = "abc1234"
    const config = buildStartupConfig({ runtime: "api" })
    expect(config.release).toBe("abc1234")
  })

  it("buildStartupConfig resolves environment from SENTRY_ENVIRONMENT, falls back to NODE_ENV", () => {
    process.env.SENTRY_ENVIRONMENT = "staging"
    expect(buildStartupConfig({ runtime: "api" }).environment).toBe("staging")
    delete process.env.SENTRY_ENVIRONMENT
    process.env.NODE_ENV = "production"
    expect(buildStartupConfig({ runtime: "api" }).environment).toBe(
      "production",
    )
  })

  it("buildStartupConfig sets 10% sample rate in production, 100% in development", () => {
    delete process.env.SENTRY_ENVIRONMENT
    delete process.env.SENTRY_TRACES_SAMPLE_RATE
    process.env.NODE_ENV = "production"
    expect(buildStartupConfig({ runtime: "api" }).tracesSampleRate).toBe(0.1)
    process.env.NODE_ENV = "development"
    expect(buildStartupConfig({ runtime: "api" }).tracesSampleRate).toBe(1.0)
  })

  it("logSentryStartup logs '[SENTRY] disabled' when DSN unset", () => {
    delete process.env.SENTRY_DSN
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const logger = { log: jest.fn(), warn: jest.fn() }
    const config = buildStartupConfig({ runtime: "api" })
    logSentryStartup(config, logger)
    expect(logger.warn).toHaveBeenCalledWith(
      "[SENTRY] disabled (no DSN) runtime=api",
    )
    expect(logger.log).not.toHaveBeenCalled()
  })

  it("logSentryStartup logs '[SENTRY] enabled runtime=X release=Y environment=Z' when DSN set", () => {
    process.env.SENTRY_DSN = "https://test@sentry.example/1"
    process.env.GIT_COMMIT_SHA = "deadbeef"
    process.env.SENTRY_ENVIRONMENT = "production"
    const logger = { log: jest.fn(), warn: jest.fn() }
    const config = buildStartupConfig({ runtime: "worker" })
    logSentryStartup(config, logger)
    expect(logger.log).toHaveBeenCalledWith(
      "[SENTRY] enabled runtime=worker release=deadbeef environment=production",
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("initSentry is a no-op (does not call Sentry.init) when DSN unset", () => {
    delete process.env.SENTRY_DSN
    delete process.env.NEXT_PUBLIC_SENTRY_DSN
    const init = jest.fn()
    const logger = { log: jest.fn(), warn: jest.fn() }
    initSentry({ init }, { runtime: "api", logger })
    expect(init).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("initSentry calls Sentry.init with merged options when DSN set", () => {
    process.env.SENTRY_DSN = "https://test@sentry.example/1"
    process.env.GIT_COMMIT_SHA = "abc"
    process.env.SENTRY_ENVIRONMENT = "production"
    const init = jest.fn()
    initSentry(
      { init },
      {
        runtime: "api",
        logger: { log: jest.fn(), warn: jest.fn() },
        extra: { foo: "bar" },
      },
    )
    expect(init).toHaveBeenCalledTimes(1)
    const opts = init.mock.calls[0]?.[0] as Record<string, unknown>
    expect(opts.dsn).toBe("https://test@sentry.example/1")
    expect(opts.release).toBe("abc")
    expect(opts.environment).toBe("production")
    expect(opts.tracesSampleRate).toBe(0.1)
    expect(opts.foo).toBe("bar")
    expect(typeof opts.beforeSend).toBe("function")
  })
})

describe("Phase 7.0 — beforeSend redaction", () => {
  const beforeSend = buildBeforeSend()

  it("redacts each REDACTED_KEYS value to [REDACTED]", () => {
    const event = {
      extra: {
        password: "hunter2",
        accessToken: "tok_abc",
        refreshToken: "rt_abc",
        apiKey: "ak_abc",
        paymentMethod: "pm_abc",
        paymentMethodId: "pmid_abc",
        verificationToken: "dns_secret",
        encryptedPayload: "enc_blob",
        webhookSecret: "whsec_abc",
        signature: "sig_abc",
        // Non-redacted control: should pass through.
        orderId: "ord_123",
      },
    }
    const result = beforeSend(event) as { extra: Record<string, string> }
    for (const key of REDACTED_KEYS) {
      expect(result.extra[key]).toBe("[REDACTED]")
    }
    expect(result.extra.orderId).toBe("ord_123")
  })

  it("strips Authorization, Cookie, Set-Cookie headers (case-insensitive)", () => {
    const event = {
      request: {
        headers: {
          Authorization: "Bearer secret",
          cookie: "session=abc",
          "Set-Cookie": "refresh=xyz",
          "x-request-id": "req_abc",
        },
      },
    }
    const result = beforeSend(event) as {
      request: { headers: Record<string, string> }
    }
    expect(result.request.headers.Authorization).toBe("[REDACTED]")
    expect(result.request.headers.cookie).toBe("[REDACTED]")
    expect(result.request.headers["Set-Cookie"]).toBe("[REDACTED]")
    expect(result.request.headers["x-request-id"]).toBe("req_abc")
  })

  it("recurses into nested objects and arrays", () => {
    const event = {
      breadcrumbs: [
        { data: { password: "x", note: "ok" } },
        { data: { nested: { apiKey: "y" } } },
      ],
    }
    const result = beforeSend(event) as {
      breadcrumbs: Array<{ data: Record<string, unknown> }>
    }
    expect(result.breadcrumbs[0]?.data.password).toBe("[REDACTED]")
    expect(result.breadcrumbs[0]?.data.note).toBe("ok")
    expect(
      (result.breadcrumbs[1]?.data.nested as Record<string, string>).apiKey,
    ).toBe("[REDACTED]")
  })

  it("does not mutate the input event", () => {
    const event = { extra: { password: "x" } }
    redactSensitiveData(event)
    expect(event.extra.password).toBe("x")
  })

  it("handles null / undefined / primitives without throwing", () => {
    expect(redactSensitiveData(null)).toBeNull()
    expect(redactSensitiveData(undefined)).toBeUndefined()
    expect(redactSensitiveData("string")).toBe("string")
    expect(redactSensitiveData(42)).toBe(42)
  })
})

describe("Phase 7.0 — request-context (AsyncLocalStorage)", () => {
  it("getRequestId() returns null outside any frame", () => {
    expect(getRequestId()).toBeNull()
  })

  it("requireRequestId() throws outside any frame", () => {
    expect(() => requireRequestId()).toThrow(/requireRequestId/)
  })

  it("runWithRequestId() makes the ID visible inside the callback", () => {
    runWithRequestId("req-abc-123", () => {
      expect(getRequestId()).toBe("req-abc-123")
      expect(requireRequestId()).toBe("req-abc-123")
    })
  })

  it("frames do not leak to sibling callsites", () => {
    runWithRequestId("inside", () => {
      expect(getRequestId()).toBe("inside")
    })
    expect(getRequestId()).toBeNull()
  })

  it("isolates concurrent async frames", async () => {
    const observed: Array<{ id: string; observedAfterAwait: string | null }> =
      []
    await Promise.all([
      runWithRequestId("req-A", async () => {
        await new Promise((r) => setTimeout(r, 5))
        observed.push({ id: "A", observedAfterAwait: getRequestId() })
      }),
      runWithRequestId("req-B", async () => {
        await new Promise((r) => setTimeout(r, 2))
        observed.push({ id: "B", observedAfterAwait: getRequestId() })
      }),
    ])
    const a = observed.find((o) => o.id === "A")!
    const b = observed.find((o) => o.id === "B")!
    expect(a.observedAfterAwait).toBe("req-A")
    expect(b.observedAfterAwait).toBe("req-B")
  })

  it("nested runWithRequestId frames stack (inner shadows outer)", () => {
    runWithRequestId("outer", () => {
      expect(getRequestId()).toBe("outer")
      runWithRequestId("inner", () => {
        expect(getRequestId()).toBe("inner")
      })
      expect(getRequestId()).toBe("outer")
    })
  })

  it("generateRequestId() produces a UUIDv4-ish 36-char string", () => {
    const id = generateRequestId()
    expect(typeof id).toBe("string")
    expect(id.length).toBe(36)
    expect(/^[0-9a-f-]{36}$/i.test(id)).toBe(true)
  })

  describe("isValidRequestId — allowlist regex", () => {
    it("accepts UUIDv4", () => {
      expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(
        true,
      )
    })
    it("accepts UUIDv7", () => {
      expect(isValidRequestId("018f9c1d-7e3a-7000-8a00-1234567890ab")).toBe(
        true,
      )
    })
    it("accepts short trusted ID", () => {
      expect(isValidRequestId("test-12345")).toBe(true)
      expect(isValidRequestId("req_abc_def")).toBe(true)
    })
    it("accepts ULID-like", () => {
      expect(isValidRequestId("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true)
    })
    it("rejects empty string", () => {
      expect(isValidRequestId("")).toBe(false)
    })
    it("rejects control characters", () => {
      expect(isValidRequestId("bad\x00val")).toBe(false)
      expect(isValidRequestId("bad\x07")).toBe(false)
    })
    it("rejects newlines (log-poisoning attack)", () => {
      expect(isValidRequestId("x\n[SENTRY] release=fake")).toBe(false)
      expect(isValidRequestId("x\r")).toBe(false)
    })
    it("rejects non-ASCII", () => {
      expect(isValidRequestId("id-✓")).toBe(false)
      expect(isValidRequestId("id-中文")).toBe(false)
    })
    it("rejects overlong (>128)", () => {
      const long = "a".repeat(129)
      expect(isValidRequestId(long)).toBe(false)
    })
    it("accepts exactly 128 chars", () => {
      const max = "a".repeat(128)
      expect(isValidRequestId(max)).toBe(true)
    })
    it("rejects non-string types", () => {
      expect(isValidRequestId(null)).toBe(false)
      expect(isValidRequestId(undefined)).toBe(false)
      expect(isValidRequestId(123)).toBe(false)
      expect(isValidRequestId({})).toBe(false)
    })
    it("rejects characters outside the allowlist", () => {
      expect(isValidRequestId("has space")).toBe(false)
      expect(isValidRequestId("has.dot")).toBe(false)
      expect(isValidRequestId("has/slash")).toBe(false)
      expect(isValidRequestId("has?query")).toBe(false)
    })
  })
})

describe("Phase 7.0 — business-context", () => {
  let scope: SentryScopeLike & { tags: Record<string, unknown> }

  beforeEach(() => {
    const tags: Record<string, unknown> = {}
    scope = {
      tags,
      setTag(key, value) {
        tags[key] = value
        return scope
      },
    }
  })

  it("sets only defined string/number/boolean fields", () => {
    setBusinessContext(scope, {
      userType: "CUSTOMER",
      orderId: "ord_abc",
      fulfillmentChannel: "PLATFORM",
      // undefined / null should be skipped
      ticketId: undefined,
      staffRole: undefined,
    })
    expect(scope.tags).toEqual({
      userType: "CUSTOMER",
      orderId: "ord_abc",
      fulfillmentChannel: "PLATFORM",
    })
  })

  it("does not throw on empty context", () => {
    expect(() => setBusinessContext(scope, {})).not.toThrow()
    expect(scope.tags).toEqual({})
  })

  it("is idempotent — second call overwrites prior tags", () => {
    setBusinessContext(scope, { orderId: "ord_1" })
    setBusinessContext(scope, { orderId: "ord_2", ticketId: "tk_1" })
    expect(scope.tags).toEqual({ orderId: "ord_2", ticketId: "tk_1" })
  })

  it("ignores fields whose value is null", () => {
    setBusinessContext(scope, {
      userType: "STAFF",
      staffRole: null as unknown as string,
    })
    expect(scope.tags).toEqual({ userType: "STAFF" })
  })
})
