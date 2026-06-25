import { Decimal } from "@prisma/client/runtime/client"
import { normalizeDomain } from "../domain"
import { splitPlatformFee } from "../platform-fee"

describe("splitPlatformFee", () => {
  it("fee + net always equals gross exactly", () => {
    const cases: Array<[string, number]> = [
      ["100", 0.2],
      ["33.33", 0.2],
      ["0.01", 0.2],
      ["99999999.99", 0.175],
      ["10.10", 0.333],
      ["1", 0.015],
    ]
    for (const [gross, fraction] of cases) {
      const { fee, net } = splitPlatformFee(gross, fraction)
      expect(fee.plus(net).equals(new Decimal(gross))).toBe(true)
      expect(fee.greaterThanOrEqualTo(0)).toBe(true)
      expect(net.greaterThanOrEqualTo(0)).toBe(true)
    }
  })

  it("rounds the fee to cents", () => {
    const { fee } = splitPlatformFee("33.33", 0.2) // 6.666 → 6.67
    expect(fee.toFixed(2)).toBe("6.67")
  })

  it("avoids float drift (0.1 + 0.2 class errors)", () => {
    const { fee, net } = splitPlatformFee("0.30", 0.1)
    expect(fee.toFixed(2)).toBe("0.03")
    expect(net.toFixed(2)).toBe("0.27")
  })
})

describe("normalizeDomain", () => {
  it("collapses www/case/path/port variants to one key", () => {
    expect(normalizeDomain("https://www.Site.com/path?q=1")).toBe("site.com")
    expect(normalizeDomain("http://site.com")).toBe("site.com")
    expect(normalizeDomain("site.com/")).toBe("site.com")
    expect(normalizeDomain("https://SITE.COM:8080")).toBe("site.com")
    expect(normalizeDomain("https://blog.site.com")).toBe("blog.site.com")
  })

  it("rejects garbage", () => {
    expect(() => normalizeDomain("not a url")).toThrow()
    expect(() => normalizeDomain("localhost")).toThrow()
  })
})
