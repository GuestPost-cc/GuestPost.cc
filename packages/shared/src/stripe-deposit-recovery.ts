// Server-only Stripe deposit retrieval boundary. This deliberately uses a
// distinct restricted key and persists only bounded, typed financial facts.
// Raw provider bodies, headers, customer details, and credentials never leave
// this module.

import { createHash } from "node:crypto"
import { request } from "undici"
import {
  assertStripeFinancialObjectMode,
  classifyStripeKeyMode,
  StripeConfigurationError,
} from "./stripe-key-mode"

const STRIPE_API_ORIGIN = "https://api.stripe.com"
const STRIPE_API_VERSION = "2026-06-24.dahlia"
const MAX_RESPONSE_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const STRIPE_ID = /^[A-Za-z0-9_]+$/

export type StripeDepositRecoveryErrorCode =
  | "STRIPE_RECOVERY_KEY_MISSING"
  | "STRIPE_RECOVERY_KEY_INVALID"
  | "STRIPE_RECOVERY_LIVE_MODE_DISABLED"
  | "STRIPE_RECOVERY_AUTHENTICATION_FAILED"
  | "STRIPE_RECOVERY_RATE_LIMITED"
  | "STRIPE_RECOVERY_PROVIDER_UNAVAILABLE"
  | "STRIPE_RECOVERY_OBJECT_NOT_FOUND"
  | "STRIPE_RECOVERY_REQUEST_REJECTED"
  | "STRIPE_RECOVERY_RESPONSE_INVALID"
  | "STRIPE_RECOVERY_MODE_MISMATCH"

export class StripeDepositRecoveryError extends Error {
  readonly name = "StripeDepositRecoveryError"

  constructor(
    readonly code: StripeDepositRecoveryErrorCode,
    readonly retryable: boolean,
  ) {
    super(code)
  }
}

export interface StripeDepositRecoveryEvidence {
  source: "AUTHENTICATED_PROVIDER_RETRIEVAL"
  provider: "stripe"
  providerSessionId: string
  providerPaymentId: string | null
  providerChargeId: string | null
  clientReferenceId: string | null
  checkoutStatus: string | null
  checkoutPaymentStatus: string | null
  checkoutMode: string | null
  checkoutAmountTotalMinor: bigint | null
  checkoutCurrency: string | null
  checkoutLivemode: boolean
  checkoutMetadataAttemptId: string | null
  checkoutMetadataReference: string | null
  checkoutMetadataWalletId: string | null
  checkoutMetadataUserId: string | null
  checkoutMetadataOrgId: string | null
  paymentIntentStatus: string | null
  paymentIntentAmountMinor: bigint | null
  paymentIntentReceivedMinor: bigint | null
  paymentIntentCurrency: string | null
  paymentIntentLivemode: boolean | null
  paymentMetadataAttemptId: string | null
  paymentMetadataReference: string | null
  paymentMetadataWalletId: string | null
  chargePaid: boolean | null
  chargeCaptured: boolean | null
  chargeRefunded: boolean | null
  chargeAmountMinor: bigint | null
  chargeAmountCapturedMinor: bigint | null
  chargeCurrency: string | null
  chargeLivemode: boolean | null
  evidenceFingerprint: string
  retrievedAt: Date
}

export type FingerprintableStripeDepositRecoveryEvidence = Omit<
  StripeDepositRecoveryEvidence,
  "evidenceFingerprint" | "retrievedAt"
>

function boundedString(
  value: unknown,
  max: number,
  required = false,
): string | null {
  if (value == null && !required) return null
  if (typeof value !== "string") {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  const result = value.trim()
  if ((!result && required) || result.length > max) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return result || null
}

function objectId(value: unknown, required = false): string | null {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).id
        : null
  const id = boundedString(raw, 191, required)
  if (id && !STRIPE_ID.test(id)) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return id
}

function metadataValue(
  metadata: unknown,
  key: string,
  max = 191,
): string | null {
  if (metadata == null) return null
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return boundedString((metadata as Record<string, unknown>)[key], max)
}

function minorAmount(value: unknown): bigint | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return BigInt(value as number)
}

function optionalBoolean(value: unknown): boolean | null {
  if (value == null) return null
  if (typeof value !== "boolean") {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return value
}

function requiredBoolean(value: unknown): boolean {
  const result = optionalBoolean(value)
  if (result == null) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  return result
}

function canonicalEvidenceValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(canonicalEvidenceValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalEvidenceValue(child)]),
    )
  }
  return value
}

export function stripeDepositRecoveryEvidenceFingerprint(
  evidence: FingerprintableStripeDepositRecoveryEvidence,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "stripe-deposit-recovery-evidence:v1",
        ...(canonicalEvidenceValue(evidence) as Record<string, unknown>),
      }),
    )
    .digest("hex")
}

async function readBoundedJson(body: AsyncIterable<Uint8Array>): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_RESPONSE_BYTES) {
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_RESPONSE_INVALID",
        false,
      )
    }
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object")
    }
    return parsed
  } catch (error) {
    if (error instanceof StripeDepositRecoveryError) throw error
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
}

async function retrieveStripeObject(
  path: "checkout/sessions" | "payment_intents" | "charges",
  id: string,
  secretKey: string,
): Promise<any> {
  if (!id || id.length > 191 || !STRIPE_ID.test(id)) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_REQUEST_REJECTED",
      false,
    )
  }
  try {
    const response = await request(
      `${STRIPE_API_ORIGIN}/v1/${path}/${encodeURIComponent(id)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          accept: "application/json",
        },
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      },
    )
    const contentLength = Number(response.headers["content-length"] ?? 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      response.body.destroy()
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_RESPONSE_INVALID",
        false,
      )
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy()
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new StripeDepositRecoveryError(
          "STRIPE_RECOVERY_AUTHENTICATION_FAILED",
          true,
        )
      }
      if (response.statusCode === 404) {
        throw new StripeDepositRecoveryError(
          "STRIPE_RECOVERY_OBJECT_NOT_FOUND",
          false,
        )
      }
      if (response.statusCode === 429) {
        throw new StripeDepositRecoveryError(
          "STRIPE_RECOVERY_RATE_LIMITED",
          true,
        )
      }
      if (response.statusCode >= 500) {
        throw new StripeDepositRecoveryError(
          "STRIPE_RECOVERY_PROVIDER_UNAVAILABLE",
          true,
        )
      }
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_REQUEST_REJECTED",
        false,
      )
    }
    return await readBoundedJson(response.body)
  } catch (error) {
    if (error instanceof StripeDepositRecoveryError) throw error
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_PROVIDER_UNAVAILABLE",
      true,
    )
  }
}

function assertObjectType(value: unknown, expected: string): void {
  if ((value as Record<string, unknown>)?.object !== expected) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
}

export async function retrieveStripeDepositEvidence(
  providerSessionId: string,
  options: {
    secretKey?: string | null
    liveModeEnabled?: string | null
    now?: Date
    requestObject?: (
      path: "checkout/sessions" | "payment_intents" | "charges",
      id: string,
      secretKey: string,
    ) => Promise<any>
  } = {},
): Promise<StripeDepositRecoveryEvidence> {
  const secretKey =
    options.secretKey ?? process.env.STRIPE_DEPOSIT_RECOVERY_KEY ?? null
  const keyMode = classifyStripeKeyMode(secretKey)
  if (keyMode === "none") {
    throw new StripeDepositRecoveryError("STRIPE_RECOVERY_KEY_MISSING", true)
  }
  if (keyMode === "invalid") {
    throw new StripeDepositRecoveryError("STRIPE_RECOVERY_KEY_INVALID", true)
  }
  if (
    !secretKey!.trim().startsWith("rk_test_") &&
    !secretKey!.trim().startsWith("rk_live_")
  ) {
    throw new StripeDepositRecoveryError("STRIPE_RECOVERY_KEY_INVALID", true)
  }
  if (
    keyMode === "live" &&
    (options.liveModeEnabled ?? process.env.STRIPE_LIVE_MODE_ENABLED)
      ?.trim()
      .toLowerCase() !== "true"
  ) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_LIVE_MODE_DISABLED",
      true,
    )
  }

  const requestObject = options.requestObject ?? retrieveStripeObject
  const session = await requestObject(
    "checkout/sessions",
    providerSessionId,
    secretKey!,
  )
  assertObjectType(session, "checkout.session")
  if (objectId(session.id, true) !== providerSessionId) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }
  const providerPaymentId = objectId(session.payment_intent)
  const paymentIntent = providerPaymentId
    ? await requestObject("payment_intents", providerPaymentId, secretKey!)
    : null
  if (paymentIntent) {
    assertObjectType(paymentIntent, "payment_intent")
    if (objectId(paymentIntent.id, true) !== providerPaymentId) {
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_RESPONSE_INVALID",
        false,
      )
    }
  }
  const providerChargeId = paymentIntent
    ? objectId(paymentIntent.latest_charge)
    : null
  const charge = providerChargeId
    ? await requestObject("charges", providerChargeId, secretKey!)
    : null
  if (charge) {
    assertObjectType(charge, "charge")
    if (
      objectId(charge.id, true) !== providerChargeId ||
      objectId(charge.payment_intent, true) !== providerPaymentId
    ) {
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_RESPONSE_INVALID",
        false,
      )
    }
  }

  // These are current authoritative provider gates. The normalized persisted
  // charge facts still prove paid/captured/not-refunded; this stricter read
  // also refuses any already disputed or partially refunded Charge.
  const amountRefunded = charge ? minorAmount(charge.amount_refunded) : null
  if (
    charge &&
    (requiredBoolean(charge.disputed) ||
      amountRefunded == null ||
      amountRefunded !== 0n)
  ) {
    throw new StripeDepositRecoveryError(
      "STRIPE_RECOVERY_RESPONSE_INVALID",
      false,
    )
  }

  const checkoutLivemode = requiredBoolean(session.livemode)
  try {
    assertStripeFinancialObjectMode(checkoutLivemode, {
      secretKey,
      liveModeEnabled:
        options.liveModeEnabled ?? process.env.STRIPE_LIVE_MODE_ENABLED,
    })
  } catch (error) {
    if (error instanceof StripeConfigurationError) {
      throw new StripeDepositRecoveryError(
        "STRIPE_RECOVERY_MODE_MISMATCH",
        false,
      )
    }
    throw error
  }

  const fingerprintable: FingerprintableStripeDepositRecoveryEvidence = {
    source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
    provider: "stripe",
    providerSessionId,
    providerPaymentId,
    providerChargeId,
    clientReferenceId: boundedString(session.client_reference_id, 191),
    checkoutStatus: boundedString(session.status, 64),
    checkoutPaymentStatus: boundedString(session.payment_status, 64),
    checkoutMode: boundedString(session.mode, 32),
    checkoutAmountTotalMinor: minorAmount(session.amount_total),
    checkoutCurrency: boundedString(session.currency, 3),
    checkoutLivemode,
    checkoutMetadataAttemptId: metadataValue(
      session.metadata,
      "depositAttemptId",
    ),
    checkoutMetadataReference: metadataValue(
      session.metadata,
      "publicReference",
      32,
    ),
    checkoutMetadataWalletId: metadataValue(session.metadata, "walletId"),
    checkoutMetadataUserId: metadataValue(session.metadata, "userId"),
    checkoutMetadataOrgId: metadataValue(session.metadata, "organizationId"),
    paymentIntentStatus: paymentIntent
      ? boundedString(paymentIntent.status, 64)
      : null,
    paymentIntentAmountMinor: paymentIntent
      ? minorAmount(paymentIntent.amount)
      : null,
    paymentIntentReceivedMinor: paymentIntent
      ? minorAmount(paymentIntent.amount_received)
      : null,
    paymentIntentCurrency: paymentIntent
      ? boundedString(paymentIntent.currency, 3)
      : null,
    paymentIntentLivemode: paymentIntent
      ? requiredBoolean(paymentIntent.livemode)
      : null,
    paymentMetadataAttemptId: paymentIntent
      ? metadataValue(paymentIntent.metadata, "depositAttemptId")
      : null,
    paymentMetadataReference: paymentIntent
      ? metadataValue(paymentIntent.metadata, "publicReference", 32)
      : null,
    paymentMetadataWalletId: paymentIntent
      ? metadataValue(paymentIntent.metadata, "walletId")
      : null,
    chargePaid: charge ? requiredBoolean(charge.paid) : null,
    chargeCaptured: charge ? requiredBoolean(charge.captured) : null,
    chargeRefunded: charge ? requiredBoolean(charge.refunded) : null,
    chargeAmountMinor: charge ? minorAmount(charge.amount) : null,
    chargeAmountCapturedMinor: charge
      ? minorAmount(charge.amount_captured)
      : null,
    chargeCurrency: charge ? boundedString(charge.currency, 3) : null,
    chargeLivemode: charge ? requiredBoolean(charge.livemode) : null,
  }
  return {
    ...fingerprintable,
    evidenceFingerprint:
      stripeDepositRecoveryEvidenceFingerprint(fingerprintable),
    retrievedAt: options.now ?? new Date(),
  }
}

export function stripeDepositEvidenceCreateData(
  recoveryId: string,
  depositAttemptId: string,
  evidence: StripeDepositRecoveryEvidence,
  claimAttempt: number,
  claimLockedAt: Date,
): Record<string, unknown> {
  return {
    recoveryId,
    depositAttemptId,
    claimAttempt,
    claimLockedAt,
    ...evidence,
  }
}
