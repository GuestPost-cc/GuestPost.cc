import type { CommunicationEventInput } from "./communications"
import {
  expectedFinancialDocumentKind,
  type FinancialDocumentSnapshot,
  financialDocumentIssuerFromEnv,
  financialDocumentPartySchema,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
} from "./financial-documents"

export function normalizeFinancialMoney(value: unknown): string {
  const raw =
    typeof value === "object" && value !== null && "toString" in value
      ? String(value)
      : String(value)
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d+))?$/.exec(raw)
  if (!match) throw new Error("Financial document amount is invalid")
  const fractional = match[2] ?? ""
  if (fractional.length > 2 && /[1-9]/.test(fractional.slice(2))) {
    throw new Error("Financial document amount contains sub-cent precision")
  }
  return `${match[1]}.${fractional.slice(0, 2).padEnd(2, "0")}`
}

function recipientParty(
  organization: {
    name: string
    billingProfile?: {
      legalName: string
      billingEmail: string | null
      addressLine1: string
      addressLine2: string | null
      city: string
      region: string | null
      postalCode: string
      countryCode: string
      taxIdType: string | null
      taxId: string | null
    } | null
  } | null,
  fallbackName: string,
): FinancialDocumentSnapshot["recipient"] {
  const profile = organization?.billingProfile
  return financialDocumentPartySchema.parse(
    profile
      ? {
          legalName: profile.legalName,
          billingEmail: profile.billingEmail,
          addressLine1: profile.addressLine1,
          addressLine2: profile.addressLine2,
          city: profile.city,
          region: profile.region,
          postalCode: profile.postalCode,
          countryCode: profile.countryCode,
          taxIdType: profile.taxIdType,
          taxId: profile.taxId,
        }
      : { legalName: organization?.name || fallbackName },
  )
}

/**
 * Issues an immutable financial-document snapshot inside the caller's domain
 * transaction. Keeping this in shared outbox code ensures API and worker
 * initiated refunds follow the identical attachment policy.
 */
export async function issueFinancialDocumentForCommunication(
  db: any,
  input: CommunicationEventInput,
): Promise<string | null> {
  const kind = expectedFinancialDocumentKind(input.type)
  if (!kind) return null

  const issuer = financialDocumentIssuerFromEnv()
  const issuedAt = new Date()
  let currency: string
  let subtotal: string
  let recipient: FinancialDocumentSnapshot["recipient"]
  let lineItems: FinancialDocumentSnapshot["lineItems"]
  let payment: FinancialDocumentSnapshot["payment"]
  let relatedDocumentId: string | null = null
  let relatedDocumentNumber: string | null = null
  const notes: string[] = []

  if (input.type === "BILLING_DEPOSIT_SUCCEEDED") {
    const attempt = await db.depositAttempt.findUnique({
      where: { id: input.aggregateId },
      select: {
        amount: true,
        walletCredit: true,
        currency: true,
        publicReference: true,
        provider: true,
        organization: {
          select: { name: true, billingProfile: true },
        },
      },
    })
    if (!attempt) throw new Error("Deposit receipt source was not found")
    currency = attempt.currency.toUpperCase()
    subtotal = normalizeFinancialMoney(attempt.amount)
    recipient = recipientParty(attempt.organization, "GuestPost.cc customer")
    lineItems = [
      {
        description: "GuestPost.cc wallet funding",
        quantity: 1,
        unitAmount: subtotal,
        lineTotal: subtotal,
      },
    ]
    payment = {
      status: "PAID",
      method: `${attempt.provider} deposit`,
      reference: attempt.publicReference,
    }
    notes.push(
      `${normalizeFinancialMoney(attempt.walletCredit)} ${currency} was credited to the customer wallet.`,
    )
  } else {
    const order = await db.order.findUnique({
      where: { id: input.aggregateId },
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        organization: {
          select: { name: true, billingProfile: true },
        },
      },
    })
    if (!order?.amount) {
      throw new Error("Invoice source order or amount was not found")
    }
    currency = order.currency.toUpperCase()
    subtotal = normalizeFinancialMoney(order.amount)
    recipient = recipientParty(order.organization, "GuestPost.cc customer")
    const serviceName = order.type
      .toLowerCase()
      .split("_")
      .map((part: string) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ")
    const refunded = input.type === "ORDER_REFUNDED"
    lineItems = [
      {
        description: refunded
          ? `Refund - ${serviceName} service`
          : `${serviceName} service`,
        quantity: 1,
        unitAmount: subtotal,
        lineTotal: subtotal,
      },
    ]
    payment = {
      status: refunded ? "REFUNDED" : "PAID",
      method: "GuestPost.cc wallet",
      reference: `Order ${order.id}`,
    }

    if (refunded) {
      const original = await db.financialDocument.findFirst({
        where: {
          kind: "PAID_INVOICE",
          aggregateType: "Order",
          aggregateId: order.id,
        },
        select: {
          id: true,
          kind: true,
          numberPrefix: true,
          sequenceNumber: true,
          issuedAt: true,
        },
      })
      if (original) {
        relatedDocumentId = original.id
        relatedDocumentNumber = formatFinancialDocumentNumber(original)
      }
    }
  }

  const taxAmount = "0.00"
  const snapshot = financialDocumentSnapshotSchema.parse({
    schemaVersion: 1,
    environment: issuer.environment,
    issuer: issuer.party,
    recipient,
    lineItems,
    payment,
    tax: {
      label: "Tax",
      treatment: "NOT_SEPARATELY_CHARGED",
      note: "No tax was separately charged on this document.",
    },
    relatedDocumentNumber,
    notes,
  })
  const dedupKey = `financial-document:${input.dedupKey}`
  const existing = await db.financialDocument.findUnique({
    where: { dedupKey },
    select: { id: true },
  })
  if (existing) return existing.id

  const document = await db.financialDocument.create({
    data: {
      kind,
      numberPrefix: issuer.numberPrefix,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      organizationId: input.organizationId ?? null,
      relatedDocumentId,
      currency,
      subtotal,
      taxAmount,
      total: subtotal,
      issuedAt,
      snapshot,
      dedupKey,
    },
    select: { id: true },
  })
  return document.id
}
