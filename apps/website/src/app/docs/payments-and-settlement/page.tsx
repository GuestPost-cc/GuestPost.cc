import Link from "next/link"
import { DocsArticle } from "../../../components/docs-article"
import { getDocumentationMetadata } from "../../../lib/docs-registry"

export const metadata = getDocumentationMetadata(
  "/docs/payments-and-settlement",
)

export default function PaymentsAndSettlementPage() {
  return (
    <DocsArticle docHref="/docs/payments-and-settlement">
      <h2>Customer funding</h2>
      <p>
        The customer account shows the payment option currently enabled for its
        environment and eligibility. Provider checkout completion alone does not
        create platform credit; the platform waits for a verified paid event and
        records the wallet and ledger change together.
      </p>

      <h2>Reserved order balances</h2>
      <p>
        An order can reserve available wallet funds so they cannot be reused for
        another purchase. This documentation describes a controlled platform
        balance. It does not characterize GuestPost as a bank or use “escrow” as
        a substitute for an entity-specific regulated arrangement.
      </p>

      <h2>Refunds and wallet credits</h2>
      <p>
        Approved refunds are recorded through the order workflow. Depending on
        the order state and payment history, the result may be a wallet credit
        or an eligible return through the original provider. Provider timelines
        and legal retention requirements can continue after the platform records
        the decision.
      </p>

      <h2>Publisher settlement</h2>
      <p>
        For publisher-owned orders, settlement records the gross amount,
        applicable platform fee, and publisher share. The effective fee is
        captured for the settlement; marketing text is not the source of truth
        for a historical order.
      </p>

      <h2>Withdrawals and payout providers</h2>
      <p>
        The publisher account shows the provider and currency options currently
        available. Eligibility, onboarding, provider verification, rollout
        controls, or compliance review may limit availability. A requested
        withdrawal remains distinct from a provider transfer and a completed
        bank payout.
      </p>

      <h2>Holds and uncertain outcomes</h2>
      <p>
        Disputes, chargebacks, fraud indicators, invalid payout methods,
        provider uncertainty, and reconciliation findings can hold funds while
        evidence is reviewed. GuestPost does not mark an uncertain provider send
        as paid merely to clear an operational queue.
      </p>

      <h2>Related references</h2>
      <ul>
        <li>
          <Link href="/pricing">Pricing principles</Link>
        </li>
        <li>
          <Link href="/legal/refund-policy">Refund policy</Link>
        </li>
        <li>
          <Link href="/docs/fraud-protection">Fraud protection</Link>
        </li>
      </ul>
    </DocsArticle>
  )
}
