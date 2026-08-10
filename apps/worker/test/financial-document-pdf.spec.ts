import assert from "node:assert/strict"
import { test } from "node:test"
import { PDFDocument } from "pdf-lib"
import { renderFinancialDocumentPdf } from "../src/lib/financial-document-pdf"

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
