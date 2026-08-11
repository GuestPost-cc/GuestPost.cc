import { z } from "zod"
import type { CommunicationEventType } from "./communications"

export const FINANCIAL_DOCUMENT_KINDS = [
  "PAID_INVOICE",
  "CREDIT_NOTE",
  "DEPOSIT_RECEIPT",
] as const

export type FinancialDocumentKind = (typeof FINANCIAL_DOCUMENT_KINDS)[number]

const MARK = /\p{M}/u
const JOINING_SCRIPTS = [
  ["ARABIC", /\p{Script=Arabic}/u],
  ["BENGALI", /\p{Script=Bengali}/u],
  ["DEVANAGARI", /\p{Script=Devanagari}/u],
] as const

function joiningScriptAt(
  characters: readonly string[],
  start: number,
  direction: -1 | 1,
): string | null {
  for (
    let index = start;
    index >= 0 && index < characters.length;
    index += direction
  ) {
    const character = characters[index]!
    if (MARK.test(character)) continue
    return (
      JOINING_SCRIPTS.find(([, pattern]) => pattern.test(character))?.[0] ??
      null
    )
  }
  return null
}

/**
 * Allows printable, single-line Unicode while rejecting markup, controls,
 * isolated surrogates, and bidi/invisible spoofing. ZWNJ/ZWJ are the only
 * formatting controls retained, and only between characters from the same
 * supported joining script so Persian and Indic legal names can shape safely.
 */
export function isSafeFinancialDocumentText(value: string): boolean {
  if (/[<>\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) return false
  const characters = Array.from(value)
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!
    if (!/\p{Cf}/u.test(character)) continue
    if (character !== "\u200C" && character !== "\u200D") return false
    const left = joiningScriptAt(characters, index - 1, -1)
    const right = joiningScriptAt(characters, index + 1, 1)
    if (!left || left !== right) return false
  }
  return true
}

const safeSingleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => value.normalize("NFC"))
    .refine(isSafeFinancialDocumentText, {
      message: "Value contains unsafe or invisible control characters",
    })

export const financialMoneySchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/)

export const financialDocumentPartySchema = z.object({
  legalName: safeSingleLine(160),
  billingEmail: z.string().trim().email().max(320).nullable().optional(),
  addressLine1: safeSingleLine(160).nullable().optional(),
  addressLine2: safeSingleLine(160).nullable().optional(),
  city: safeSingleLine(100).nullable().optional(),
  region: safeSingleLine(100).nullable().optional(),
  postalCode: safeSingleLine(32).nullable().optional(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
  taxIdType: safeSingleLine(32).nullable().optional(),
  taxId: safeSingleLine(64).nullable().optional(),
})

export const financialDocumentLineItemSchema = z.object({
  description: safeSingleLine(160),
  quantity: z.number().int().positive().max(10_000),
  unitAmount: financialMoneySchema,
  lineTotal: financialMoneySchema,
})

export const financialDocumentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.enum(["PRODUCTION", "NON_PRODUCTION"]),
  issuer: financialDocumentPartySchema.extend({
    addressLine1: safeSingleLine(160),
    city: safeSingleLine(100),
    postalCode: safeSingleLine(32),
    countryCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/),
  }),
  recipient: financialDocumentPartySchema,
  lineItems: z.array(financialDocumentLineItemSchema).min(1).max(25),
  payment: z.object({
    status: z.enum(["PAID", "REFUNDED"]),
    method: safeSingleLine(64),
    reference: safeSingleLine(96).nullable().optional(),
  }),
  tax: z.object({
    label: safeSingleLine(32),
    treatment: z.literal("NOT_SEPARATELY_CHARGED"),
    note: safeSingleLine(240),
  }),
  relatedDocumentNumber: safeSingleLine(64).nullable().optional(),
  notes: z.array(safeSingleLine(240)).max(5).default([]),
})

export type FinancialDocumentSnapshot = z.infer<
  typeof financialDocumentSnapshotSchema
>

export interface FinancialDocumentIssuerConfig {
  numberPrefix: string
  party: FinancialDocumentSnapshot["issuer"]
  environment: FinancialDocumentSnapshot["environment"]
}

const ISSUER_REQUIRED_KEYS = [
  "INVOICE_DOCUMENT_PREFIX",
  "INVOICE_ISSUER_LEGAL_NAME",
  "INVOICE_ISSUER_ADDRESS_LINE_1",
  "INVOICE_ISSUER_CITY",
  "INVOICE_ISSUER_POSTAL_CODE",
  "INVOICE_ISSUER_COUNTRY_CODE",
  "INVOICE_SUPPORT_EMAIL",
] as const
const ISSUER_IDENTITY_KEYS = ISSUER_REQUIRED_KEYS.filter(
  (key) => key !== "INVOICE_DOCUMENT_PREFIX",
)

/**
 * Reads the invoicing identity once at issue time. Production is fail-closed;
 * non-production without any configured issuer receives an unmistakable
 * sample identity and watermark instead of inventing legal company details.
 */
export function financialDocumentIssuerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FinancialDocumentIssuerConfig {
  const production = env.NODE_ENV === "production"
  // A prefix-only local configuration is not a partial legal identity: it is
  // allowed to customize deterministic sample numbers. Any identity field,
  // however, opts into the complete fail-closed issuer bundle.
  const hasAnyIssuerValue = ISSUER_IDENTITY_KEYS.some((key) => env[key]?.trim())
  const missing = ISSUER_REQUIRED_KEYS.filter((key) => !env[key]?.trim())

  if ((production || hasAnyIssuerValue) && missing.length > 0) {
    throw new Error(
      `Financial document issuer configuration is incomplete: ${missing.join(", ")}`,
    )
  }

  const taxIdType = env.INVOICE_ISSUER_TAX_ID_TYPE?.trim() || null
  const taxId = env.INVOICE_ISSUER_TAX_ID?.trim() || null
  if ((taxIdType && !taxId) || (!taxIdType && taxId)) {
    throw new Error(
      "INVOICE_ISSUER_TAX_ID_TYPE and INVOICE_ISSUER_TAX_ID must be configured together",
    )
  }

  const numberPrefix = (env.INVOICE_DOCUMENT_PREFIX ?? "GP")
    .trim()
    .toUpperCase()
  if (!/^[A-Z0-9]{2,12}$/.test(numberPrefix)) {
    throw new Error(
      "INVOICE_DOCUMENT_PREFIX must contain 2-12 uppercase letters or digits",
    )
  }

  if (!production && !hasAnyIssuerValue) {
    return {
      numberPrefix,
      environment: "NON_PRODUCTION",
      party: financialDocumentSnapshotSchema.shape.issuer.parse({
        legalName: "GuestPost.cc development sample",
        billingEmail: "support@guestpost.cc",
        addressLine1: "Non-production document - not for accounting",
        city: "Local development",
        postalCode: "00000",
        countryCode: "US",
      }),
    }
  }

  return {
    numberPrefix,
    environment: production ? "PRODUCTION" : "NON_PRODUCTION",
    party: financialDocumentSnapshotSchema.shape.issuer.parse({
      legalName: env.INVOICE_ISSUER_LEGAL_NAME,
      billingEmail: env.INVOICE_SUPPORT_EMAIL,
      addressLine1: env.INVOICE_ISSUER_ADDRESS_LINE_1,
      addressLine2: env.INVOICE_ISSUER_ADDRESS_LINE_2?.trim() || null,
      city: env.INVOICE_ISSUER_CITY,
      region: env.INVOICE_ISSUER_REGION?.trim() || null,
      postalCode: env.INVOICE_ISSUER_POSTAL_CODE,
      countryCode: env.INVOICE_ISSUER_COUNTRY_CODE,
      taxIdType,
      taxId,
    }),
  }
}

export const FINANCIAL_DOCUMENT_EVENT_POLICY: Partial<
  Record<CommunicationEventType, FinancialDocumentKind>
> = {
  ORDER_PAYMENT_CAPTURED: "PAID_INVOICE",
  ORDER_REFUNDED: "CREDIT_NOTE",
  BILLING_DEPOSIT_SUCCEEDED: "DEPOSIT_RECEIPT",
}

export function expectedFinancialDocumentKind(
  eventType: CommunicationEventType,
): FinancialDocumentKind | null {
  return FINANCIAL_DOCUMENT_EVENT_POLICY[eventType] ?? null
}

export function financialDocumentIdFromEventPayload(
  eventType: CommunicationEventType,
  payload: unknown,
): string | null {
  if (!expectedFinancialDocumentKind(eventType)) return null
  const parsed = z
    .object({ financialDocumentId: z.string().trim().min(1).max(191) })
    .safeParse(payload)
  return parsed.success ? parsed.data.financialDocumentId : null
}

const KIND_CODE: Record<FinancialDocumentKind, string> = {
  PAID_INVOICE: "INV",
  CREDIT_NOTE: "CRN",
  DEPOSIT_RECEIPT: "DPR",
}

export function formatFinancialDocumentNumber(input: {
  kind: FinancialDocumentKind
  numberPrefix: string
  sequenceNumber: bigint | number | string
  issuedAt: Date | string
}): string {
  const issuedAt = new Date(input.issuedAt)
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("Financial document has an invalid issue date")
  }
  const sequence = BigInt(input.sequenceNumber)
  if (sequence <= 0n) {
    throw new Error("Financial document sequence must be positive")
  }
  const prefix = input.numberPrefix.trim().toUpperCase()
  if (!/^[A-Z0-9]{2,12}$/.test(prefix)) {
    throw new Error("Financial document prefix is invalid")
  }
  return `${prefix}-${KIND_CODE[input.kind]}-${issuedAt.getUTCFullYear()}-${sequence.toString().padStart(8, "0")}`
}
