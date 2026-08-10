import { createHash } from "node:crypto"
import type { FinancialDocumentSnapshot } from "@guestpost/shared"
import {
  type FinancialDocumentKind,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
} from "@guestpost/shared"
import {
  degrees,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib"

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 44
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const NAVY = rgb(0.058, 0.09, 0.165)
const VIOLET = rgb(0.486, 0.227, 0.929)
const SLATE = rgb(0.2, 0.255, 0.333)
const MUTED = rgb(0.392, 0.455, 0.545)
const BORDER = rgb(0.886, 0.91, 0.941)
const SURFACE = rgb(0.973, 0.98, 0.988)
const WHITE = rgb(1, 1, 1)

const TITLE: Record<FinancialDocumentKind, string> = {
  PAID_INVOICE: "PAID INVOICE",
  CREDIT_NOTE: "CREDIT NOTE",
  DEPOSIT_RECEIPT: "DEPOSIT RECEIPT",
}

export interface FinancialDocumentPdfRecord {
  id: string
  sequenceNumber: bigint | number | string
  kind: FinancialDocumentKind
  numberPrefix: string
  aggregateType: string
  aggregateId: string
  organizationId: string | null
  currency: string
  subtotal: { toString(): string } | string | number
  taxAmount: { toString(): string } | string | number
  total: { toString(): string } | string | number
  issuedAt: Date | string
  snapshot: unknown
}

export interface RenderedFinancialDocumentAttachment {
  content: Buffer
  filename: string
  contentType: "application/pdf"
  sha256: string
  size: number
  documentNumber: string
}

function decimalString(value: FinancialDocumentPdfRecord["subtotal"]): string {
  return typeof value === "object" ? value.toString() : String(value)
}

function minorUnits(value: string): bigint {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error("Financial document contains an invalid amount")
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))
}

function formatAmount(value: string, currency: string): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new Error("Financial document amount is not finite")
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numeric)
  } catch {
    return `${numeric.toFixed(2)} ${currency}`
  }
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word
      continue
    }
    let chunk = ""
    for (const character of word) {
      const candidateChunk = chunk + character
      if (font.widthOfTextAtSize(candidateChunk, size) > maxWidth && chunk) {
        lines.push(chunk)
        chunk = character
      } else {
        chunk = candidateChunk
      }
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : [""]
}

function drawWrappedText(input: {
  page: PDFPage
  text: string
  x: number
  y: number
  maxWidth: number
  font: PDFFont
  size: number
  color?: ReturnType<typeof rgb>
  lineHeight?: number
}): number {
  const lineHeight = input.lineHeight ?? input.size * 1.35
  const lines = wrapText(input.text, input.font, input.size, input.maxWidth)
  lines.forEach((line, index) => {
    input.page.drawText(line, {
      x: input.x,
      y: input.y - index * lineHeight,
      font: input.font,
      size: input.size,
      color: input.color ?? SLATE,
    })
  })
  return input.y - lines.length * lineHeight
}

function drawBrandHeader(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  title: string,
  documentNumber: string,
  continued = false,
): number {
  const [, height] = A4
  page.drawRectangle({
    x: 0,
    y: height - 92,
    width: A4[0],
    height: 92,
    color: NAVY,
  })
  page.drawRectangle({
    x: 0,
    y: height - 92,
    width: 9,
    height: 92,
    color: VIOLET,
  })
  page.drawText("GUESTPOST.CC", {
    x: MARGIN,
    y: height - 52,
    font: bold,
    size: 20,
    color: WHITE,
  })
  page.drawText("Content marketplace", {
    x: MARGIN,
    y: height - 70,
    font,
    size: 9,
    color: rgb(0.796, 0.835, 0.89),
  })
  const heading = continued ? `${title} - CONTINUED` : title
  const headingWidth = bold.widthOfTextAtSize(heading, 14)
  page.drawText(heading, {
    x: A4[0] - MARGIN - headingWidth,
    y: height - 47,
    font: bold,
    size: 14,
    color: WHITE,
  })
  const numberWidth = font.widthOfTextAtSize(documentNumber, 9)
  page.drawText(documentNumber, {
    x: A4[0] - MARGIN - numberWidth,
    y: height - 66,
    font,
    size: 9,
    color: rgb(0.796, 0.835, 0.89),
  })
  return height - 124
}

function partyLines(party: FinancialDocumentSnapshot["recipient"]): string[] {
  const cityLine = [party.city, party.region, party.postalCode]
    .filter(Boolean)
    .join(", ")
  return [
    party.legalName,
    party.addressLine1,
    party.addressLine2,
    cityLine || null,
    party.countryCode,
    party.billingEmail,
    party.taxIdType && party.taxId
      ? `${party.taxIdType}: ${party.taxId}`
      : null,
  ].filter((line): line is string => Boolean(line))
}

function drawPartyBlock(input: {
  page: PDFPage
  label: string
  party: FinancialDocumentSnapshot["recipient"]
  x: number
  y: number
  width: number
  font: PDFFont
  bold: PDFFont
}): void {
  input.page.drawText(input.label, {
    x: input.x,
    y: input.y,
    font: input.bold,
    size: 8,
    color: VIOLET,
  })
  let y = input.y - 19
  partyLines(input.party).forEach((line, index) => {
    const nextY = drawWrappedText({
      page: input.page,
      text: line,
      x: input.x,
      y,
      maxWidth: input.width,
      font: index === 0 ? input.bold : input.font,
      size: index === 0 ? 10.5 : 9,
      color: index === 0 ? NAVY : MUTED,
      lineHeight: 12,
    })
    y = nextY - 2
  })
}

function drawTableHeader(page: PDFPage, bold: PDFFont, y: number): number {
  page.drawRectangle({
    x: MARGIN,
    y: y - 22,
    width: A4[0] - MARGIN * 2,
    height: 26,
    color: NAVY,
  })
  page.drawText("DESCRIPTION", {
    x: MARGIN + 10,
    y: y - 13,
    font: bold,
    size: 8,
    color: WHITE,
  })
  page.drawText("QTY", { x: 381, y: y - 13, font: bold, size: 8, color: WHITE })
  page.drawText("AMOUNT", {
    x: 449,
    y: y - 13,
    font: bold,
    size: 8,
    color: WHITE,
  })
  return y - 35
}

function validateAccounting(input: {
  subtotal: string
  taxAmount: string
  total: string
  lineTotals: string[]
}): void {
  const subtotal = minorUnits(input.subtotal)
  const tax = minorUnits(input.taxAmount)
  const total = minorUnits(input.total)
  const itemTotal = input.lineTotals.reduce(
    (sum, amount) => sum + minorUnits(amount),
    0n,
  )
  if (subtotal + tax !== total || itemTotal !== subtotal) {
    throw new Error("Financial document totals do not reconcile")
  }
}

export async function renderFinancialDocumentPdf(
  record: FinancialDocumentPdfRecord,
): Promise<RenderedFinancialDocumentAttachment> {
  const snapshot = financialDocumentSnapshotSchema.parse(record.snapshot)
  const currency = record.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Financial document currency is invalid")
  }
  const subtotal = decimalString(record.subtotal)
  const taxAmount = decimalString(record.taxAmount)
  const total = decimalString(record.total)
  validateAccounting({
    subtotal,
    taxAmount,
    total,
    lineTotals: snapshot.lineItems.map((item) => item.lineTotal),
  })

  const documentNumber = formatFinancialDocumentNumber(record)
  const issuedAt = new Date(record.issuedAt)
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("Financial document issue date is invalid")
  }

  const pdf = await PDFDocument.create({ updateMetadata: false })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  pdf.setTitle(`${TITLE[record.kind]} ${documentNumber}`)
  pdf.setAuthor(snapshot.issuer.legalName)
  pdf.setSubject(`GuestPost.cc ${TITLE[record.kind].toLowerCase()}`)
  pdf.setKeywords(["GuestPost.cc", "financial document", record.kind])
  pdf.setCreator("GuestPost.cc communication worker")
  pdf.setProducer("GuestPost.cc")
  pdf.setCreationDate(issuedAt)
  pdf.setModificationDate(issuedAt)

  const pages: PDFPage[] = []
  let page = pdf.addPage(A4)
  pages.push(page)
  let y = drawBrandHeader(page, font, bold, TITLE[record.kind], documentNumber)

  if (snapshot.environment === "NON_PRODUCTION") {
    page.drawText("NON-PRODUCTION SAMPLE", {
      x: 151,
      y: 425,
      font: bold,
      size: 27,
      color: rgb(0.91, 0.925, 0.95),
      rotate: degrees(36),
    })
  }

  const status = snapshot.payment.status
  const meta = [
    ["ISSUE DATE", issuedAt.toISOString().slice(0, 10)],
    ["STATUS", status],
    ["CURRENCY", currency],
  ] as const
  meta.forEach(([label, value], index) => {
    const x = MARGIN + index * 169
    page.drawText(label, { x, y, font: bold, size: 7.5, color: MUTED })
    page.drawText(value, { x, y: y - 17, font: bold, size: 10, color: NAVY })
  })
  y -= 62

  page.drawRectangle({
    x: MARGIN,
    y: y - 121,
    width: A4[0] - MARGIN * 2,
    height: 135,
    color: SURFACE,
    borderColor: BORDER,
    borderWidth: 1,
  })
  drawPartyBlock({
    page,
    label: "FROM",
    party: snapshot.issuer,
    x: MARGIN + 16,
    y,
    width: 216,
    font,
    bold,
  })
  drawPartyBlock({
    page,
    label: "BILL TO",
    party: snapshot.recipient,
    x: 316,
    y,
    width: 216,
    font,
    bold,
  })
  y -= 158
  y = drawTableHeader(page, bold, y)

  for (const item of snapshot.lineItems) {
    const descriptionLines = wrapText(item.description, font, 9.5, 310)
    const rowHeight = Math.max(31, descriptionLines.length * 13 + 14)
    if (y - rowHeight < 190) {
      page = pdf.addPage(A4)
      pages.push(page)
      y = drawBrandHeader(
        page,
        font,
        bold,
        TITLE[record.kind],
        documentNumber,
        true,
      )
      y = drawTableHeader(page, bold, y)
    }
    page.drawRectangle({
      x: MARGIN,
      y: y - rowHeight + 7,
      width: A4[0] - MARGIN * 2,
      height: rowHeight,
      borderColor: BORDER,
      borderWidth: 1,
      color: WHITE,
    })
    descriptionLines.forEach((line, index) => {
      page.drawText(line, {
        x: MARGIN + 10,
        y: y - 10 - index * 13,
        font,
        size: 9.5,
        color: SLATE,
      })
    })
    page.drawText(String(item.quantity), {
      x: 390,
      y: y - 10,
      font,
      size: 9.5,
      color: SLATE,
    })
    const amount = formatAmount(item.lineTotal, currency)
    page.drawText(amount, {
      x: A4[0] - MARGIN - 10 - font.widthOfTextAtSize(amount, 9.5),
      y: y - 10,
      font,
      size: 9.5,
      color: SLATE,
    })
    y -= rowHeight
  }

  if (y < 230) {
    page = pdf.addPage(A4)
    pages.push(page)
    y = drawBrandHeader(
      page,
      font,
      bold,
      TITLE[record.kind],
      documentNumber,
      true,
    )
  }
  y -= 18

  const totals = [
    ["Subtotal", subtotal],
    [snapshot.tax.label, taxAmount],
    [record.kind === "CREDIT_NOTE" ? "Credit total" : "Total", total],
  ] as const
  totals.forEach(([label, amountValue], index) => {
    const strong = index === totals.length - 1
    const rowY = y - index * 25
    page.drawText(label, {
      x: 365,
      y: rowY,
      font: strong ? bold : font,
      size: strong ? 11 : 9.5,
      color: strong ? NAVY : MUTED,
    })
    const formatted = formatAmount(amountValue, currency)
    page.drawText(formatted, {
      x: A4[0] - MARGIN - font.widthOfTextAtSize(formatted, strong ? 11 : 9.5),
      y: rowY,
      font: strong ? bold : font,
      size: strong ? 11 : 9.5,
      color: strong ? NAVY : SLATE,
    })
  })
  y -= 92

  page.drawText("PAYMENT DETAILS", {
    x: MARGIN,
    y,
    font: bold,
    size: 8,
    color: VIOLET,
  })
  y = drawWrappedText({
    page,
    text: `${snapshot.payment.status} via ${snapshot.payment.method}${snapshot.payment.reference ? ` - ${snapshot.payment.reference}` : ""}`,
    x: MARGIN,
    y: y - 17,
    maxWidth: 490,
    font,
    size: 9,
    color: SLATE,
  })
  if (snapshot.relatedDocumentNumber) {
    y = drawWrappedText({
      page,
      text: `Related document: ${snapshot.relatedDocumentNumber}`,
      x: MARGIN,
      y: y - 5,
      maxWidth: 490,
      font,
      size: 9,
      color: SLATE,
    })
  }
  y = drawWrappedText({
    page,
    text: snapshot.tax.note,
    x: MARGIN,
    y: y - 8,
    maxWidth: 490,
    font,
    size: 8.5,
    color: MUTED,
  })
  for (const note of snapshot.notes) {
    y = drawWrappedText({
      page,
      text: note,
      x: MARGIN,
      y: y - 5,
      maxWidth: 490,
      font,
      size: 8.5,
      color: MUTED,
    })
  }

  pages.forEach((currentPage, index) => {
    currentPage.drawLine({
      start: { x: MARGIN, y: 45 },
      end: { x: A4[0] - MARGIN, y: 45 },
      color: BORDER,
      thickness: 1,
    })
    currentPage.drawText("Generated securely by GuestPost.cc", {
      x: MARGIN,
      y: 27,
      font,
      size: 7.5,
      color: MUTED,
    })
    const pageLabel = `Page ${index + 1} of ${pages.length}`
    currentPage.drawText(pageLabel, {
      x: A4[0] - MARGIN - font.widthOfTextAtSize(pageLabel, 7.5),
      y: 27,
      font,
      size: 7.5,
      color: MUTED,
    })
  })

  const bytes = await pdf.save({
    addDefaultPage: false,
    useObjectStreams: false,
  })
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("Financial document PDF is empty or exceeds the size limit")
  }
  const content = Buffer.from(bytes)
  return {
    content,
    filename: `${documentNumber}.pdf`,
    contentType: "application/pdf",
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
    documentNumber,
  }
}
