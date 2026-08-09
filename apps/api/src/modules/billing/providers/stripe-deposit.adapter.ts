import {
  customerWalletStatementSuffix,
  isSupportedMoneyCurrency,
  normalizeFinancialReference,
} from "@guestpost/shared"
import { Injectable } from "@nestjs/common"
import {
  assertStripeObjectMode,
  getStripeClient,
  getStripeRecoveryClient,
} from "../../../common/stripe-client"
import {
  type CreateDepositSessionInput,
  type DepositProviderAdapter,
  DepositProviderError,
  type DepositProviderFailureCode,
  type DepositSessionResult,
} from "./deposit-provider.interface"

function stripeErrorFact(error: unknown, field: "type" | "code"): string {
  if (!error || typeof error !== "object") return ""
  const value = (error as Record<string, unknown>)[field]
  return typeof value === "string" ? value : ""
}

/** Classifies Stripe failures without retaining provider text or credentials. */
export function classifyStripeDepositFailure(
  error: unknown,
): DepositProviderError {
  if (error instanceof DepositProviderError) return error

  const type = stripeErrorFact(error, "type")
  const code = stripeErrorFact(error, "code")
  let failureCode: DepositProviderFailureCode = "PROVIDER_UNAVAILABLE"
  let retryable = true

  if (
    type === "StripeAuthenticationError" ||
    type === "StripePermissionError" ||
    code === "api_key_expired"
  ) {
    failureCode = "PROVIDER_AUTHENTICATION_FAILED"
    retryable = false
  } else if (type === "StripeRateLimitError") {
    failureCode = "PROVIDER_RATE_LIMITED"
  } else if (
    type === "StripeInvalidRequestError" ||
    type === "StripeIdempotencyError"
  ) {
    failureCode = "PROVIDER_REQUEST_REJECTED"
    retryable = false
  }

  return new DepositProviderError(failureCode, retryable)
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function stripeSessionMetadata(
  value: unknown,
): DepositSessionResult["metadata"] {
  const metadata =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : Object.create(null)
  return {
    depositAttemptId: optionalString(metadata.depositAttemptId),
    publicReference: optionalString(metadata.publicReference),
    walletId: optionalString(metadata.walletId),
    userId: optionalString(metadata.userId),
    organizationId: optionalString(metadata.organizationId),
  }
}

/**
 * Reduce a Stripe Checkout Session to the bounded facts the billing domain is
 * allowed to trust. Exact command binding remains a billing-domain decision;
 * raw provider objects and error text never cross this adapter boundary.
 */
export function normalizeStripeDepositSession(
  value: unknown,
): DepositSessionResult {
  if (!value || typeof value !== "object") {
    throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
  }
  const session = value as Record<string, unknown>
  const providerSessionId = optionalString(session.id)
  if (!providerSessionId || typeof session.livemode !== "boolean") {
    throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
  }

  try {
    assertStripeObjectMode(session.livemode, "Stripe Checkout Session")
  } catch {
    throw new DepositProviderError("PROVIDER_RESPONSE_INVALID", false)
  }

  let providerPaymentId: string | null = null
  if (typeof session.payment_intent === "string") {
    providerPaymentId = session.payment_intent
  } else if (
    session.payment_intent &&
    typeof session.payment_intent === "object"
  ) {
    providerPaymentId = optionalString(
      (session.payment_intent as Record<string, unknown>).id,
    )
  }

  const amountTotalMinor =
    typeof session.amount_total === "number" &&
    Number.isSafeInteger(session.amount_total)
      ? session.amount_total
      : null
  const expiresAt =
    typeof session.expires_at === "number" &&
    Number.isSafeInteger(session.expires_at) &&
    session.expires_at > 0
      ? new Date(session.expires_at * 1000)
      : null

  return {
    providerSessionId,
    providerObjectType: optionalString(session.object),
    providerPaymentId,
    clientReferenceId: optionalString(session.client_reference_id),
    metadata: stripeSessionMetadata(session.metadata),
    amountTotalMinor,
    currency: optionalString(session.currency)?.toUpperCase() ?? null,
    mode: optionalString(session.mode),
    status: optionalString(session.status),
    url: optionalString(session.url),
    expiresAt,
    livemode: session.livemode,
  }
}

@Injectable()
export class StripeDepositAdapter implements DepositProviderAdapter {
  readonly providerName = "stripe"
  readonly capabilities = {
    supportedMethods: ["CARD"],
    supportedCurrencies: ["USD"],
    supportsRefunds: true,
    supportsDisputes: true,
    supportsWebhooks: true,
  }

  async createSession(
    input: CreateDepositSessionInput,
  ): Promise<DepositSessionResult> {
    if (!isSupportedMoneyCurrency(input.currency)) {
      throw new DepositProviderError("PROVIDER_REQUEST_REJECTED", false)
    }
    try {
      const stripe = getStripeClient("deposits")
      const reference = normalizeFinancialReference(input.publicReference, 32)
      const session = await stripe.checkout.sessions.create(
        {
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: "GuestPost wallet deposit",
                  description: `Wallet funding reference ${reference}`,
                },
                unit_amount: input.amountMinor,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.attemptId,
          payment_intent_data: {
            description: `GuestPost wallet deposit ${reference}`,
            statement_descriptor_suffix:
              customerWalletStatementSuffix(reference),
            metadata: {
              depositAttemptId: input.attemptId,
              publicReference: reference,
              walletId: input.walletId,
            },
          },
          metadata: {
            depositAttemptId: input.attemptId,
            publicReference: reference,
            walletId: input.walletId,
            userId: input.userId,
            organizationId: input.organizationId ?? "",
          },
        },
        { idempotencyKey: input.idempotencyKey },
      )
      return normalizeStripeDepositSession(session)
    } catch (error) {
      throw classifyStripeDepositFailure(error)
    }
  }

  async retrieveSession(
    providerSessionId: string,
  ): Promise<DepositSessionResult> {
    try {
      const session =
        await getStripeRecoveryClient().checkout.sessions.retrieve(
          providerSessionId,
        )
      return normalizeStripeDepositSession(session)
    } catch (error) {
      throw classifyStripeDepositFailure(error)
    }
  }

  verifyWebhook(signature: string, payload: Buffer): Record<string, any> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured")
    return getStripeRecoveryClient().webhooks.constructEvent(
      payload,
      signature,
      secret,
    ) as unknown as Record<string, any>
  }
}
