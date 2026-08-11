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
    id: string
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

function assertFinancialAudience(
  recipientUserIds: readonly string[],
  authorizedUserIds: Iterable<string>,
  requiredPrincipalUserId: string,
): void {
  const recipients = new Set(recipientUserIds)
  if (!recipients.has(requiredPrincipalUserId)) {
    throw new Error("Financial document principal recipient is missing")
  }
  const authorized = new Set(authorizedUserIds)
  const unauthorized = [...recipients].filter(
    (userId) => !authorized.has(userId),
  )
  if (unauthorized.length > 0) {
    // Do not include user IDs in the error: the transaction must fail closed
    // without copying cross-tenant identifiers into logs or provider errors.
    throw new Error(
      "Financial document recipients are not authorized for source",
    )
  }
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
  let canonicalOrganizationId: string | null

  if (input.type === "BILLING_DEPOSIT_SUCCEEDED") {
    const attempt = await db.depositAttempt.findUnique({
      where: { id: input.aggregateId },
      select: {
        organizationId: true,
        createdByUserId: true,
        amount: true,
        walletCredit: true,
        currency: true,
        publicReference: true,
        provider: true,
        organization: {
          select: {
            id: true,
            name: true,
            billingProfile: true,
            memberships: {
              where: { status: "ACTIVE", role: "OWNER" },
              select: { userId: true },
            },
          },
        },
      },
    })
    if (!attempt) throw new Error("Deposit receipt source was not found")
    if (input.aggregateType !== "DepositAttempt") {
      throw new Error("Financial document aggregate type does not match source")
    }
    canonicalOrganizationId = attempt.organizationId
    if (
      canonicalOrganizationId !== null &&
      attempt.organization?.id !== canonicalOrganizationId
    ) {
      throw new Error("Deposit receipt organization source is inconsistent")
    }
    assertFinancialAudience(
      input.recipientUserIds,
      [
        attempt.createdByUserId,
        ...(attempt.organization?.memberships ?? []).map(
          (membership: { userId: string }) => membership.userId,
        ),
      ],
      attempt.createdByUserId,
    )
    currency = attempt.currency.toUpperCase()
    subtotal = normalizeFinancialMoney(attempt.amount)
    if (attempt.organization) {
      recipient = recipientParty(attempt.organization, "GuestPost.cc customer")
    } else {
      const creator = await db.user.findUnique({
        where: { id: attempt.createdByUserId },
        select: { name: true, email: true },
      })
      const parsedEmail =
        financialDocumentPartySchema.shape.billingEmail.safeParse(
          creator?.email ?? null,
        )
      const billingEmail = parsedEmail.success ? parsedEmail.data : null
      const namedRecipient = financialDocumentPartySchema.safeParse({
        legalName: creator?.name?.trim(),
        billingEmail,
      })
      recipient = namedRecipient.success
        ? namedRecipient.data
        : financialDocumentPartySchema.parse({
            legalName: "GuestPost.cc customer",
            billingEmail,
          })
    }
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
        customerId: true,
        type: true,
        amount: true,
        currency: true,
        organization: {
          select: {
            id: true,
            name: true,
            billingProfile: true,
            memberships: {
              where: { status: "ACTIVE", role: "OWNER" },
              select: { userId: true },
            },
          },
        },
      },
    })
    if (!order?.amount) {
      throw new Error("Invoice source order or amount was not found")
    }
    if (input.aggregateType !== "Order") {
      throw new Error("Financial document aggregate type does not match source")
    }
    canonicalOrganizationId = order.organization.id
    assertFinancialAudience(
      input.recipientUserIds,
      [
        order.customerId,
        ...order.organization.memberships.map(
          (membership: { userId: string }) => membership.userId,
        ),
      ],
      order.customerId,
    )
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
      const payload =
        typeof input.payload === "object" &&
        input.payload !== null &&
        !Array.isArray(input.payload)
          ? (input.payload as Record<string, unknown>)
          : null
      const refundTransactionId =
        typeof payload?.refundTransactionId === "string" &&
        payload.refundTransactionId.trim().length > 0 &&
        payload.refundTransactionId.length <= 191
          ? payload.refundTransactionId
          : null
      if (!refundTransactionId) {
        throw new Error("Credit note is missing refund ledger evidence")
      }
      const refund = await db.transaction.findUnique({
        where: { id: refundTransactionId },
        select: {
          id: true,
          type: true,
          orderId: true,
          amount: true,
          currency: true,
          wallet: {
            select: { organizationId: true, currency: true },
          },
        },
      })
      const refundEvent = await db.orderEvent.findFirst({
        where: {
          orderId: order.id,
          eventType: "REFUND_ISSUED",
          metadata: {
            path: ["refundTransactionId"],
            equals: refundTransactionId,
          },
        },
        select: { id: true },
      })
      if (
        refund?.type !== "REFUND" ||
        refund.orderId !== order.id ||
        normalizeFinancialMoney(refund.amount) !== subtotal ||
        refund.currency.toUpperCase() !== currency ||
        refund.wallet.organizationId !== canonicalOrganizationId ||
        refund.wallet.currency.toUpperCase() !== currency ||
        !refundEvent ||
        normalizeFinancialMoney(payload?.amount) !== subtotal ||
        String(payload?.currency ?? "").toUpperCase() !== currency
      ) {
        throw new Error(
          "Credit note refund ledger evidence does not match order",
        )
      }
      payment.reference = `Refund ${refund.id}`
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

  if ((input.organizationId ?? null) !== canonicalOrganizationId) {
    throw new Error("Financial document organization does not match source")
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
  // A read-then-create sequence is not safe when two domain transactions
  // record the same event concurrently. Target only dedupKey here: swallowing
  // an unrelated unique violation (such as a second document for the same
  // kind/aggregate) would hide an accounting invariant conflict.
  const proposedDocumentId = `fd_${globalThis.crypto.randomUUID()}`
  await db.$executeRaw`
    INSERT INTO "FinancialDocument" (
      "id", "kind", "numberPrefix", "aggregateType", "aggregateId",
      "organizationId", "relatedDocumentId", "currency", "subtotal",
      "taxAmount", "total", "issuedAt", "snapshot", "dedupKey"
    ) VALUES (
      ${proposedDocumentId}, ${kind}::"FinancialDocumentKind",
      ${issuer.numberPrefix}, ${input.aggregateType}, ${input.aggregateId},
      ${canonicalOrganizationId}, ${relatedDocumentId}, ${currency},
      ${subtotal}, ${taxAmount}, ${subtotal}, ${issuedAt},
      ${JSON.stringify(snapshot)}::jsonb, ${dedupKey}
    )
    ON CONFLICT ("dedupKey") DO NOTHING
  `
  const document = await db.financialDocument.findUnique({
    where: { dedupKey },
    select: {
      id: true,
      kind: true,
      aggregateType: true,
      aggregateId: true,
      organizationId: true,
      currency: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      relatedDocumentId: true,
      snapshot: true,
    },
  })
  if (!document) {
    throw new Error("Financial document deduplication did not return a winner")
  }
  if (
    document.kind !== kind ||
    document.aggregateType !== input.aggregateType ||
    document.aggregateId !== input.aggregateId ||
    document.organizationId !== canonicalOrganizationId ||
    document.relatedDocumentId !== relatedDocumentId ||
    document.currency !== currency ||
    normalizeFinancialMoney(document.subtotal) !== subtotal ||
    normalizeFinancialMoney(document.taxAmount) !== taxAmount ||
    normalizeFinancialMoney(document.total) !== subtotal
  ) {
    throw new Error(
      "Financial document deduplication key conflicts with immutable inputs",
    )
  }
  const winningSnapshot = financialDocumentSnapshotSchema.safeParse(
    document.snapshot,
  )
  if (
    !winningSnapshot.success ||
    winningSnapshot.data.payment.reference !== payment.reference
  ) {
    throw new Error(
      "Financial document deduplication key conflicts with immutable inputs",
    )
  }
  return document.id
}
