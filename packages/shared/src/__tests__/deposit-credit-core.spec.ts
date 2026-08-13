import {
  assertDepositRecoveryEvidenceMatchesAttempt,
  DepositCreditFinalizationError,
  depositCreditFactsFromRecoveryEvidence,
  depositCreditFactsFromSignedCheckoutSession,
} from "../deposit-credit-core"
import {
  type FingerprintableStripeDepositRecoveryEvidence,
  type StripeDepositRecoveryEvidence,
  stripeDepositRecoveryEvidenceFingerprint,
} from "../stripe-deposit-recovery"

describe("canonical deposit credit facts", () => {
  it("requires the signed Checkout command bindings used at session creation", () => {
    expect(() =>
      depositCreditFactsFromSignedCheckoutSession(
        {
          id: "cs_test_1",
          payment_intent: "pi_test_1",
          client_reference_id: "attempt-1",
          status: "complete",
          payment_status: "paid",
          mode: "payment",
          amount_total: 1000,
          currency: "usd",
          livemode: false,
          metadata: {
            depositAttemptId: "attempt-1",
            publicReference: "DP-1",
            walletId: "wallet-1",
            // userId intentionally absent
            organizationId: "org-1",
          },
        },
        false,
      ),
    ).toThrow(DepositCreditFinalizationError)
  })

  it("preserves all authenticated PaymentIntent and Charge facts", () => {
    const facts: FingerprintableStripeDepositRecoveryEvidence = {
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      provider: "stripe",
      providerSessionId: "cs_test_1",
      providerPaymentId: "pi_test_1",
      providerChargeId: "ch_test_1",
      clientReferenceId: "attempt-1",
      checkoutStatus: "complete",
      checkoutPaymentStatus: "paid",
      checkoutMode: "payment",
      checkoutAmountTotalMinor: 1000n,
      checkoutCurrency: "usd",
      checkoutLivemode: false,
      checkoutMetadataAttemptId: "attempt-1",
      checkoutMetadataReference: "DP-1",
      checkoutMetadataWalletId: "wallet-1",
      checkoutMetadataUserId: "user-1",
      checkoutMetadataOrgId: "org-1",
      paymentIntentStatus: "succeeded",
      paymentIntentAmountMinor: 1000n,
      paymentIntentReceivedMinor: 1000n,
      paymentIntentCurrency: "usd",
      paymentIntentLivemode: false,
      paymentMetadataAttemptId: "attempt-1",
      paymentMetadataReference: "DP-1",
      paymentMetadataWalletId: "wallet-1",
      chargePaid: true,
      chargeCaptured: true,
      chargeRefunded: false,
      chargeAmountMinor: 1000n,
      chargeAmountCapturedMinor: 1000n,
      chargeCurrency: "usd",
      chargeLivemode: false,
    }
    const evidence: StripeDepositRecoveryEvidence = {
      ...facts,
      evidenceFingerprint: stripeDepositRecoveryEvidenceFingerprint(facts),
      retrievedAt: new Date("2026-08-12T00:00:00.000Z"),
    }

    expect(depositCreditFactsFromRecoveryEvidence(evidence)).toMatchObject({
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      providerPaymentId: "pi_test_1",
      providerChargeId: "ch_test_1",
      paymentIntentReceivedMinor: 1000n,
      chargeAmountCapturedMinor: 1000n,
    })
    expect(() =>
      assertDepositRecoveryEvidenceMatchesAttempt(
        {
          id: "attempt-1",
          provider: "stripe",
          providerSessionId: "cs_test_1",
          providerPaymentId: null,
          providerChargeId: null,
          publicReference: "DP-1",
          walletId: "wallet-1",
          createdByUserId: "user-1",
          organizationId: "org-1",
          amount: "10.00",
          walletCredit: "10.00",
          customerFee: "0.00",
          currency: "USD",
        },
        evidence,
      ),
    ).not.toThrow()
    expect(() =>
      assertDepositRecoveryEvidenceMatchesAttempt(
        {
          id: "attempt-1",
          provider: "stripe",
          providerSessionId: "cs_test_1",
          providerPaymentId: null,
          providerChargeId: null,
          publicReference: "DP-1",
          walletId: "wrong-wallet",
          createdByUserId: "user-1",
          organizationId: "org-1",
          amount: "10.00",
          walletCredit: "10.00",
          customerFee: "0.00",
          currency: "USD",
        },
        evidence,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "DEPOSIT_ATTEMPT_EVIDENCE_MISMATCH",
      }),
    )
  })

  it("accepts an expired local attempt only when exact paid authority later proves the credit", () => {
    const source: FingerprintableStripeDepositRecoveryEvidence = {
      source: "AUTHENTICATED_PROVIDER_RETRIEVAL",
      provider: "stripe",
      providerSessionId: "cs_test_late",
      providerPaymentId: "pi_test_late",
      providerChargeId: "ch_test_late",
      clientReferenceId: "attempt-late",
      checkoutStatus: "complete",
      checkoutPaymentStatus: "paid",
      checkoutMode: "payment",
      checkoutAmountTotalMinor: 1000n,
      checkoutCurrency: "usd",
      checkoutLivemode: false,
      checkoutMetadataAttemptId: "attempt-late",
      checkoutMetadataReference: "DP-LATE",
      checkoutMetadataWalletId: "wallet-1",
      checkoutMetadataUserId: "user-1",
      checkoutMetadataOrgId: "org-1",
      paymentIntentStatus: "succeeded",
      paymentIntentAmountMinor: 1000n,
      paymentIntentReceivedMinor: 1000n,
      paymentIntentCurrency: "usd",
      paymentIntentLivemode: false,
      paymentMetadataAttemptId: "attempt-late",
      paymentMetadataReference: "DP-LATE",
      paymentMetadataWalletId: "wallet-1",
      chargePaid: true,
      chargeCaptured: true,
      chargeRefunded: false,
      chargeAmountMinor: 1000n,
      chargeAmountCapturedMinor: 1000n,
      chargeCurrency: "usd",
      chargeLivemode: false,
    }
    const evidence: StripeDepositRecoveryEvidence = {
      ...source,
      evidenceFingerprint: stripeDepositRecoveryEvidenceFingerprint(source),
      retrievedAt: new Date(),
    }

    expect(() =>
      assertDepositRecoveryEvidenceMatchesAttempt(
        {
          id: "attempt-late",
          provider: "stripe",
          providerSessionId: "cs_test_late",
          providerPaymentId: null,
          providerChargeId: null,
          publicReference: "DP-LATE",
          walletId: "wallet-1",
          createdByUserId: "user-1",
          organizationId: "org-1",
          amount: "10.00",
          walletCredit: "10.00",
          customerFee: "0.00",
          currency: "USD",
          status: "EXPIRED",
        },
        evidence,
      ),
    ).not.toThrow()
  })
})
