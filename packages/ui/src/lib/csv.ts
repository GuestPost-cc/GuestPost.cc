// Client-side CSV download with spreadsheet-formula-injection neutralization
// (cells starting with = + - @ tab CR execute in Excel/Sheets — user-supplied
// strings like titles and reasons must never round-trip as formulas).
export function downloadCsv(
  filename: string,
  header: string[],
  rows: Array<Array<unknown>>,
) {
  const sanitize = (c: unknown) => {
    let s = String(c ?? "").replace(/"/g, '""')
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return `"${s}"`
  }
  const csv = [header, ...rows].map((r) => r.map(sanitize).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
