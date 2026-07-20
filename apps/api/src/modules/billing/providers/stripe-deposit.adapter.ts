import {
  customerWalletStatementSuffix,
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
  type DepositSessionResult,
} from "./deposit-provider.interface"

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
    const stripe = getStripeClient("deposits")
    const reference = normalizeFinancialReference(input.publicReference, 32)
    const session = await stripe.checkout.sessions.create(
      {
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: input.currency.toLowerCase(),
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
          statement_descriptor_suffix: customerWalletStatementSuffix(reference),
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
    assertStripeObjectMode(session.livemode, "Stripe Checkout Session")
    if (!session.url) throw new Error("Stripe Checkout returned no session URL")
    return {
      providerSessionId: session.id,
      providerPaymentId:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      url: session.url,
      expiresAt: session.expires_at
        ? new Date(session.expires_at * 1000)
        : null,
      livemode: session.livemode,
    }
  }

  async retrieveSession(
    providerSessionId: string,
  ): Promise<Record<string, any>> {
    const session =
      await getStripeRecoveryClient().checkout.sessions.retrieve(
        providerSessionId,
      )
    assertStripeObjectMode(session.livemode, "Stripe Checkout Session")
    return session as unknown as Record<string, any>
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
