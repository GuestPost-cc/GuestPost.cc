import { normalizeFinancialMoney } from "../financial-document-outbox-core"
import {
  expectedFinancialDocumentKind,
  financialDocumentIdFromEventPayload,
  financialDocumentIssuerFromEnv,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
} from "../financial-documents"

describe("financial documents", () => {
  it("maps only eligible customer financial events to attachments", () => {
    expect(expectedFinancialDocumentKind("ORDER_PAYMENT_CAPTURED")).toBe(
      "PAID_INVOICE",
    )
    expect(expectedFinancialDocumentKind("ORDER_REFUNDED")).toBe("CREDIT_NOTE")
    expect(expectedFinancialDocumentKind("SETTLEMENT_RELEASED")).toBeNull()
  })

  it("extracts a bounded document id only for eligible events", () => {
    expect(
      financialDocumentIdFromEventPayload("ORDER_PAYMENT_CAPTURED", {
        financialDocumentId: "document-1",
      }),
    ).toBe("document-1")
    expect(
      financialDocumentIdFromEventPayload("ORDER_ACCEPTED", {
        financialDocumentId: "document-1",
      }),
    ).toBeNull()
    expect(
      financialDocumentIdFromEventPayload("ORDER_PAYMENT_CAPTURED", {
        financialDocumentId: "",
      }),
    ).toBeNull()
  })

  it("formats stable sequential document numbers", () => {
    expect(
      formatFinancialDocumentNumber({
        kind: "PAID_INVOICE",
        numberPrefix: "gp",
        sequenceNumber: 42n,
        issuedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toBe("GP-INV-2026-00000042")
  })

  it("normalizes exact money without silently rounding sub-cent values", () => {
    expect(normalizeFinancialMoney("42")).toBe("42.00")
    expect(normalizeFinancialMoney("42.5")).toBe("42.50")
    expect(normalizeFinancialMoney("42.5000")).toBe("42.50")
    expect(() => normalizeFinancialMoney("42.501")).toThrow(
      "sub-cent precision",
    )
    expect(() => normalizeFinancialMoney("-1")).toThrow("amount is invalid")
  })

  it("fails closed when production issuer data is incomplete", () => {
    expect(() =>
      financialDocumentIssuerFromEnv({ NODE_ENV: "production" }),
    ).toThrow("issuer configuration is incomplete")
  })

  it("uses an unmistakable non-production identity when unconfigured", () => {
    const issuer = financialDocumentIssuerFromEnv({ NODE_ENV: "test" })
    expect(issuer.environment).toBe("NON_PRODUCTION")
    expect(issuer.party.legalName).toContain("development sample")
  })

  it("rejects unsupported glyphs before PDF rendering", () => {
    expect(() =>
      financialDocumentSnapshotSchema.parse({
        schemaVersion: 1,
        environment: "PRODUCTION",
        issuer: {
          legalName: "GuestPost.cc",
          billingEmail: "support@guestpost.cc",
          addressLine1: "1 Platform Way",
          city: "Austin",
          postalCode: "78701",
          countryCode: "US",
        },
        recipient: { legalName: "অ্যাকমে" },
        lineItems: [
          {
            description: "Guest post service",
            quantity: 1,
            unitAmount: "100.00",
            lineTotal: "100.00",
          },
        ],
        payment: {
          status: "PAID",
          method: "GuestPost.cc wallet",
          reference: "Order order-1",
        },
        tax: {
          label: "Tax",
          treatment: "NOT_SEPARATELY_CHARGED",
          note: "No tax was separately charged on this document.",
        },
        notes: [],
      }),
    ).toThrow("supported Latin invoice character set")
  })
})
