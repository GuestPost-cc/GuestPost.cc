import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { FinancialDocumentSnapshot } from "@guestpost/shared"
import { renderFinancialDocumentPdf } from "../src/lib/financial-document-pdf"

const repositoryRoot = resolve(__dirname, "../../..")
// pnpm versions differ on whether the conventional `--` separator is kept in
// process.argv for package scripts. Never treat it as a directory name.
const requestedOutputDirectory = process.argv
  .slice(2)
  .find((argument) => argument !== "--")
const outputDirectory = resolve(
  repositoryRoot,
  requestedOutputDirectory ?? "tmp/pdfs",
)
const issuedAt = new Date("2026-08-10T12:00:00.000Z")

const snapshot: FinancialDocumentSnapshot = {
  schemaVersion: 1,
  environment: "NON_PRODUCTION",
  issuer: {
    legalName: "GuestPost.cc development sample",
    billingEmail: "billing@guestpost.cc",
    addressLine1: "100 Marketplace Avenue",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
  },
  recipient: {
    legalName: "Acme Content Ltd.",
    billingEmail: "accounts@acme.example",
    addressLine1: "42 Editorial Road",
    city: "London",
    postalCode: "EC1A 1BB",
    countryCode: "GB",
  },
  lineItems: [
    {
      description: "Guest Post placement service",
      quantity: 1,
      unitAmount: "425.00",
      lineTotal: "425.00",
    },
  ],
  payment: {
    status: "PAID",
    method: "GuestPost.cc wallet",
    reference: "Order fixture-order-1",
  },
  tax: {
    label: "Tax",
    treatment: "NOT_SEPARATELY_CHARGED",
    note: "No tax was separately charged on this document.",
  },
  notes: [],
}

const baseRecord = {
  id: "fixture-document-1",
  sequenceNumber: 1001n,
  kind: "PAID_INVOICE" as const,
  numberPrefix: "GP",
  aggregateType: "Order",
  aggregateId: "fixture-order-1",
  organizationId: "fixture-organization-1",
  currency: "USD",
  subtotal: "425.00",
  taxAmount: "0.00",
  total: "425.00",
  issuedAt,
  snapshot,
}

const multilingualSnapshot: FinancialDocumentSnapshot = {
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
    // Contextual ZWNJ/ZWJ controls are schema-valid legal-name data and must
    // remain shaped, visible, and recoverable through the PDF ActualText layer.
    region: "شركة‌دبي",
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
  payment: {
    status: "PAID",
    method: "محفظة GuestPost.cc",
    reference: "Заказ fixture-order-unicode",
  },
  tax: {
    ...snapshot.tax,
    note: "ক্‍ষ: কোনো কর আলাদাভাবে নেওয়া হয়নি।",
  },
  notes: [
    "Примечание: документ проверен.",
    "فاتورة INV-2026-42 ضريبة 15 USD بتاريخ 2026-08-10",
    "Unsupported historic script remains auditable: 𐍈",
  ],
}

const longLineItems = Array.from({ length: 25 }, (_, index) => ({
  description: `Guest Post placement service ${index + 1}`,
  quantity: 1,
  unitAmount: "100.00",
  lineTotal: "100.00",
}))

const repeatTo = (value: string, length: number) =>
  Array.from(
    { length },
    (_, index) => Array.from(value)[index % Array.from(value).length],
  ).join("")
const boundaryParty = {
  legalName: repeatTo("شركة株式会社Пример", 160),
  billingEmail: null,
  addressLine1: repeatTo("العنوان示例", 160),
  addressLine2: repeatTo("추가주소Пример", 160),
  city: repeatTo("مدينة東京", 100),
  region: repeatTo("منطقة서울", 100),
  postalCode: repeatTo("郵便123", 32),
  countryCode: "JP" as const,
  taxIdType: repeatTo("税معرف", 32),
  taxId: repeatTo("税-15-معرف", 64),
}
const boundarySnapshot: FinancialDocumentSnapshot = {
  ...snapshot,
  issuer: boundaryParty,
  recipient: boundaryParty,
  lineItems: Array.from({ length: 25 }, (_, index) => ({
    description: `${index + 1} ${repeatTo("فاتورة株式会社게시물Пример", 150)}`,
    quantity: 1,
    unitAmount: "1.00",
    lineTotal: "1.00",
  })),
  payment: {
    status: "PAID",
    method: repeatTo("محفظةWallet", 64),
    reference: repeatTo("INV-2026-فاتورة-15", 96),
  },
  tax: {
    label: repeatTo("ضريبةTax", 32),
    treatment: "NOT_SEPARATELY_CHARGED",
    note: repeatTo("ملاحظة税금Примечание", 240),
  },
  notes: Array.from({ length: 5 }, () =>
    repeatTo("فاتورة INV-42 ضريبة 15 株式会社 게시물 Примечание ", 240),
  ),
}

const fixtures = [
  {
    filename: "invoice-latin.pdf",
    record: baseRecord,
  },
  {
    filename: "invoice-multilingual.pdf",
    record: {
      ...baseRecord,
      id: "fixture-document-unicode",
      sequenceNumber: 1002n,
      aggregateId: "fixture-order-unicode",
      snapshot: multilingualSnapshot,
    },
  },
  {
    filename: "invoice-multipage.pdf",
    record: {
      ...baseRecord,
      id: "fixture-document-multipage",
      sequenceNumber: 1003n,
      aggregateId: "fixture-order-multipage",
      subtotal: "2500.00",
      total: "2500.00",
      snapshot: { ...snapshot, lineItems: longLineItems },
    },
  },
  {
    filename: "invoice-layout-boundary.pdf",
    record: {
      ...baseRecord,
      id: "fixture-document-layout-boundary",
      sequenceNumber: 1004n,
      aggregateId: "fixture-order-layout-boundary",
      subtotal: "25.00",
      total: "25.00",
      snapshot: boundarySnapshot,
    },
  },
]

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true })
  for (const fixture of fixtures) {
    const rendered = await renderFinancialDocumentPdf(fixture.record)
    await writeFile(
      resolve(outputDirectory, fixture.filename),
      rendered.content,
      { flag: "w" },
    )
    process.stdout.write(
      `${fixture.filename}\t${rendered.size} bytes\t${rendered.sha256}\n`,
    )
  }
}

void main().catch((error) => {
  process.stderr.write(
    `Financial document fixture rendering failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  )
  process.exitCode = 1
})
