import {
  createPrismaAdapter,
  PRISMA_POOL_MAX_DEFAULT,
  parsePoolMax,
} from "@guestpost/database"

describe("PRISMA_POOL_MAX validation", () => {
  it("defaults when env var is unset", () => {
    expect(parsePoolMax(undefined)).toBe(PRISMA_POOL_MAX_DEFAULT)
  })

  it("accepts valid positive integers", () => {
    expect(parsePoolMax("10")).toBe(10)
    expect(parsePoolMax("25")).toBe(25)
    expect(parsePoolMax("1")).toBe(1)
    expect(parsePoolMax("100")).toBe(100)
  })

  it("rejects non-integer strings", () => {
    expect(() => parsePoolMax("abc")).toThrow(/PRISMA_POOL_MAX/)
    expect(() => parsePoolMax("3.5")).toThrow(/PRISMA_POOL_MAX/)
    expect(() => parsePoolMax("")).toThrow(/PRISMA_POOL_MAX/)
  })

  it("rejects zero and negative values", () => {
    expect(() => parsePoolMax("0")).toThrow(/PRISMA_POOL_MAX/)
    expect(() => parsePoolMax("-1")).toThrow(/PRISMA_POOL_MAX/)
    expect(() => parsePoolMax("-999")).toThrow(/PRISMA_POOL_MAX/)
  })
})

describe("createPrismaAdapter pool warning", () => {
  let warnSpy: jest.SpyInstance
  const BASE_URL = "postgresql://test:test@localhost:5432/test_jest_default"

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    process.env.DATABASE_URL = BASE_URL
  })

  afterEach(() => {
    warnSpy.mockRestore()
    delete process.env.PRISMA_POOL_MAX
  })

  it("does not warn when max is within the recommended bound (25)", () => {
    delete process.env.PRISMA_POOL_MAX
    createPrismaAdapter({ max: 25 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("warns when max exceeds the recommended bound (26)", () => {
    delete process.env.PRISMA_POOL_MAX
    createPrismaAdapter({ max: 26 })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain("exceeds the recommended")
  })

  it("warns when PRISMA_POOL_MAX env var exceeds bound", () => {
    process.env.PRISMA_POOL_MAX = "100"
    createPrismaAdapter()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain("exceeds the recommended")
  })

  it("does not warn when PRISMA_POOL_MAX env var is within bound", () => {
    process.env.PRISMA_POOL_MAX = "15"
    createPrismaAdapter()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
