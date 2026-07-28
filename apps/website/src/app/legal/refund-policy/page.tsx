import type { Metadata } from "next"
import Link from "next/link"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Refund, cancellation, and dispute policy",
  description:
    "How GuestPost handles pre-acceptance cancellation, accepted work, delivery disputes, wallet credits, and platform-owned remedies.",
  alternates: {
    canonical: "/legal/refund-policy",
  },
}

export default function RefundPolicyPage() {
  return (
    <ProsePage
      title="Refund, cancellation, and dispute policy"
      subtitle="Last updated: July 27, 2026"
    >
      <h2>1. Scope</h2>
      <p>
        This Policy applies to GuestPost marketplace orders and related wallet
        credits. Eligibility depends on the recorded order stage, accepted
        service, evidence, responsibility, and payment history. Mandatory legal
        rights continue to apply.
      </p>

      <h2>2. Before acceptance</h2>
      <p>
        A customer can cancel an unaccepted order through the available
        workflow. The reserved order amount is released to the customer wallet
        when no accepted work, provider restriction, fraud hold, or legal hold
        prevents that action.
      </p>

      <h2>3. After acceptance but before delivery</h2>
      <p>
        Accepted work is a committed service. Cancellation may require
        counterparty consent or authorized review because work may already have
        started. The reviewer considers completed work, avoidable loss, recorded
        milestones, fault, policy violations, and available evidence.
      </p>

      <h2>4. Delivered or published work</h2>
      <p>
        Delivered or published work uses the dispute workflow. A customer must
        raise the issue during the review or warranty period displayed with the
        order unless mandatory law requires a longer period. Relevant reasons
        can include non-publication, wrong destination, materially incorrect
        placement, missing agreed attributes, unauthorized substitution, or
        breach of the recorded warranty.
      </p>

      <h2>5. Platform-owned listing responsibility</h2>
      <p>
        GuestPost accepts operational responsibility for platform-owned
        listings. If the agreed placement is not delivered or materially fails
        the recorded service requirements, GuestPost applies an appropriate
        remedy based on the order state. A remedy can include correction,
        re-performance, an approved replacement, wallet credit, or refund.
      </p>
      <p>
        Search ranking, indexation, traffic, conversion, and other third-party
        SEO outcomes are not placement defects unless the selected service
        expressly states otherwise.
      </p>

      <h2>6. Publisher-owned listing responsibility</h2>
      <p>
        The publisher is responsible for its listing representations and
        delivery. GuestPost reviews the evidence and applies the platform
        cancellation, dispute, refund, settlement, and recovery workflow.
        Publisher responsibility does not remove GuestPost&apos;s responsibility
        for its own platform operations.
      </p>

      <h2>7. Dispute review</h2>
      <ul>
        <li>
          An active dispute holds the affected fulfillment and settlement.
        </li>
        <li>Each party may be asked for order-specific evidence.</li>
        <li>
          Operational review and any required financial approval remain
          separated for sensitive refund decisions.
        </li>
        <li>
          The outcome records responsibility so a platform- or
          customer-attributed refund is not automatically treated as publisher
          fault.
        </li>
      </ul>

      <h2>8. Refund destination</h2>
      <p>
        An approved order refund is normally recorded as a customer wallet
        credit. An eligible return to the original payment method depends on the
        funding history, provider support, account status, fraud review, and
        applicable law. GuestPost does not send refunds to an unrelated payment
        destination.
      </p>

      <h2>9. Timing</h2>
      <p>
        Wallet credits are recorded when the approved financial transaction
        commits. Returns through an external provider can take additional time
        set by that provider or financial institution. Support can confirm the
        platform state but cannot guarantee a bank&apos;s posting date.
      </p>

      <h2>10. Chargebacks</h2>
      <p>
        Customers retain lawful chargeback rights. Contacting support first can
        preserve the fastest evidence-backed resolution, but does not waive a
        legal right. A chargeback can hold related funds and account actions
        while the provider process is active. Fraudulent, duplicate, or abusive
        chargebacks can lead to restrictions and lawful recovery action.
      </p>

      <h2>11. Off-platform arrangements</h2>
      <p>
        GuestPost cannot apply its financial or evidence controls to a private
        payment or replacement arranged outside the platform. Off-platform
        arrangements may breach the <Link href="/legal/terms">Terms</Link> and
        are excluded from platform remedies to the extent permitted by law.
      </p>

      <h2>12. Requesting review</h2>
      <p>
        Use the order&apos;s cancellation, dispute, or support action and
        include the relevant order ID, affected requirement, publication URL,
        and evidence. Do not submit passwords, full payment credentials, or
        unrelated personal data.
      </p>
    </ProsePage>
  )
}
