import {
  CsvValidationError,
  parseWebsiteImportCsv,
  WEBSITE_IMPORT_HEADERS,
  websiteImportTemplateCsv,
} from "../website-import/csv-parser"

function row(overrides: Record<string, string> = {}) {
  return WEBSITE_IMPORT_HEADERS.map((header) => {
    const value =
      overrides[header] ??
      (header === "website_url" ? "https://example.com" : "")
    return value.includes(",") || value.includes('"') || value.includes("\n")
      ? `"${value.replace(/"/g, '""')}"`
      : value
  }).join(",")
}

describe("publisher website import CSV parser", () => {
  it("publishes the exact versioned header template", () => {
    expect(websiteImportTemplateCsv()).toBe(
      `${WEBSITE_IMPORT_HEADERS.join(",")}\r\n`,
    )
  })

  it("parses BOM, CRLF, embedded commas, escaped quotes, and line breaks", () => {
    const description = 'A useful, "quoted" description\nwith a second line'
    const csv = `\uFEFF${WEBSITE_IMPORT_HEADERS.join(",")}\r\n${row({
      description,
    })}\r\n`

    const result = parseWebsiteImportCsv(csv)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      rowNumber: 2,
      website_url: "https://example.com",
      description,
    })
  })

  it.each([
    ["unclosed quote", `${WEBSITE_IMPORT_HEADERS.join(",")}\n"broken`],
    ["NUL byte", `${WEBSITE_IMPORT_HEADERS.join(",")}\n${row()}\u0000`],
    [
      "wrong header order",
      `website_name,website_url\nname,https://example.com`,
    ],
    ["extra column", `${WEBSITE_IMPORT_HEADERS.join(",")}\n${row()},extra`],
  ])("rejects %s", (_label, csv) => {
    expect(() => parseWebsiteImportCsv(csv)).toThrow(CsvValidationError)
  })

  it("rejects more than 500 data rows before normalization", () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      row({ website_url: `https://example-${index}.com` }),
    )
    expect(() =>
      parseWebsiteImportCsv(
        `${WEBSITE_IMPORT_HEADERS.join(",")}\n${rows.join("\n")}`,
      ),
    ).toThrow("CSV may contain at most 500 rows")
  })
})
