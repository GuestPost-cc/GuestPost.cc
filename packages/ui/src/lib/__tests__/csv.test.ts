/**
 * downloadCsv is the single CSV export path for every app — its formula
 * injection neutralization is a security control, so it gets exact tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { downloadCsv } from "../csv"

function captureCsv(): { get: () => string } {
  let captured = ""
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      void blob.text().then((t) => (captured = t))
      // jsdom Blob.text is async; we read it synchronously via FileReaderSync
      // alternative — instead, stash the blob and read in the getter
      ;(globalThis as any).__lastBlob = blob
      return "blob:test"
    },
    revokeObjectURL: () => {},
  })
  return {
    get: () => captured,
  }
}

describe("downloadCsv", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ""
  })

  async function run(header: string[], rows: unknown[][]) {
    captureCsv()
    const click = vi.fn()
    const origCreate = document.createElement.bind(document)
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag)
      if (tag === "a") (el as HTMLAnchorElement).click = click
      return el
    })
    downloadCsv("t.csv", header, rows as any)
    expect(click).toHaveBeenCalledOnce()
    const blob: Blob = (globalThis as any).__lastBlob
    return blob.text()
  }

  it("quotes cells and escapes embedded quotes", async () => {
    const csv = await run(["a"], [['say "hi"']])
    expect(csv).toBe('"a"\n"say ""hi"""')
  })

  it("neutralizes formula-injection prefixes (= + - @ tab CR)", async () => {
    const csv = await run(["v"], [["=HYPERLINK(1)"], ["+1"], ["-1"], ["@cmd"], ["\tx"], ["\rx"]])
    for (const line of csv.split("\n").slice(1)) {
      expect(line.startsWith("\"'")).toBe(true)
    }
  })

  it("leaves benign values untouched", async () => {
    const csv = await run(["v"], [["hello"], [42], [null], [undefined]])
    expect(csv.split("\n").slice(1)).toEqual(['"hello"', '"42"', '""', '""'])
  })
})
