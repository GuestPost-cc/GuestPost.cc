import type { Metadata } from "next"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Refund Policy | GuestPost",
  description: "When and how orders on GuestPost are refunded.",
}

export default function RefundPolicyPage() {
  return (
    <ProsePage title="Refund Policy" subtitle="Last updated: June 12, 2026">
      <h2>Before acceptance</h2>
      <p>
        Orders a publisher has not yet accepted can be cancelled by you at any
        time for a full refund to your wallet — funds were in escrow and never
        reached the publisher.
      </p>
      <h2>After acceptance, before delivery</h2>
      <p>
        Cancellations during fulfillment are reviewed case-by-case. If the
        publisher has not delivered within the agreed workflow, you are entitled
        to a full refund.
      </p>
      <h2>After delivery</h2>
      <p>
        Once a placement is verified live and you confirm delivery (or the
        review window lapses), settlement to the publisher begins. Problems
        after that point — removed links, altered content — go through the
        dispute process: open a dispute from the order page, settlement pauses
        automatically, and our team reviews. Upheld disputes are refunded in
        full, including clawback from the publisher where settlement already
        released.
      </p>
      <h2>Wallet deposits</h2>
      <p>
        Unspent wallet balances are refundable to the original payment method on
        request. Contact support from your dashboard.
      </p>
      <h2>How refunds are paid</h2>
      <p>
        Refunds credit your organization wallet immediately on approval. Refunds
        to the original card are processed through Stripe and follow
        card-network timelines (typically 5–10 business days).
      </p>
      <h2>Chargebacks</h2>
      <p>
        Please contact us before initiating a card chargeback — in-platform
        refunds are faster. When a chargeback is filed, the disputed amount is
        automatically held from the wallet pending the card network&apos;s
        decision.
      </p>
    </ProsePage>
  )
}
