import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { PDFDocument, PDFHexString, PDFPage } from "pdf-lib"
import {
  formatFinancialDocumentAmount,
  renderFinancialDocumentPdf,
  resolveFinancialDocumentBidiRuns,
} from "../src/lib/financial-document-pdf"

const snapshot = {
  schemaVersion: 1 as const,
  environment: "PRODUCTION" as const,
  issuer: {
    legalName: "GuestPost.cc Inc.",
    billingEmail: "billing@guestpost.cc",
    addressLine1: "100 Marketplace Avenue",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
    taxIdType: "EIN",
    taxId: "12-3456789",
  },
  recipient: {
    legalName: "Acme Content Ltd.",
    billingEmail: "accounts@acme.example",
    addressLine1: "42 Editorial Road",
    city: "London",
    postalCode: "EC1A 1BB",
    countryCode: "GB",
    taxIdType: "VAT",
    taxId: "GB123456789",
  },
  lineItems: [
    {
      description: "Guest Post service",
      quantity: 1,
      unitAmount: "425.00",
      lineTotal: "425.00",
    },
  ],
  payment: {
    status: "PAID" as const,
    method: "GuestPost.cc wallet",
    reference: "Order order-123",
  },
  tax: {
    label: "Tax",
    treatment: "NOT_SEPARATELY_CHARGED" as const,
    note: "No tax was separately charged on this document.",
  },
  notes: [],
}

const record = {
  id: "document-1",
  sequenceNumber: 42n,
  kind: "PAID_INVOICE" as const,
  numberPrefix: "GP",
  aggregateType: "Order",
  aggregateId: "order-123",
  organizationId: "org-1",
  currency: "USD",
  subtotal: "425.00",
  taxAmount: "0.00",
  total: "425.00",
  issuedAt: new Date("2026-08-10T12:00:00.000Z"),
  snapshot,
}

function ppmPixels(buffer: Buffer): {
  width: number
  height: number
  pixels: Buffer
} {
  let offset = 0
  const nextToken = (): string => {
    while (offset < buffer.length) {
      const byte = buffer[offset]!
      if (byte === 35) {
        while (offset < buffer.length && buffer[offset] !== 10) offset += 1
      } else if (byte === 9 || byte === 10 || byte === 13 || byte === 32) {
        offset += 1
      } else {
        break
      }
    }
    const start = offset
    while (
      offset < buffer.length &&
      ![9, 10, 13, 32].includes(buffer[offset]!)
    ) {
      offset += 1
    }
    return buffer.subarray(start, offset).toString("ascii")
  }

  assert.equal(nextToken(), "P6")
  const width = Number(nextToken())
  const height = Number(nextToken())
  assert.equal(nextToken(), "255")
  while ([9, 10, 13, 32].includes(buffer[offset]!)) offset += 1
  const pixels = buffer.subarray(offset)
  assert.equal(pixels.length, width * height * 3)
  return { width, height, pixels }
}

function darkPixelBounds(input: {
  width: number
  height: number
  pixels: Buffer
  x: number
  y: number
  cropWidth: number
  cropHeight: number
}): {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
  maximumInternalColumnGap: number
} | null {
  const right = Math.min(input.width, input.x + input.cropWidth)
  const bottom = Math.min(input.height, input.y + input.cropHeight)
  let minX = right
  let maxX = -1
  let minY = bottom
  let maxY = -1
  const occupiedColumns = new Set<number>()
  for (let y = input.y; y < bottom; y += 1) {
    for (let x = input.x; x < right; x += 1) {
      const offset = (y * input.width + x) * 3
      if (
        input.pixels[offset]! < 180 &&
        input.pixels[offset + 1]! < 180 &&
        input.pixels[offset + 2]! < 180
      ) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
        occupiedColumns.add(x)
      }
    }
  }
  if (maxX < minX || maxY < minY) return null

  let maximumInternalColumnGap = 0
  let currentGap = 0
  for (let x = minX; x <= maxX; x += 1) {
    if (occupiedColumns.has(x)) {
      maximumInternalColumnGap = Math.max(maximumInternalColumnGap, currentGap)
      currentGap = 0
    } else {
      currentGap += 1
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    maximumInternalColumnGap,
  }
}

function darkRowBands(input: {
  width: number
  height: number
  pixels: Buffer
  x: number
  y: number
  cropWidth: number
  cropHeight: number
}): Array<{ start: number; end: number; height: number }> {
  const right = Math.min(input.width, input.x + input.cropWidth)
  const bottom = Math.min(input.height, input.y + input.cropHeight)
  const occupiedRows: number[] = []
  for (let y = input.y; y < bottom; y += 1) {
    let occupied = false
    for (let x = input.x; x < right; x += 1) {
      const offset = (y * input.width + x) * 3
      if (
        input.pixels[offset]! < 180 &&
        input.pixels[offset + 1]! < 180 &&
        input.pixels[offset + 2]! < 180
      ) {
        occupied = true
        break
      }
    }
    if (occupied) occupiedRows.push(y)
  }

  const bands: Array<{ start: number; end: number; height: number }> = []
  for (const row of occupiedRows) {
    const previous = bands.at(-1)
    if (previous && previous.end + 1 === row) {
      previous.end = row
      previous.height += 1
    } else {
      bands.push({ start: row, end: row, height: 1 })
    }
  }
  return bands
}

function actualTextHex(text: string): string {
  return PDFHexString.fromText(text).toString()
}

function actualTextFromOperator(operator: string): string | null {
  const match = /\/ActualText <([0-9A-F]+)>/.exec(operator)
  return match ? PDFHexString.of(match[1]!).decodeText() : null
}

test("renders a deterministic, bounded branded invoice PDF", async () => {
  const first = await renderFinancialDocumentPdf(record)
  const second = await renderFinancialDocumentPdf(record)
  assert.equal(first.filename, "GP-INV-2026-00000042.pdf")
  assert.equal(first.contentType, "application/pdf")
  assert.equal(first.content.subarray(0, 5).toString(), "%PDF-")
  assert.ok(first.size > 1_000)
  assert.ok(first.size < 5 * 1024 * 1024)
  assert.equal(first.sha256, second.sha256)
  assert.deepEqual(first.content, second.content)

  const parsed = await PDFDocument.load(first.content)
  assert.equal(parsed.getPageCount(), 1)
  assert.equal(parsed.getTitle(), "PAID INVOICE GP-INV-2026-00000042")
  assert.equal(parsed.getAuthor(), "GuestPost.cc Inc.")
})

test("resolves mixed Arabic, Latin identifiers, digits, and dates with UAX #9 levels", () => {
  const runs = resolveFinancialDocumentBidiRuns(
    "فاتورة INV-2026-42 ضريبة 15 USD بتاريخ 2026-08-10",
  )

  assert.deepEqual(runs, [
    { text: "2026-08-10", direction: "LTR" },
    { text: " بتاريخ ", direction: "RTL" },
    { text: "USD", direction: "LTR" },
    { text: " ", direction: "RTL" },
    { text: "15", direction: "LTR" },
    { text: " ضريبة ", direction: "RTL" },
    { text: "INV-2026-42", direction: "LTR" },
    { text: "فاتورة ", direction: "RTL" },
  ])
  assert.equal(
    runs.find((run) => run.text === "INV-2026-42")?.text,
    "INV-2026-42",
  )
  assert.equal(runs.find((run) => run.text === "15")?.direction, "LTR")
  assert.equal(runs.find((run) => run.text === "2026-08-10")?.direction, "LTR")
})

test("formats legal amounts above Number.MAX_SAFE_INTEGER without rounding", async () => {
  const exact = "9007199254740993.00"
  const exactUnit = "3002399751580331.00"
  assert.equal(
    formatFinancialDocumentAmount(exact, "USD"),
    "$9,007,199,254,740,993.00",
  )

  const rendered = await renderFinancialDocumentPdf({
    ...record,
    sequenceNumber: 45n,
    subtotal: exact,
    total: exact,
    snapshot: {
      ...snapshot,
      lineItems: [
        {
          description: "Exact-value financial service",
          quantity: 3,
          unitAmount: exactUnit,
          lineTotal: exact,
        },
      ],
    },
  })
  assert.ok(rendered.size > 1_000)
  assert.ok(rendered.size < 5 * 1024 * 1024)

  const extractorCheck = spawnSync("pdftotext", ["-v"], { encoding: "utf8" })
  if (extractorCheck.error && process.env.CI) throw extractorCheck.error
  if (!extractorCheck.error) {
    const directory = await mkdtemp(join(tmpdir(), "guestpost-pdf-amount-"))
    try {
      const pdfPath = join(directory, "exact-amount.pdf")
      await writeFile(pdfPath, rendered.content)
      const extracted = spawnSync("pdftotext", [pdfPath, "-"], {
        encoding: "utf8",
      })
      assert.equal(extracted.status, 0, extracted.stderr)
      assert.match(extracted.stdout, /\$9,007,199,254,740,993\.00/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test("rejects a line total that does not equal exact unit amount times quantity", async () => {
  await assert.rejects(
    () =>
      renderFinancialDocumentPdf({
        ...record,
        subtotal: "1.00",
        total: "1.00",
        snapshot: {
          ...snapshot,
          lineItems: [
            {
              description: "Inconsistent quantity",
              quantity: 2,
              unitAmount: "1.00",
              lineTotal: "1.00",
            },
          ],
        },
      }),
    /line total does not match unit amount and quantity/,
  )
})

test("rejects non-reconciling totals before rendering", async () => {
  await assert.rejects(
    () => renderFinancialDocumentPdf({ ...record, total: "424.99" }),
    /totals do not reconcile/,
  )
})

test("paginates long invoices without dropping line items", async () => {
  const lineItems = Array.from({ length: 25 }, (_, index) => ({
    description: `Guest Post placement service ${index + 1}`,
    quantity: 1,
    unitAmount: "100.00",
    lineTotal: "100.00",
  }))
  const rendered = await renderFinancialDocumentPdf({
    ...record,
    sequenceNumber: 43n,
    subtotal: "2500.00",
    total: "2500.00",
    snapshot: { ...snapshot, lineItems },
  })
  const parsed = await PDFDocument.load(rendered.content)
  assert.equal(parsed.getPageCount(), 3)
})

test("watermarks every page of a non-production multipage document", async () => {
  const lineItems = Array.from({ length: 25 }, (_, index) => ({
    description: `Non-production placement service ${index + 1}`,
    quantity: 1,
    unitAmount: "100.00",
    lineTotal: "100.00",
  }))
  const watermarkedPages = new Set<PDFPage>()
  const originalDrawText = PDFPage.prototype.drawText
  PDFPage.prototype.drawText = function (text, options) {
    if (text === "NON-PRODUCTION SAMPLE") watermarkedPages.add(this)
    return originalDrawText.call(this, text, options)
  }

  let rendered: Awaited<ReturnType<typeof renderFinancialDocumentPdf>>
  try {
    rendered = await renderFinancialDocumentPdf({
      ...record,
      sequenceNumber: 47n,
      subtotal: "2500.00",
      total: "2500.00",
      snapshot: {
        ...snapshot,
        environment: "NON_PRODUCTION",
        lineItems,
      },
    })
  } finally {
    PDFPage.prototype.drawText = originalDrawText
  }

  const parsed = await PDFDocument.load(rendered.content)
  assert.ok(parsed.getPageCount() > 1)
  assert.equal(watermarkedPages.size, parsed.getPageCount())
})

test("renders multilingual legal names without a StandardFont glyph failure", async () => {
  const rendered = await renderFinancialDocumentPdf({
    ...record,
    sequenceNumber: 44n,
    snapshot: {
      ...snapshot,
      issuer: {
        ...snapshot.issuer,
        legalName: "ООО ГестПост Маркетплейс",
        addressLine1: "Тестовая улица 100",
        city: "Москва",
        region: null,
        postalCode: "101000",
        countryCode: "RU",
      },
      recipient: {
        ...snapshot.recipient,
        legalName: "株式会社ゲストポスト東京",
        addressLine1: "示例内容市场 北京市朝阳区",
        addressLine2: "게스트포스트 주식회사 서울특별시",
        city: "Пример Москва",
        region: "شركة دبي",
      },
      lineItems: [
        {
          description: "株式会社ゲストポスト - ゲスト投稿",
          quantity: 1,
          unitAmount: "100.00",
          lineTotal: "100.00",
        },
        {
          description: "示例内容市场 - 客座文章",
          quantity: 1,
          unitAmount: "125.00",
          lineTotal: "125.00",
        },
        {
          description: "게스트포스트 주식회사 - 게시물 게재",
          quantity: 1,
          unitAmount: "200.00",
          lineTotal: "200.00",
        },
      ],
      notes: [
        "কোনো কর আলাদাভাবে নেওয়া হয়নি।",
        "Примечание: документ проверен.",
        "فاتورة INV-2026-42 ضريبة 15 USD بتاريخ 2026-08-10",
        "Unsupported historic script remains auditable: 𐍈",
      ],
    },
  })

  assert.equal(rendered.filename, "GP-INV-2026-00000044.pdf")
  assert.ok(rendered.size > 1_000)
  assert.ok(rendered.size < 5 * 1024 * 1024)
  const parsed = await PDFDocument.load(rendered.content)
  assert.equal(parsed.getPageCount(), 1)
  assert.equal(parsed.getAuthor(), "ООО ГестПост Маркетплейс")
})

test("Poppler visibly rasterizes every supported dynamic script", async (t) => {
  const rendererCheck = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" })
  if (rendererCheck.error) {
    if (process.env.CI) throw rendererCheck.error
    t.skip("pdftoppm is required for the release raster gate")
    return
  }

  const arabicParty = "شركة‌ضيافةالمحتوى"
  const bengaliTaxNote = "ক্‍ষ কোনো কর আলাদাভাবে নেওয়া হয়নি।"
  const arabicMixed = "فاتورة INV-2026-42 ضريبة 15 USD بتاريخ 2026-08-10"
  const actualTextOperators: string[] = []
  const originalPushOperators = PDFPage.prototype.pushOperators
  PDFPage.prototype.pushOperators = function (...operators) {
    actualTextOperators.push(
      ...operators.map((operator) => operator.toString()),
    )
    return originalPushOperators.call(this, ...operators)
  }

  let rendered: Awaited<ReturnType<typeof renderFinancialDocumentPdf>>
  try {
    rendered = await renderFinancialDocumentPdf({
      ...record,
      sequenceNumber: 48n,
      snapshot: {
        ...snapshot,
        issuer: {
          ...snapshot.issuer,
          legalName: "ОООГестПостМаркетплейс",
          addressLine1: arabicParty,
          city: "ঢাকাবাংলাদেশ",
          region: null,
          postalCode: "১২০৫",
          countryCode: "BD",
        },
        recipient: {
          ...snapshot.recipient,
          legalName: "株式会社ゲストポスト東京",
          addressLine1: "示例内容市场北京市朝阳区",
          addressLine2: "게스트포스트주식회사서울특별시",
        },
        tax: {
          ...snapshot.tax,
          note: bengaliTaxNote,
        },
        notes: [
          arabicMixed,
          "Unsupported historic script remains auditable: 𐍈",
        ],
      },
    })
  } finally {
    PDFPage.prototype.pushOperators = originalPushOperators
  }
  const actualTextContent = actualTextOperators.join("\n")
  const decodedActualText = actualTextOperators
    .map(actualTextFromOperator)
    .filter((text): text is string => text !== null)
  assert.match(actualTextContent, new RegExp(actualTextHex(arabicParty)))
  assert.match(actualTextContent, new RegExp(actualTextHex(bengaliTaxNote)))
  assert.match(actualTextContent, new RegExp(actualTextHex(arabicMixed)))
  assert.ok(decodedActualText.some((text) => text.includes("[U+10348]")))
  assert.ok(decodedActualText.every((text) => !text.includes("𐍈")))

  const directory = await mkdtemp(join(tmpdir(), "guestpost-pdf-raster-"))
  try {
    const pdfPath = join(directory, "multilingual.pdf")
    const outputPrefix = join(directory, "party-lines")
    await writeFile(pdfPath, rendered.content)
    const rasterized = spawnSync(
      "pdftoppm",
      [
        "-f",
        "1",
        "-l",
        "1",
        "-singlefile",
        "-r",
        "72",
        "-x",
        "50",
        "-y",
        "195",
        "-W",
        "490",
        "-H",
        "55",
        pdfPath,
        outputPrefix,
      ],
      { encoding: "utf8" },
    )
    assert.equal(rasterized.status, 0, rasterized.stderr)
    const image = ppmPixels(await readFile(`${outputPrefix}.ppm`))
    const scriptLines = [
      ["Cyrillic", 10, 6, 110, 170, 4],
      ["Arabic", 10, 20, 65, 130, 30],
      ["Bengali", 10, 34, 55, 130, 8],
      ["Japanese", 266, 6, 105, 145, 6],
      ["Simplified Chinese", 266, 20, 95, 135, 6],
      ["Korean", 266, 34, 115, 160, 6],
    ] as const
    for (const [
      script,
      x,
      y,
      minimumWidth,
      maximumWidth,
      maximumGap,
    ] of scriptLines) {
      const bounds = darkPixelBounds({
        ...image,
        x,
        y,
        cropWidth: 216,
        cropHeight: 13,
      })
      assert.ok(bounds, `${script} raster line is blank`)
      assert.ok(
        bounds.width >= minimumWidth,
        `${script} raster span is truncated (${bounds.width}px)`,
      )
      assert.ok(
        bounds.width <= maximumWidth,
        `${script} raster span exceeds its layout (${bounds.width}px)`,
      )
      assert.ok(
        bounds.maximumInternalColumnGap <= maximumGap,
        `${script} raster has a missing-glyph gap (${bounds.maximumInternalColumnGap}px)`,
      )
    }

    const fonts = spawnSync("pdffonts", [pdfPath], { encoding: "utf8" })
    assert.equal(fonts.status, 0, fonts.stderr)
    assert.match(fonts.stdout, /Helvetica/)
    assert.match(fonts.stdout, /Helvetica-Bold/)
    assert.doesNotMatch(fonts.stdout, /Noto|CID TrueType|Type 0/i)

    const extracted = spawnSync("pdftotext", ["-raw", pdfPath, "-"], {
      encoding: "utf8",
    })
    assert.equal(extracted.status, 0, extracted.stderr)
    assert.match(extracted.stdout, /株式会社ゲストポスト東京/)
    assert.match(extracted.stdout, /示例内容市场北京市朝阳区/)
    assert.match(extracted.stdout, /게스트포스트주식회사서울특별시/)
    assert.match(extracted.stdout, new RegExp(bengaliTaxNote))
    assert.match(extracted.stdout, /INV-2026-42/)
    assert.match(extracted.stdout, /2026-08-10/)
    assert.match(extracted.stdout, /\$425\.00/)
    assert.match(extracted.stdout, /\[U\+10348\]/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("hard wrapping preserves complex-script grapheme clusters", async () => {
  const grapheme = "ক্‍ষ"
  const longWord = grapheme.repeat(40)
  const capturedActualText: string[] = []
  const originalPushOperators = PDFPage.prototype.pushOperators
  PDFPage.prototype.pushOperators = function (...operators) {
    for (const operator of operators) {
      const actualText = actualTextFromOperator(operator.toString())
      if (actualText !== null) capturedActualText.push(actualText)
    }
    return originalPushOperators.call(this, ...operators)
  }

  try {
    await renderFinancialDocumentPdf({
      ...record,
      sequenceNumber: 49n,
      snapshot: {
        ...snapshot,
        lineItems: [
          {
            description: longWord,
            quantity: 1,
            unitAmount: "425.00",
            lineTotal: "425.00",
          },
        ],
      },
    })
  } finally {
    PDFPage.prototype.pushOperators = originalPushOperators
  }

  const fragments = capturedActualText.filter((text) => text.includes("ক"))
  assert.ok(fragments.length > 1, "complex-script word was not hard wrapped")
  assert.equal(fragments.join(""), longWord)
  for (const fragment of fragments) {
    assert.doesNotMatch(fragment, /^[\p{M}\u200C\u200D]/u)
    assert.doesNotMatch(fragment, /[\u200C\u200D]$/u)
  }
})

test("paginates schema-boundary Unicode parties and details above every footer", async (t) => {
  const repeatTo = (value: string, length: number) =>
    Array.from(
      { length },
      (_, index) => Array.from(value)[index % Array.from(value).length],
    ).join("")
  const maxParty = {
    legalName: repeatTo("شركة株式会社Пример", 160),
    billingEmail: `${"a".repeat(63)}@${"b".repeat(63)}.${"c".repeat(63)}.example`,
    addressLine1: repeatTo("العنوان示例", 160),
    addressLine2: repeatTo("추가주소Пример", 160),
    city: repeatTo("مدينة東京", 100),
    region: repeatTo("منطقة서울", 100),
    postalCode: repeatTo("郵便123", 32),
    countryCode: "JP",
    taxIdType: repeatTo("税معرف", 32),
    taxId: repeatTo("税-15-معرف", 64),
  }
  const lineItems = Array.from({ length: 25 }, (_, index) => ({
    description: `${index + 1} ${repeatTo("فاتورة株式会社게시물Пример", 150)}`,
    quantity: 1,
    unitAmount: "1.00",
    lineTotal: "1.00",
  }))
  const rendered = await renderFinancialDocumentPdf({
    ...record,
    sequenceNumber: 46n,
    subtotal: "25.00",
    total: "25.00",
    snapshot: {
      ...snapshot,
      issuer: { ...maxParty, billingEmail: null },
      recipient: maxParty,
      lineItems,
      payment: {
        status: "PAID",
        method: repeatTo("محفظةWallet", 64),
        reference: repeatTo("INV-2026-فاتورة-15", 96),
      },
      tax: {
        ...snapshot.tax,
        label: repeatTo("ضريبةTax", 32),
        note: repeatTo("ملاحظة税금Примечание", 240),
      },
      notes: Array.from({ length: 5 }, () =>
        repeatTo("فاتورة INV-42 ضريبة 15 株式会社 게시물 Примечание ", 240),
      ),
    },
  })

  const parsed = await PDFDocument.load(rendered.content)
  assert.ok(parsed.getPageCount() >= 5)
  assert.ok(rendered.size < 5 * 1024 * 1024)

  const rendererCheck = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" })
  if (rendererCheck.error) {
    if (process.env.CI) throw rendererCheck.error
    t.diagnostic("pdftoppm unavailable; schema-boundary raster gate skipped")
    return
  }

  const directory = await mkdtemp(join(tmpdir(), "guestpost-pdf-boundary-"))
  try {
    const pdfPath = join(directory, "boundary.pdf")
    const outputPrefix = join(directory, "boundary")
    await writeFile(pdfPath, rendered.content)
    const rasterized = spawnSync(
      "pdftoppm",
      ["-r", "72", pdfPath, outputPrefix],
      { encoding: "utf8" },
    )
    assert.equal(rasterized.status, 0, rasterized.stderr)

    const pageImages = await Promise.all(
      Array.from({ length: parsed.getPageCount() }, async (_, index) =>
        ppmPixels(await readFile(`${outputPrefix}-${index + 1}.ppm`)),
      ),
    )
    const pageText = Array.from(
      { length: parsed.getPageCount() },
      (_, index) => {
        const extracted = spawnSync(
          "pdftotext",
          [
            "-f",
            String(index + 1),
            "-l",
            String(index + 1),
            "-raw",
            pdfPath,
            "-",
          ],
          { encoding: "utf8" },
        )
        assert.equal(extracted.status, 0, extracted.stderr)
        return extracted.stdout
      },
    )
    for (const [index, image] of pageImages.entries()) {
      const footerSafetyGap = darkPixelBounds({
        ...image,
        x: 44,
        y: 776,
        cropWidth: 507,
        cropHeight: 18,
      })
      assert.equal(
        footerSafetyGap,
        null,
        `page ${index + 1} content overlaps the footer safety gap`,
      )
    }

    const partyBands = darkRowBands({
      ...pageImages[0]!,
      x: 60,
      y: 200,
      cropWidth: 475,
      cropHeight: 460,
    })
    assert.ok(partyBands.length >= 20, "schema-boundary party text is missing")
    assert.ok(
      Math.max(...partyBands.map((band) => band.height)) <= 36,
      "schema-boundary party rows collapse into each other",
    )

    const finalPage = pageImages.at(-1)!
    const detailBands = darkRowBands({
      ...finalPage,
      x: 44,
      y: 330,
      cropWidth: 507,
      cropHeight: 440,
    })
    assert.ok(detailBands.length >= 10, "schema-boundary details are missing")
    assert.ok(
      Math.max(...detailBands.map((band) => band.height)) <= 13,
      "schema-boundary payment or note lines overlap vertically",
    )
    assert.match(pageText.at(-1)!, /INV-42/)

    const totalsPageIndex = pageText.findIndex(
      (text) => (text.match(/Tax/g) ?? []).length >= 3,
    )
    assert.notEqual(
      totalsPageIndex,
      -1,
      "schema-boundary totals page is missing",
    )
    const totalsPage = pageImages[totalsPageIndex]!
    const totalsColumnGap = darkPixelBounds({
      ...totalsPage,
      x: 504,
      y: 225,
      cropWidth: 12,
      cropHeight: 105,
    })
    assert.equal(
      totalsColumnGap,
      null,
      "schema-boundary tax label overlaps its reserved amount column gap",
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("renders each bundled international font family independently", async (t) => {
  const scripts = [
    ["Japanese", "株式会社ゲストポスト東京"],
    ["Japanese service", "株式会社ゲストポスト - ゲスト投稿"],
    ["Simplified Chinese", "示例内容市场 北京市朝阳区"],
    ["Simplified Chinese service", "示例内容市场 - 客座文章"],
    ["Korean", "게스트포스트 주식회사 서울특별시"],
    ["Korean service", "게스트포스트 주식회사 - 게시물 게재"],
    ["Cyrillic", "Пример Москва"],
    ["Cyrillic note", "Примечание: документ проверен."],
    ["Arabic", "شركة دبي"],
    ["Arabic note", "ملاحظة: تم الاستلام بنجاح."],
    ["Bengali", "অতিথি নিবন্ধ ঢাকা"],
    ["Bengali note", "কোনো কর আলাদাভাবে নেওয়া হয়নি।"],
  ] as const

  for (const [name, legalName] of scripts) {
    await t.test(name, async () => {
      const rendered = await renderFinancialDocumentPdf({
        ...record,
        sequenceNumber: 50n,
        snapshot: {
          ...snapshot,
          recipient: { ...snapshot.recipient, legalName },
        },
      })
      assert.ok(rendered.size > 1_000)
    })
  }
})
