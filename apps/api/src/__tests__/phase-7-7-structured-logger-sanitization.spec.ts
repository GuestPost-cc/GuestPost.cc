// Phase 7.7 B — structured-logger context sanitization (audit #31).
//
// Tests the serialization safety layer added to the structured logger:
//   - Circular-reference detection via ancestor-stack (not WeakSet)
//   - Error serialization with truncated stack + simplified cause
//   - Long string truncation
//   - Context size budget enforcement with __logTruncated metadata
//   - Pretty-mode equivalents
//
// The replacer and truncation helpers are internal to the module; every
// test exercises them through the public createLogger() API by spying
// on process.stdout / process.stderr.

describe("Phase 7.7 B — structured logger context sanitization (audit #31)", () => {
  let writeStdout: jest.SpyInstance
  let writeStderr: jest.SpyInstance

  beforeEach(() => {
    process.env.NODE_ENV = "production"
    process.env.LOG_FORMAT = "json"
    writeStdout = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true)
    writeStderr = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
  })

  afterEach(() => {
    writeStdout.mockRestore()
    writeStderr.mockRestore()
    delete process.env.NODE_ENV
    delete process.env.LOG_FORMAT
  })

  function jsonRecord(): Record<string, unknown> {
    const line = (writeStdout.mock.calls[0][0] as string).trim()
    return JSON.parse(line)
  }

  // ── Cycle detection ────────────────────────────────────────────────

  it("handles direct circular reference (obj.self = obj)", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const cyclic: Record<string, unknown> = { name: "root" }
    cyclic.self = cyclic

    createLogger("api.test").info("cycle", { cyclic })
    const record = jsonRecord()
    expect((record.cyclic as any).name).toBe("root")
    expect((record.cyclic as any).self).toBe("[Circular]")
  })

  it("handles indirect cycle (a.child = b; b.parent = a)", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const a: Record<string, unknown> = { name: "a" }
    const b: Record<string, unknown> = { name: "b" }
    a.child = b
    b.parent = a

    createLogger("api.test").info("indirect", { a })
    const record = jsonRecord()
    expect((record.a as any).child.parent).toBe("[Circular]")
    expect((record.a as any).name).toBe("a")
  })

  it("preserves shared references (a: obj, b: obj — not circular)", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const shared = { x: 1 }

    createLogger("api.test").info("shared", { a: shared, b: shared })
    const record = jsonRecord()
    expect((record.a as any).x).toBe(1)
    expect((record.b as any).x).toBe(1)
    // Neither value should be "[Circular]" — shared refs are NOT cycles
    expect(JSON.stringify(record.a)).not.toContain("[Circular]")
    expect(JSON.stringify(record.b)).not.toContain("[Circular]")
  })

  it("handles self-referential array", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const arr: unknown[] = [1, 2]
    arr.push(arr)

    createLogger("api.test").info("arr cycle", { arr })
    const record = jsonRecord()
    expect((record.arr as any[])[0]).toBe(1)
    expect((record.arr as any[])[1]).toBe(2)
    expect((record.arr as any[])[2]).toBe("[Circular]")
  })

  it("serializes nested shared refs normally (a.inner = shared; b = shared)", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const shared = { deep: true }

    createLogger("api.test").info("nested shared", {
      a: { inner: shared },
      b: shared,
    })
    const record = jsonRecord()
    expect((record.a as any).inner.deep).toBe(true)
    expect((record.b as any).deep).toBe(true)
  })

  // ── Error serialization ───────────────────────────────────────────

  it("serializes Error with name, message, and truncated stack", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const err = new Error("boom")

    createLogger("api.test").info("failed", { err })
    const record = jsonRecord()
    expect((record.err as any).name).toBe("Error")
    expect((record.err as any).message).toBe("boom")
    expect(typeof (record.err as any).stack).toBe("string")
  })

  it("serializes Error with cause", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const inner = new Error("inner failure")
    const outer = new Error("outer failure", { cause: inner })

    createLogger("api.test").info("wrapped", { err: outer })
    const record = jsonRecord()
    expect((record.err as any).message).toBe("outer failure")
    // cause rendered as message string, not nested Error
    expect((record.err as any).cause).toBe("inner failure")
  })

  it("includes code when Error has a numeric code", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    class CodeError extends Error {
      code: number
      constructor(msg: string, code: number) {
        super(msg)
        this.code = code
      }
    }

    createLogger("api.test").info("code err", {
      err: new CodeError("bad", 422),
    })
    const record = jsonRecord()
    expect((record.err as any).code).toBe(422)
  })

  // ── String truncation ─────────────────────────────────────────────

  it("truncates long string values in context", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const long = "x".repeat(5000)

    createLogger("api.test").info("long string", { payload: long })
    const record = jsonRecord()
    expect((record.payload as string).length).toBeLessThan(long.length)
    expect(record.payload as string).toMatch(/\.\.\. \[truncated\]$/)
  })

  // ── Context budget ────────────────────────────────────────────────

  it("drops fields when context exceeds 8KB budget and reports __logTruncated", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    // Each entry is ~600 bytes; 20 entries = ~12KB, well over 8KB budget
    const big: Record<string, string> = {}
    for (let i = 0; i < 20; i++) {
      big[`key${i}`] = "word ".repeat(100)
    }

    createLogger("api.test").info("oversized", big)
    const record = jsonRecord()
    expect(record.__logTruncated).toBeDefined()
    expect((record.__logTruncated as any).droppedFields).toBeGreaterThan(0)
    expect((record.__logTruncated as any).maxBytes).toBe(8192)
    // Some fields should still be present
    expect(record.key0).toBeDefined()
  })

  it("passes small context through unchanged", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )

    createLogger("api.test").info("small", { a: 1, b: "hello", c: true })
    const record = jsonRecord()
    expect(record.__logTruncated).toBeUndefined()
    expect(record.a).toBe(1)
    expect(record.b).toBe("hello")
    expect(record.c).toBe(true)
  })

  // ── Pretty mode ───────────────────────────────────────────────────

  it("pretty mode handles circular reference without throwing", async () => {
    jest.resetModules()
    delete process.env.LOG_FORMAT
    delete process.env.NODE_ENV
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const cyclic: Record<string, unknown> = { name: "root" }
    cyclic.self = cyclic

    expect(() => {
      createLogger("svc").info("cycle in pretty", { cyclic })
    }).not.toThrow()
    const output = writeStdout.mock.calls[0][0] as string
    expect(output).toContain("[Circular]")
  })

  // ── Combined edge cases ───────────────────────────────────────────

  it("handles combo: cycle + Error + large value in one call", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const cyclic: Record<string, unknown> = { tag: "loop" }
    cyclic.self = cyclic
    const err = new Error("kaboom")
    const big = "x".repeat(5000)

    expect(() => {
      createLogger("api.test").info("combo", {
        cyclic,
        err,
        payload: big,
      })
    }).not.toThrow()
    const record = jsonRecord()
    // Circular
    expect((record.cyclic as any).self).toBe("[Circular]")
    // Error
    expect((record.err as any).message).toBe("kaboom")
    // Truncated string
    expect((record.payload as string).length).toBeLessThan(5000)
    expect(record.payload as string).toMatch(/\.\.\. \[truncated\]$/)
  })

  it("stacks truncate to at most 2048 characters", async () => {
    jest.resetModules()
    const { createLogger } = await import(
      "@guestpost/shared/dist/observability/structured-logger"
    )
    const err = new Error("long stack")
    const manyLines: string[] = []
    for (let i = 0; i < 100; i++) {
      manyLines.push(`    at fn${i} (file.ts:${i}:1)`)
    }
    err.stack = `Error: long stack\n${manyLines.join("\n")}`

    createLogger("api.test").info("deep stack", { err })
    const record = jsonRecord()
    expect((record.err as any).stack.length).toBeLessThanOrEqual(2100)
    expect((record.err as any).stack).toMatch(/\.\.\. \[truncated\]$/)
  })
})
