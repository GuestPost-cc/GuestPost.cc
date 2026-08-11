import "regenerator-runtime/runtime"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { FinancialDocumentSnapshot } from "@guestpost/shared"
import {
  type FinancialDocumentKind,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
} from "@guestpost/shared"
import fontkit, {
  type Font as FontkitFont,
  type Glyph as FontkitGlyph,
} from "@pdf-lib/fontkit"
import bidiFactory from "bidi-js"
import {
  degrees,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib"

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 44
const CONTENT_BOTTOM = 70
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const NAVY = rgb(0.058, 0.09, 0.165)
const VIOLET = rgb(0.486, 0.227, 0.929)
const SLATE = rgb(0.2, 0.255, 0.333)
const MUTED = rgb(0.392, 0.455, 0.545)
const BORDER = rgb(0.886, 0.91, 0.941)
const SURFACE = rgb(0.973, 0.98, 0.988)
const WHITE = rgb(1, 1, 1)
const bidi = bidiFactory()
const graphemeSegmenter = new Intl.Segmenter("und", {
  granularity: "grapheme",
})

type ComplexScriptFamily = "ARABIC" | "BENGALI" | "DEVANAGARI"

const STATIC_UNICODE_FONT_PATHS = [
  {
    path: require.resolve(
      "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf",
    ),
  },
  {
    path: require.resolve(
      "@expo-google-fonts/noto-sans-bengali/400Regular/NotoSansBengali_400Regular.ttf",
    ),
    scriptFamily: "BENGALI",
  },
  {
    path: require.resolve(
      "@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf",
    ),
    scriptFamily: "ARABIC",
  },
  {
    path: require.resolve(
      "@expo-google-fonts/noto-sans-devanagari/400Regular/NotoSansDevanagari_400Regular.ttf",
    ),
    scriptFamily: "DEVANAGARI",
  },
] as const
const CJK_FONT_PATHS = [
  {
    family: "SC",
    path: require.resolve(
      "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf",
    ),
  },
  {
    family: "JP",
    path: require.resolve(
      "@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf",
    ),
  },
  {
    family: "KR",
    path: require.resolve(
      "@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf",
    ),
  },
] as const

type CjkFamily = (typeof CJK_FONT_PATHS)[number]["family"]

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

interface UnicodePdfFont {
  shapingFont: FontkitFont
  extractionFont: PDFFont
  characters: ReadonlySet<number>
  cjkFamily?: CjkFamily
  scriptFamily?: ComplexScriptFamily
}

type UnicodePdfFonts = readonly UnicodePdfFont[]

interface UnicodeFontAsset {
  path: string
  bytes: Buffer
  shapingFont: FontkitFont
  characters: ReadonlySet<number>
  cjkFamily?: CjkFamily
  scriptFamily?: ComplexScriptFamily
}

interface FontRun {
  text: string
  font: UnicodePdfFont
  direction: "LTR" | "RTL"
}

export interface FinancialDocumentBidiRun {
  text: string
  direction: "LTR" | "RTL"
}

function parseFont(bytes: Uint8Array): FontkitFont {
  return fontkit.create(bytes)
}

const staticUnicodeFontAssets = Promise.all(
  STATIC_UNICODE_FONT_PATHS.map(
    async ({ path, ...metadata }): Promise<UnicodeFontAsset> => {
      const bytes = await readFile(path)
      const shapingFont = parseFont(bytes)
      return {
        path,
        bytes,
        shapingFont,
        characters: new Set(shapingFont.characterSet),
        ...metadata,
      }
    },
  ),
)

const cjkFontAssetPromises = new Map<CjkFamily, Promise<UnicodeFontAsset>>()

function cjkFontAsset(family: CjkFamily): Promise<UnicodeFontAsset> {
  const existing = cjkFontAssetPromises.get(family)
  if (existing) return existing
  const source = CJK_FONT_PATHS.find(
    (candidate) => candidate.family === family,
  )!
  const loading = readFile(source.path).then((bytes) => {
    const shapingFont = parseFont(bytes)
    return {
      path: source.path,
      bytes,
      shapingFont,
      characters: new Set(shapingFont.characterSet),
      cjkFamily: family,
    }
  })
  cjkFontAssetPromises.set(family, loading)
  return loading
}

async function loadUnicodeFonts(
  texts: readonly string[],
  extractionFont: PDFFont,
): Promise<UnicodePdfFonts> {
  const codePoints = new Set(
    texts.flatMap((text) => Array.from(text, (value) => value.codePointAt(0)!)),
  )
  const staticAssets = await staticUnicodeFontAssets
  const selected: UnicodeFontAsset[] = [staticAssets[0]!]
  for (const asset of staticAssets.slice(1)) {
    if (
      [...codePoints].some(
        (codePoint) => codePoint > 0x20 && asset.characters.has(codePoint),
      )
    ) {
      selected.push(asset)
    }
  }

  const selectedCjkFamilies = new Set<CjkFamily>()
  for (const text of texts) {
    const preferredFamily = preferredCjkFamily(text)
    if (preferredFamily) selectedCjkFamilies.add(preferredFamily)
  }
  for (const family of selectedCjkFamilies) {
    selected.push(await cjkFontAsset(family))
  }

  return selected.map((asset) => ({
    shapingFont: asset.shapingFont,
    extractionFont,
    characters: asset.characters,
    cjkFamily: asset.cjkFamily,
    scriptFamily: asset.scriptFamily,
  }))
}

function supportsText(font: UnicodePdfFont, text: string): boolean {
  return Array.from(text).every((character) =>
    font.characters.has(character.codePointAt(0)!),
  )
}

function renderableUnicodeText(text: string, fonts: UnicodePdfFonts): string {
  return Array.from(text, (character) => {
    if (fonts.some((font) => supportsText(font, character))) return character
    const codePoint = character.codePointAt(0)!
    return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
  }).join("")
}

function preferredCjkFamily(text: string): CjkFamily | undefined {
  if (
    /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/u.test(
      text,
    )
  ) {
    return "KR"
  }
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(text)) return "JP"
  if (/\p{Script=Han}/u.test(text)) return "SC"
  return undefined
}

function preferredComplexScript(text: string): ComplexScriptFamily | undefined {
  if (/\p{Script=Arabic}/u.test(text)) return "ARABIC"
  if (/\p{Script=Bengali}/u.test(text)) return "BENGALI"
  if (/\p{Script=Devanagari}/u.test(text)) return "DEVANAGARI"
  return undefined
}

function isRightToLeftText(text: string): boolean {
  const embedding = bidi.getEmbeddingLevels(text)
  return (embedding.paragraphs[0]?.level ?? 0) % 2 === 1
}

/**
 * Resolve Unicode Bidirectional Algorithm levels into visual-order runs while
 * preserving logical character order inside each run. Fontkit needs logical
 * RTL text to apply Arabic shaping; PDF placement needs the runs in visual
 * order. Reversing the raw string would break both contextual forms and mixed
 * Latin identifiers/dates.
 */
export function resolveFinancialDocumentBidiRuns(
  text: string,
): FinancialDocumentBidiRun[] {
  if (!text) return []
  // UAX #9 treats hyphens between digit-only segments as neutrals. In an RTL
  // paragraph that can visually reverse a legal date (`2026-08-10` becomes
  // `10-08-2026`). Isolate machine-readable ASCII identifiers, dates, URLs,
  // and email-like tokens as LTR units before resolving the surrounding text.
  // User-supplied bidi controls are rejected by the snapshot schema; these
  // internal isolates never enter the rendered or extraction layers.
  const isolatedText = text.replace(
    /[A-Za-z0-9]+(?:[-./:@_][A-Za-z0-9]+)+/g,
    (token) => `\u2066${token}\u2069`,
  )
  const embedding = bidi.getEmbeddingLevels(isolatedText)
  const logicalRuns: Array<{
    text: string
    level: number
    start: number
    end: number
  }> = []
  let offset = 0
  for (const character of Array.from(isolatedText)) {
    const start = offset
    offset += character.length
    const level = embedding.levels[start] ?? 0
    const previous = logicalRuns.at(-1)
    if (previous?.level === level && previous.end === start) {
      previous.text += character
      previous.end = offset
    } else {
      logicalRuns.push({ text: character, level, start, end: offset })
    }
  }

  const runByCodeUnit = new Array<number>(isolatedText.length)
  logicalRuns.forEach((run, runIndex) => {
    for (let index = run.start; index < run.end; index += 1) {
      runByCodeUnit[index] = runIndex
    }
  })
  const visualRunIndices: number[] = []
  const seen = new Set<number>()
  for (const codeUnitIndex of bidi.getReorderedIndices(
    isolatedText,
    embedding,
  )) {
    const runIndex = runByCodeUnit[codeUnitIndex]
    if (runIndex === undefined || seen.has(runIndex)) continue
    seen.add(runIndex)
    visualRunIndices.push(runIndex)
  }
  return visualRunIndices
    .map((runIndex) => {
      const run = logicalRuns[runIndex]!
      return {
        text: run.text.replace(/[\u2066\u2069]/g, ""),
        direction: run.level % 2 === 1 ? ("RTL" as const) : ("LTR" as const),
      }
    })
    .filter((run) => run.text.length > 0)
}

function logicalFontRuns(
  text: string,
  fonts: UnicodePdfFonts,
  direction: "LTR" | "RTL",
): FontRun[] {
  const runs: FontRun[] = []
  const cjkFamily = preferredCjkFamily(text)
  const scriptFamily = preferredComplexScript(text)
  for (const character of Array.from(text)) {
    const matchingFont =
      (cjkFamily
        ? fonts.find(
            (font) =>
              font.cjkFamily === cjkFamily && supportsText(font, character),
          )
        : undefined) ??
      fonts.find(
        (font) =>
          font.scriptFamily === scriptFamily && supportsText(font, character),
      ) ??
      fonts.find(
        (font) =>
          !font.cjkFamily &&
          !font.scriptFamily &&
          supportsText(font, character),
      ) ??
      fonts.find((font) => supportsText(font, character))
    const selected = matchingFont ?? fonts[0]!
    let rendered = character
    if (!matchingFont) {
      const codePoint = character.codePointAt(0)!
      // Preserve an auditable code-point marker rather than crashing the
      // financial email or silently dropping a legal-name character.
      rendered = `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
    }
    const previous = runs.at(-1)
    if (previous?.font === selected) previous.text += rendered
    else runs.push({ text: rendered, font: selected, direction })
  }
  return runs
}

function unicodeFontRuns(text: string, fonts: UnicodePdfFonts): FontRun[] {
  const renderableText = renderableUnicodeText(text, fonts)
  return resolveFinancialDocumentBidiRuns(renderableText).flatMap((bidiRun) => {
    const fontRuns = logicalFontRuns(bidiRun.text, fonts, bidiRun.direction)
    // A bidi run that needs multiple fallback fonts still has RTL visual
    // ordering between those fonts, while each shaped substring stays logical.
    return bidiRun.direction === "RTL" ? fontRuns.reverse() : fontRuns
  })
}

const glyphPathCache = new WeakMap<FontkitFont, Map<number, string>>()

function svgNumber(value: number): string {
  return String(Object.is(value, -0) ? 0 : value)
}

/**
 * FontKit exposes fully shaped glyph outlines, including the contextual forms
 * that PDF text operators cannot position correctly. pdf-lib flips SVG paths'
 * Y axis, so record the public FontKit Path callback with negated Y values and
 * the resulting PDF outline remains upright on the baseline.
 */
function visibleGlyphPath(font: FontkitFont, glyph: FontkitGlyph): string {
  let byGlyph = glyphPathCache.get(font)
  if (!byGlyph) {
    byGlyph = new Map()
    glyphPathCache.set(font, byGlyph)
  }
  const cached = byGlyph.get(glyph.id)
  if (cached !== undefined) return cached

  const commands: string[] = []
  glyph.path.toFunction()({
    moveTo(x: number, y: number) {
      commands.push(`M${svgNumber(x)} ${svgNumber(-y)}`)
    },
    lineTo(x: number, y: number) {
      commands.push(`L${svgNumber(x)} ${svgNumber(-y)}`)
    },
    quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
      commands.push(
        `Q${svgNumber(cpx)} ${svgNumber(-cpy)} ${svgNumber(x)} ${svgNumber(-y)}`,
      )
    },
    bezierCurveTo(
      cp1x: number,
      cp1y: number,
      cp2x: number,
      cp2y: number,
      x: number,
      y: number,
    ) {
      commands.push(
        `C${svgNumber(cp1x)} ${svgNumber(-cp1y)} ${svgNumber(cp2x)} ${svgNumber(-cp2y)} ${svgNumber(x)} ${svgNumber(-y)}`,
      )
    },
    closePath() {
      commands.push("Z")
    },
  })
  const path = commands.join("")
  byGlyph.set(glyph.id, path)
  return path
}

function shapedFontRun(run: FontRun, size: number) {
  const layout = run.font.shapingFont.layout(run.text)
  const scale = size / run.font.shapingFont.unitsPerEm
  const width = layout.positions.reduce(
    (sum, position) => sum + position.xAdvance * scale,
    0,
  )
  return { layout, scale, width }
}

function stringLeaves(input: unknown): string[] {
  if (typeof input === "string") return [input]
  if (Array.isArray(input)) return input.flatMap(stringLeaves)
  if (input && typeof input === "object") {
    return Object.values(input).flatMap(stringLeaves)
  }
  return []
}

function unicodeTextWidth(
  text: string,
  fonts: UnicodePdfFonts,
  size: number,
): number {
  return unicodeFontRuns(text, fonts).reduce(
    (width, run) => width + shapedFontRun(run, size).width,
    0,
  )
}

function drawUnicodeText(input: {
  page: PDFPage
  text: string
  x: number
  y: number
  fonts: UnicodePdfFonts
  size: number
  color: ReturnType<typeof rgb>
}): void {
  if (!input.text) return
  const actualText = renderableUnicodeText(input.text, input.fonts)
  const shapedRuns = unicodeFontRuns(actualText, input.fonts).map((run) => ({
    run,
    shaped: shapedFontRun(run, input.size),
  }))
  const visibleWidth = shapedRuns.reduce(
    (sum, current) => sum + current.shaped.width,
    0,
  )
  input.page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of("Span"),
      `<< /ActualText ${PDFHexString.fromText(actualText).toString()} >>`,
    ]),
  )
  // ActualText is ignored by common extractors when it wraps path-only
  // graphics. A transparent, StandardFont-safe text-showing proxy makes the
  // marked span searchable without reintroducing malformed Unicode subsets.
  // Match the proxy's horizontal extent to the visible outlines so selection
  // and layout extraction remain bound to the correct line/column.
  const proxy = "M".repeat(Math.max(1, Array.from(actualText).length))
  const extractionFont = input.fonts[0]!.extractionFont
  const proxyUnitWidth = extractionFont.widthOfTextAtSize(proxy, 1)
  input.page.drawText(proxy, {
    x: input.x,
    y: input.y,
    font: extractionFont,
    size: visibleWidth / proxyUnitWidth,
    color: input.color,
    opacity: 0,
  })
  let x = input.x
  for (const { run, shaped } of shapedRuns) {
    let penX = 0
    let penY = 0
    shaped.layout.glyphs.forEach((glyph, index) => {
      const position = shaped.layout.positions[index]!
      const path = visibleGlyphPath(run.font.shapingFont, glyph)
      if (path) {
        input.page.drawSvgPath(path, {
          x: x + (penX + position.xOffset) * shaped.scale,
          y: input.y + (penY + position.yOffset) * shaped.scale,
          scale: shaped.scale,
          color: input.color,
        })
      }
      penX += position.xAdvance
      penY += position.yAdvance
    })
    x += shaped.width
  }
  input.page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
}

function decimalString(value: FinancialDocumentPdfRecord["subtotal"]): string {
  return typeof value === "object" ? value.toString() : String(value)
}

function minorUnits(value: string): bigint {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error("Financial document contains an invalid amount")
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))
}

export function formatFinancialDocumentAmount(
  value: string,
  currency: string,
): string {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error("Financial document amount is invalid")
  const groupedInteger = match[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const exactAmount = `${groupedInteger}.${(match[2] ?? "").padEnd(2, "0")}`
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).formatToParts(0)
    const symbol = parts.find((part) => part.type === "currency")?.value
    const currencyBeforeNumber =
      parts.findIndex((part) => part.type === "currency") <
      parts.findIndex((part) => part.type === "integer")
    if (symbol) {
      return currencyBeforeNumber
        ? `${symbol}${exactAmount}`
        : `${exactAmount} ${symbol}`
    }
  } catch {
    // Fall through to the exact ISO-code representation for a currency the
    // current JavaScript runtime does not recognize.
  }
  return `${exactAmount} ${currency}`
}

function wrapText(
  text: string,
  fonts: UnicodePdfFonts,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (unicodeTextWidth(candidate, fonts, size) <= maxWidth) {
      line = candidate
      continue
    }
    if (line) lines.push(line)
    if (unicodeTextWidth(word, fonts, size) <= maxWidth) {
      line = word
      continue
    }
    let chunk = ""
    for (const { segment } of graphemeSegmenter.segment(word)) {
      const candidateChunk = chunk + segment
      if (unicodeTextWidth(candidateChunk, fonts, size) > maxWidth && chunk) {
        lines.push(chunk)
        chunk = segment
      } else {
        chunk = candidateChunk
      }
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : [""]
}

function drawBrandHeader(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  unicodeFonts: UnicodePdfFonts,
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
  const numberWidth = unicodeTextWidth(documentNumber, unicodeFonts, 9)
  drawUnicodeText({
    page,
    text: documentNumber,
    x: A4[0] - MARGIN - numberWidth,
    y: height - 66,
    fonts: unicodeFonts,
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

interface PartyRenderLine {
  text: string
  size: number
  color: ReturnType<typeof rgb>
  lineHeight: number
  gapAfter: number
}

function partyRenderLines(
  party: FinancialDocumentSnapshot["recipient"],
  width: number,
  fonts: UnicodePdfFonts,
): PartyRenderLine[] {
  return partyLines(party).flatMap((value, fieldIndex) => {
    const size = fieldIndex === 0 ? 10.5 : 9
    const lines = wrapText(value, fonts, size, width)
    return lines.map((text, lineIndex) => ({
      text,
      size,
      color: fieldIndex === 0 ? NAVY : MUTED,
      lineHeight: 12,
      gapAfter: lineIndex === lines.length - 1 ? 2 : 0,
    }))
  })
}

function partyBlockHeight(lines: readonly PartyRenderLine[]): number {
  return (
    47 +
    lines.reduce((height, line) => height + line.lineHeight + line.gapAfter, 0)
  )
}

function drawPartyBlock(input: {
  page: PDFPage
  label: string
  lines: readonly PartyRenderLine[]
  x: number
  top: number
  width: number
  bold: PDFFont
  unicodeFonts: UnicodePdfFonts
}): void {
  input.page.drawText(input.label, {
    x: input.x,
    y: input.top - 18,
    font: input.bold,
    size: 8,
    color: VIOLET,
  })
  let y = input.top - 39
  for (const line of input.lines) {
    const x = isRightToLeftText(line.text)
      ? input.x +
        input.width -
        unicodeTextWidth(line.text, input.unicodeFonts, line.size)
      : input.x
    drawUnicodeText({
      page: input.page,
      text: line.text,
      x,
      y,
      fonts: input.unicodeFonts,
      size: line.size,
      color: line.color,
    })
    y -= line.lineHeight + line.gapAfter
  }
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
  lineItems: Array<{
    quantity: number
    unitAmount: string
    lineTotal: string
  }>
}): void {
  const subtotal = minorUnits(input.subtotal)
  const tax = minorUnits(input.taxAmount)
  const total = minorUnits(input.total)
  const itemTotal = input.lineItems.reduce(
    (sum, item) => sum + minorUnits(item.lineTotal),
    0n,
  )
  if (
    input.lineItems.some(
      (item) =>
        minorUnits(item.unitAmount) * BigInt(item.quantity) !==
        minorUnits(item.lineTotal),
    )
  ) {
    throw new Error(
      "Financial document line total does not match unit amount and quantity",
    )
  }
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
    lineItems: snapshot.lineItems,
  })

  const documentNumber = formatFinancialDocumentNumber(record)
  const issuedAt = new Date(record.issuedAt)
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("Financial document issue date is invalid")
  }

  const pdf = await PDFDocument.create({ updateMetadata: false })
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const unicodeFonts = await loadUnicodeFonts(
    [...stringLeaves(snapshot), currency, documentNumber],
    font,
  )
  pdf.setTitle(`${TITLE[record.kind]} ${documentNumber}`)
  pdf.setAuthor(snapshot.issuer.legalName)
  pdf.setSubject(`GuestPost.cc ${TITLE[record.kind].toLowerCase()}`)
  pdf.setKeywords(["GuestPost.cc", "financial document", record.kind])
  pdf.setCreator("GuestPost.cc communication worker")
  pdf.setProducer("GuestPost.cc")
  pdf.setCreationDate(issuedAt)
  pdf.setModificationDate(issuedAt)

  const drawEnvironmentWatermark = (targetPage: PDFPage): void => {
    if (snapshot.environment !== "NON_PRODUCTION") return
    targetPage.drawText("NON-PRODUCTION SAMPLE", {
      x: 151,
      y: 425,
      font: bold,
      size: 27,
      color: rgb(0.91, 0.925, 0.95),
      rotate: degrees(36),
    })
  }
  const pages: PDFPage[] = []
  let page = pdf.addPage(A4)
  pages.push(page)
  let y = drawBrandHeader(
    page,
    font,
    bold,
    unicodeFonts,
    TITLE[record.kind],
    documentNumber,
  )
  drawEnvironmentWatermark(page)
  const addContinuationPage = (): void => {
    page = pdf.addPage(A4)
    pages.push(page)
    y = drawBrandHeader(
      page,
      font,
      bold,
      unicodeFonts,
      TITLE[record.kind],
      documentNumber,
      true,
    )
    drawEnvironmentWatermark(page)
  }
  const ensureSpace = (height: number): void => {
    if (y - height < CONTENT_BOTTOM) addContinuationPage()
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
    drawUnicodeText({
      page,
      text: value,
      x,
      y: y - 17,
      fonts: unicodeFonts,
      size: 10,
      color: NAVY,
    })
  })
  y -= 62

  const compactWidth = 216
  const issuerCompactLines = partyRenderLines(
    snapshot.issuer,
    compactWidth,
    unicodeFonts,
  )
  const recipientCompactLines = partyRenderLines(
    snapshot.recipient,
    compactWidth,
    unicodeFonts,
  )
  const compactHeight = Math.max(
    135,
    partyBlockHeight(issuerCompactLines),
    partyBlockHeight(recipientCompactLines),
  )
  if (compactHeight <= 210) {
    ensureSpace(compactHeight + 10)
    const top = y + 14
    page.drawRectangle({
      x: MARGIN,
      y: top - compactHeight,
      width: A4[0] - MARGIN * 2,
      height: compactHeight,
      color: SURFACE,
      borderColor: BORDER,
      borderWidth: 1,
    })
    drawPartyBlock({
      page,
      label: "FROM",
      lines: issuerCompactLines,
      x: MARGIN + 16,
      top,
      width: compactWidth,
      bold,
      unicodeFonts,
    })
    drawPartyBlock({
      page,
      label: "BILL TO",
      lines: recipientCompactLines,
      x: 316,
      top,
      width: compactWidth,
      bold,
      unicodeFonts,
    })
    y = top - compactHeight - 18
  } else {
    const fullWidth = A4[0] - MARGIN * 2 - 32
    const parties = [
      ["FROM", snapshot.issuer],
      ["BILL TO", snapshot.recipient],
    ] as const
    for (const [label, party] of parties) {
      let remaining = partyRenderLines(party, fullWidth, unicodeFonts)
      let continuation = false
      while (remaining.length > 0) {
        if (y - 90 < CONTENT_BOTTOM) addContinuationPage()
        const top = y + 14
        const maximumLineHeight = top - CONTENT_BOTTOM - 47
        let usedHeight = 0
        let count = 0
        while (count < remaining.length) {
          const line = remaining[count]!
          const nextHeight = usedHeight + line.lineHeight + line.gapAfter
          if (nextHeight > maximumLineHeight && count > 0) break
          usedHeight = nextHeight
          count += 1
        }
        const chunk = remaining.slice(0, count)
        const height = partyBlockHeight(chunk)
        page.drawRectangle({
          x: MARGIN,
          y: top - height,
          width: A4[0] - MARGIN * 2,
          height,
          color: SURFACE,
          borderColor: BORDER,
          borderWidth: 1,
        })
        drawPartyBlock({
          page,
          label: continuation ? `${label} - CONTINUED` : label,
          lines: chunk,
          x: MARGIN + 16,
          top,
          width: fullWidth,
          bold,
          unicodeFonts,
        })
        remaining = remaining.slice(count)
        continuation = true
        y = top - height - 18
        if (remaining.length > 0) addContinuationPage()
      }
    }
  }
  ensureSpace(60)
  y = drawTableHeader(page, bold, y)

  for (const item of snapshot.lineItems) {
    const descriptionLines = wrapText(item.description, unicodeFonts, 9.5, 310)
    const rowHeight = Math.max(31, descriptionLines.length * 13 + 14)
    if (y - rowHeight < 190) {
      addContinuationPage()
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
      drawUnicodeText({
        page,
        text: line,
        x: MARGIN + 10,
        y: y - 10 - index * 13,
        fonts: unicodeFonts,
        size: 9.5,
        color: SLATE,
      })
    })
    drawUnicodeText({
      page,
      text: String(item.quantity),
      x: 390,
      y: y - 10,
      fonts: unicodeFonts,
      size: 9.5,
      color: SLATE,
    })
    const amount = formatFinancialDocumentAmount(item.lineTotal, currency)
    drawUnicodeText({
      page,
      text: amount,
      x: A4[0] - MARGIN - 10 - unicodeTextWidth(amount, unicodeFonts, 9.5),
      y: y - 10,
      fonts: unicodeFonts,
      size: 9.5,
      color: SLATE,
    })
    y -= rowHeight
  }

  const totals = [
    ["Subtotal", subtotal],
    [snapshot.tax.label, taxAmount],
    [record.kind === "CREDIT_NOTE" ? "Credit total" : "Total", total],
  ] as const
  const totalsLabelX = 330
  const totalsRight = A4[0] - MARGIN
  const preparedTotals = totals.map(([label, amountValue], index) => {
    const strong = index === totals.length - 1
    const size = strong ? 11 : 9.5
    const formatted = formatFinancialDocumentAmount(amountValue, currency)
    const amountWidth = unicodeTextWidth(formatted, unicodeFonts, size)
    const labelWidth = Math.max(
      40,
      totalsRight - amountWidth - 24 - totalsLabelX,
    )
    const labelLines = wrapText(label, unicodeFonts, size, labelWidth)
    const lineHeight = size * 1.25
    return {
      strong,
      size,
      formatted,
      amountWidth,
      labelWidth,
      labelLines,
      lineHeight,
      height: Math.max(25, labelLines.length * lineHeight + 6),
    }
  })
  const totalsHeight = preparedTotals.reduce(
    (height, current) => height + current.height,
    0,
  )
  if (y - 18 - totalsHeight < CONTENT_BOTTOM + 10) addContinuationPage()
  y -= 18

  for (const prepared of preparedTotals) {
    prepared.labelLines.forEach((line, lineIndex) => {
      const lineWidth = unicodeTextWidth(line, unicodeFonts, prepared.size)
      drawUnicodeText({
        page,
        text: line,
        x: isRightToLeftText(line)
          ? totalsLabelX + prepared.labelWidth - lineWidth
          : totalsLabelX,
        y: y - lineIndex * prepared.lineHeight,
        fonts: unicodeFonts,
        size: prepared.size,
        color: prepared.strong ? NAVY : MUTED,
      })
    })
    drawUnicodeText({
      page,
      text: prepared.formatted,
      x: totalsRight - prepared.amountWidth,
      y,
      fonts: unicodeFonts,
      size: prepared.size,
      color: prepared.strong ? NAVY : SLATE,
    })
    y -= prepared.height
  }
  y -= 17

  const drawFlowText = (input: {
    text: string
    size: number
    color: ReturnType<typeof rgb>
    gapBefore?: number
    gapAfter?: number
  }): void => {
    y -= input.gapBefore ?? 0
    const lineHeight = input.size * 1.35
    for (const line of wrapText(input.text, unicodeFonts, input.size, 490)) {
      ensureSpace(lineHeight)
      const x = isRightToLeftText(line)
        ? MARGIN + 490 - unicodeTextWidth(line, unicodeFonts, input.size)
        : MARGIN
      drawUnicodeText({
        page,
        text: line,
        x,
        y,
        fonts: unicodeFonts,
        size: input.size,
        color: input.color,
      })
      y -= lineHeight
    }
    y -= input.gapAfter ?? 0
  }

  ensureSpace(30)
  page.drawText("PAYMENT DETAILS", {
    x: MARGIN,
    y,
    font: bold,
    size: 8,
    color: VIOLET,
  })
  y -= 17
  drawFlowText({
    text: `${snapshot.payment.status} via ${snapshot.payment.method}${snapshot.payment.reference ? ` - ${snapshot.payment.reference}` : ""}`,
    size: 9,
    color: SLATE,
    gapAfter: 5,
  })
  if (snapshot.relatedDocumentNumber) {
    drawFlowText({
      text: `Related document: ${snapshot.relatedDocumentNumber}`,
      size: 9,
      color: SLATE,
      gapAfter: 8,
    })
  }
  drawFlowText({
    text: snapshot.tax.note,
    size: 8.5,
    color: MUTED,
    gapBefore: 3,
    gapAfter: 5,
  })
  for (const note of snapshot.notes) {
    drawFlowText({
      text: note,
      size: 8.5,
      color: MUTED,
      gapAfter: 5,
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
    drawUnicodeText({
      page: currentPage,
      text: pageLabel,
      x: A4[0] - MARGIN - unicodeTextWidth(pageLabel, unicodeFonts, 7.5),
      y: 27,
      fonts: unicodeFonts,
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
