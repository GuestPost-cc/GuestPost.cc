export const WEBSITE_IMPORT_HEADERS = [
  "website_url",
  "website_name",
  "listing_title",
  "description",
  "country",
  "primary_language",
  "category_slugs",
  "sports_gaming_allowed",
  "pharmacy_allowed",
  "crypto_allowed",
  "backlink_count",
  "link_type",
  "link_validity",
  "google_news",
  "marked_sponsored",
  "foreign_language_allowed",
  "ahrefs_organic_traffic",
  "ahrefs_traffic_as_of",
  "moz_domain_authority",
  "moz_da_as_of",
  "service_type",
  "service_price",
  "currency",
  "turnaround_days",
  "revision_rounds",
  "warranty_days",
] as const

export type WebsiteImportHeader = (typeof WEBSITE_IMPORT_HEADERS)[number]
export type WebsiteImportCsvRow = Record<WebsiteImportHeader, string> & {
  rowNumber: number
}

const MAX_ROWS = 500
const MAX_CELL_LENGTH = 10_000

export class CsvValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CsvValidationError"
  }
}

// Small strict RFC 4180 parser. It rejects ambiguous quote usage and enforces
// limits while scanning, before row data can consume unbounded memory.
export function parseWebsiteImportCsv(input: string): WebsiteImportCsvRow[] {
  const source = input.replace(/^\uFEFF/, "")
  if (source.includes("\u0000")) {
    throw new CsvValidationError("CSV contains a NUL character")
  }

  const table: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  let quoteClosed = false

  const pushCell = () => {
    if (cell.length > MAX_CELL_LENGTH) {
      throw new CsvValidationError(
        `CSV cell exceeds ${MAX_CELL_LENGTH.toLocaleString()} characters`,
      )
    }
    row.push(cell)
    cell = ""
    quoteClosed = false
  }
  const pushRow = () => {
    pushCell()
    if (row.some((value) => value.length > 0)) table.push(row)
    row = []
    if (table.length > MAX_ROWS + 1) {
      throw new CsvValidationError(`CSV may contain at most ${MAX_ROWS} rows`)
    }
  }

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index++
        } else {
          quoted = false
          quoteClosed = true
        }
      } else {
        cell += char
      }
      continue
    }

    if (quoteClosed && char !== "," && char !== "\r" && char !== "\n") {
      throw new CsvValidationError(
        "Unexpected character after a closing CSV quote",
      )
    }
    if (char === '"') {
      if (cell.length > 0) {
        throw new CsvValidationError("Quote found inside an unquoted CSV cell")
      }
      quoted = true
    } else if (char === ",") {
      pushCell()
    } else if (char === "\n") {
      pushRow()
    } else if (char === "\r") {
      if (source[index + 1] === "\n") index++
      pushRow()
    } else {
      cell += char
    }
  }
  if (quoted) throw new CsvValidationError("CSV contains an unclosed quote")
  if (cell.length > 0 || row.length > 0) pushRow()
  if (table.length < 2) {
    throw new CsvValidationError(
      "CSV must contain a header and at least one row",
    )
  }

  const headers = table[0].map((header) => header.trim())
  const duplicateHeaders = headers.filter(
    (header, index) => headers.indexOf(header) !== index,
  )
  if (duplicateHeaders.length > 0) {
    throw new CsvValidationError(
      `CSV contains duplicate headers: ${[...new Set(duplicateHeaders)].join(", ")}`,
    )
  }
  if (
    headers.length !== WEBSITE_IMPORT_HEADERS.length ||
    headers.some((header, index) => header !== WEBSITE_IMPORT_HEADERS[index])
  ) {
    throw new CsvValidationError(
      "CSV headers must exactly match the current website import template",
    )
  }

  return table.slice(1).map((values, rowIndex) => {
    if (values.length !== WEBSITE_IMPORT_HEADERS.length) {
      throw new CsvValidationError(
        `Row ${rowIndex + 2} has ${values.length} columns; expected ${WEBSITE_IMPORT_HEADERS.length}`,
      )
    }
    const result = { rowNumber: rowIndex + 2 } as WebsiteImportCsvRow
    WEBSITE_IMPORT_HEADERS.forEach((header, index) => {
      result[header] = values[index].trim()
    })
    return result
  })
}

export function websiteImportTemplateCsv(): string {
  return `${WEBSITE_IMPORT_HEADERS.join(",")}\r\n`
}
