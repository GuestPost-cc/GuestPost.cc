// Phase 7.7 B — structured-logger unit tests.
//
// The logger module under test:
//   packages/shared/src/observability/structured-logger.ts
//
// Tests cover:
// - JSON mode emits valid JSON with the stable schema
//   (ts, level, service, environment, release, requestId, msg, ...ctx)
// - environment + release three-tier env resolution (SENTRY_* → NODE_ENV /
//   npm_package_version → fallback constant)
// - Pretty mode emits ANSI-colored single-line format with short rid suffix
// - getRequestId() integration via runWithRequestId wrapper
// - child() merges baseCtx
// - Stderr routing for warn/error vs stdout for debug/info

// We always set NODE_ENV=production + LOG_FORMAT=json so the default JSON
// shape is exercised. Individual tests use jest.resetModules + jest.doMock
// + lazy import to override env vars before the module's init-time constants
// resolve.

describe("Phase 7.7 B — structured logger JSON mode", () => {
  let writeStdout: jest.SpyInstance
  let writeStderr: jest.SpyInstance

  beforeEach(() => {
    process.env.NODE_ENV = "production"
    process.env.LOG_FORMAT = "json"
    writeStdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true)
    writeStderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    writeStdout.mockRestore()
    writeStderr.mockRestore()
    delete process.env.NODE_ENV
    delete process.env.LOG_FORMAT
    delete process.env.SENTRY_ENVIRONMENT
    delete process.env.SENTRY_RELEASE
    delete process.env.npm_package_version
  })

  it("emits valid JSON with all stable keys for info()", async () => {
    jest.resetModules()
    process.env.SENTRY_ENVIRONMENT = "production"
    process.env.SENTRY_RELEASE = "1.2.3"
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )

    const logger = createLogger("api.test")
    logger.info("hello world")

    expect(writeStdout).toHaveBeenCalledTimes(1)
    const line = (writeStdout.mock.calls[0][0] as string).trim()
    const record = JSON.parse(line)

    expect(record).toEqual(
      expect.objectContaining({
        level: "info",
        service: "api.test",
        environment: "production",
        release: "1.2.3",
        msg: "hello world",
      }),
    )
    // ts should parse as a valid ISO timestamp
    expect(new Date(record.ts).toISOString()).toBe(record.ts)
    // requestId is undefined (no ALS frame) — JSON.stringify omits undefined
    expect("requestId" in record).toBe(false)
  })

  it("merges call-site ctx into the record", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )

    createLogger("api.test").info("sweep complete", {
      runs_total: 42,
      scanned: 17,
    })
    const line = (writeStdout.mock.calls[0][0] as string).trim()
    const record = JSON.parse(line)

    expect(record).toEqual(expect.objectContaining({ runs_total: 42, scanned: 17 }))
  })

  it("child() merges baseCtx into every emit", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )

    const child = createLogger("worker.x").child({ category: "settlement" })
    child.info("step")
    const record = JSON.parse((writeStdout.mock.calls[0][0] as string).trim())

    expect(record).toEqual(
      expect.objectContaining({ service: "worker.x", category: "settlement" }),
    )
  })

  it("routes warn + error to stderr; debug + info to stdout", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const logger = createLogger("api.test")

    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    expect(writeStdout).toHaveBeenCalledTimes(2)
    expect(writeStderr).toHaveBeenCalledTimes(2)
  })

  it("injects requestId from runWithRequestId AsyncLocalStorage frame", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const { runWithRequestId } = await import(
      "@guestpost/shared/dist/observability/request-context"
    )

    const logger = createLogger("api.test")
    runWithRequestId("test-request-id-abc", () => {
      logger.info("inside frame")
    })

    const record = JSON.parse((writeStdout.mock.calls[0][0] as string).trim())
    expect(record.requestId).toBe("test-request-id-abc")
  })
})

describe("Phase 7.7 B — environment + release resolution (three-tier fallback)", () => {
  beforeEach(() => {
    delete process.env.SENTRY_ENVIRONMENT
    delete process.env.SENTRY_RELEASE
    delete process.env.NODE_ENV
    delete process.env.npm_package_version
  })

  it("environment prefers SENTRY_ENVIRONMENT over NODE_ENV", async () => {
    jest.resetModules()
    process.env.SENTRY_ENVIRONMENT = "staging"
    process.env.NODE_ENV = "production"
    const { __testGetEnvironment } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetEnvironment()).toBe("staging")
  })

  it("environment falls back to NODE_ENV when SENTRY_ENVIRONMENT unset", async () => {
    jest.resetModules()
    process.env.NODE_ENV = "production"
    const { __testGetEnvironment } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetEnvironment()).toBe("production")
  })

  it("environment final fallback is 'development'", async () => {
    jest.resetModules()
    const { __testGetEnvironment } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetEnvironment()).toBe("development")
  })

  it("release prefers SENTRY_RELEASE over npm_package_version", async () => {
    jest.resetModules()
    process.env.SENTRY_RELEASE = "v9.9.9"
    process.env.npm_package_version = "0.0.1"
    const { __testGetRelease } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetRelease()).toBe("v9.9.9")
  })

  it("release falls back to npm_package_version when SENTRY_RELEASE unset", async () => {
    jest.resetModules()
    process.env.npm_package_version = "0.7.7"
    const { __testGetRelease } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetRelease()).toBe("0.7.7")
  })

  it("release final fallback is 'unknown'", async () => {
    jest.resetModules()
    const { __testGetRelease } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    expect(__testGetRelease()).toBe("unknown")
  })
})

describe("Phase 7.7 B — pretty mode (NODE_ENV !== production && LOG_FORMAT !== json)", () => {
  let writeStdout: jest.SpyInstance

  beforeEach(() => {
    delete process.env.LOG_FORMAT
    delete process.env.NODE_ENV // pretty: !production
    writeStdout = jest.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    writeStdout.mockRestore()
    delete process.env.LOG_FORMAT
    delete process.env.NODE_ENV
  })

  it("emits ANSI-colored single-line format (not JSON)", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    createLogger("worker.x").info("hello", { k: 1 })
    const line = writeStdout.mock.calls[0][0] as string
    expect(line).toMatch(/\x1b\[36m\[INFO\]\x1b\[0m worker\.x hello \{"k":1\}/)
    // NOT valid JSON
    expect(() => JSON.parse(line.trim())).toThrow()
  })

  it("includes shortened rid= suffix when requestId is present", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const { runWithRequestId } = await import(
      "@guestpost/shared/dist/observability/request-context"
    )
    runWithRequestId("abcd1234deadbeef", () => {
      createLogger("svc").info("msg")
    })
    const line = writeStdout.mock.calls[0][0] as string
    expect(line).toContain(" rid=abcd1234 ") // first 8 chars
    expect(line).not.toContain("deadbeef") // remainder truncated
  })
})
