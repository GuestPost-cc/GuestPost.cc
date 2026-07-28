import { CURRENT_TERMS_LAST_UPDATED } from "@guestpost/shared"
import type { Metadata } from "next"
import Link from "next/link"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms governing customer, publisher, and platform-owned activity on the GuestPost marketplace.",
  alternates: {
    canonical: "/legal/terms",
  },
}

export default function TermsPage() {
  return (
    <ProsePage
      title="Terms of Service"
      subtitle={`Last updated: ${CURRENT_TERMS_LAST_UPDATED}`}
    >
      <div className="rounded-2xl border bg-accent/35 p-5 text-sm leading-7 text-foreground/72">
        These Terms allocate marketplace responsibilities but do not remove
        rights or liabilities that cannot lawfully be excluded. The operating
        legal entity, registered address, governing law, and dispute forum must
        be disclosed in the entity-specific onboarding or commercial terms
        before paid production use.
      </div>

      <h2>1. Agreement and eligibility</h2>
      <p>
        These Terms govern access to GuestPost and its customer, publisher,
        support, documentation, and marketplace services. By creating an
        account, accepting these Terms, or using a paid service, you agree on
        behalf of yourself and any organization you are authorized to represent.
      </p>
      <ul>
        <li>You must have legal capacity to enter a binding agreement.</li>
        <li>
          You must provide accurate information and must not use the service
          where prohibited by applicable law.
        </li>
        <li>
          Organization owners are responsible for inviting authorized members
          and managing their access.
        </li>
      </ul>

      <h2>2. Marketplace roles</h2>
      <ul>
        <li>
          <strong>Customer</strong> means a person or organization purchasing or
          managing placement services.
        </li>
        <li>
          <strong>Publisher</strong> means an independent account offering
          services through a publisher-owned listing.
        </li>
        <li>
          <strong>Platform-owned listing</strong> means a listing created and
          operationally managed by authorized GuestPost personnel.
        </li>
        <li>
          <strong>Publisher-owned listing</strong> means a listing supplied and
          fulfilled by an independent publisher.
        </li>
      </ul>

      <h2>3. Accounts, authority, and security</h2>
      <p>
        You must protect credentials, recovery links, and active sessions. You
        are responsible for activity performed by authorized organization
        members. Notify support promptly if an account, organization, or
        financial action may be compromised.
      </p>
      <p>
        GuestPost can require identity, organization, website-ownership,
        payment, tax, or payout verification where reasonably necessary for
        security, compliance, or provider requirements.
      </p>

      <h2>4. Listing ownership and responsibility</h2>
      <h3>Platform-owned listings</h3>
      <p>
        GuestPost is responsible for the accuracy of its platform listing,
        operational fulfillment coordination, delivery verification, support
        handling, settlement sequencing, and the policy-defined remedy when the
        agreed placement is not delivered or materially fails the recorded
        requirements.
      </p>
      <h3>Publisher-owned listings</h3>
      <p>
        The publisher is responsible for site control, listing accuracy,
        authority to sell the service, content and publication legality,
        intellectual-property compliance, and delivery against the accepted
        order. GuestPost remains responsible for its own moderation, payment
        controls, evidence workflow, and dispute operations.
      </p>

      <h2>5. Order formation</h2>
      <p>
        A listing is an invitation to submit an order, not an unconditional
        promise of availability. The binding service scope is the listing
        service, price and currency, brief, article responsibility, turnaround,
        revision and warranty terms, requirements, and other values recorded
        when the order is accepted.
      </p>
      <p>
        Neither party may silently replace the recorded scope through an
        off-platform message. Agreed changes must use an available platform
        workflow or documented support process.
      </p>

      <h2>6. Funding, reserved balances, and settlement</h2>
      <ul>
        <li>
          The platform may require customer funds to be available and reserved
          against an order before fulfillment begins.
        </li>
        <li>
          Provider checkout does not create platform credit until the paid event
          is verified and recorded.
        </li>
        <li>
          Delivery verification and the applicable review state must permit
          settlement before publisher funds become withdrawable.
        </li>
        <li>
          Disputes, chargebacks, fraud indicators, provider uncertainty, legal
          obligations, or reconciliation findings may hold or reverse an
          affected financial workflow.
        </li>
      </ul>
      <p>
        GuestPost is not a bank. References to wallet, reservation, balance,
        settlement, or hold describe platform accounting states and do not, by
        themselves, create a regulated deposit or escrow relationship.
      </p>

      <h2>7. Prices, fees, taxes, and providers</h2>
      <p>
        Customers pay the amount disclosed for the selected service plus any tax
        or additional charge shown before commitment. Publishers pay the
        platform fee disclosed in the publisher workflow. The effective fee for
        a completed publisher order is recorded with settlement.
      </p>
      <p>
        Payment and payout options depend on current provider support,
        environment, currency, account eligibility, and compliance review.
        GuestPost does not guarantee that every provider or method is available
        to every user.
      </p>
      <p>
        Each party is responsible for its own taxes, filings, and invoices
        unless applicable law requires GuestPost or a provider to collect,
        withhold, or report an amount.
      </p>

      <h2>8. Customer obligations</h2>
      <ul>
        <li>
          Provide lawful, accurate, and sufficiently complete requirements.
        </li>
        <li>
          Hold the necessary rights to customer-supplied articles, media,
          brands, destinations, and instructions.
        </li>
        <li>
          Review delivery within the displayed window and raise genuine concerns
          with relevant evidence.
        </li>
        <li>
          Do not request deceptive, illegal, infringing, undisclosed, or
          policy-prohibited publication.
        </li>
      </ul>

      <h2>9. Publisher obligations</h2>
      <ul>
        <li>List only websites and services you are authorized to control.</li>
        <li>
          Keep ownership, metrics, pricing, placement rules, availability, and
          service statements accurate.
        </li>
        <li>
          Review the complete order before acceptance and deliver only through
          lawful publication practices.
        </li>
        <li>
          Preserve required placement and order evidence for the displayed
          warranty and dispute periods.
        </li>
      </ul>

      <h2>10. Content and intellectual property</h2>
      <p>
        Each party retains ownership of material it owned before an order.
        Supplying content grants the receiving party and GuestPost a limited,
        non-exclusive license to store, review, transmit, format, and use that
        content only as reasonably required to provide, secure, support, and
        evidence the service.
      </p>
      <p>
        You must not upload content that infringes copyright, trademark,
        privacy, publicity, confidentiality, or other rights. GuestPost can
        remove or restrict content when a credible legal or policy complaint
        requires action.
      </p>

      <h2>11. Prohibited conduct and fraud</h2>
      <p>
        The <Link href="/legal/acceptable-use">Acceptable Use Policy</Link> is
        incorporated into these Terms. Prohibited conduct includes false
        identity or ownership, manipulated metrics, fabricated delivery,
        coordinated refund abuse, payment fraud, money laundering, sanctions
        evasion, malware, credential abuse, unauthorized access, and
        off-platform circumvention intended to avoid marketplace protections or
        fees.
      </p>
      <p>
        GuestPost can preserve evidence, restrict actions, hold affected funds,
        suspend accounts, reverse eligible financial entries, cooperate with
        providers, and make legally required reports when evidence supports
        those actions.
      </p>

      <h2>12. Verification, warranties, and SEO outcomes</h2>
      <p>
        Verification confirms only the recorded checks performed for the order.
        Search-engine indexation, ranking, traffic, conversions, and algorithmic
        positioning remain third-party outcomes and are not guaranteed.
        Placement-duration, correction, or replacement commitments are limited
        to the warranty displayed with the selected service.
      </p>

      <h2>13. Cancellations, disputes, refunds, and chargebacks</h2>
      <p>
        The <Link href="/legal/refund-policy">Refund Policy</Link> governs
        cancellation and refund eligibility. Pre-acceptance cancellation,
        accepted work, and published or delivered work use different review
        paths.
      </p>
      <p>
        Users retain lawful chargeback rights, but a chargeback does not erase
        the underlying order evidence. Fraudulent, duplicative, or abusive
        chargebacks can result in account restrictions and recovery action to
        the extent permitted by law.
      </p>

      <h2>14. Suspension and termination</h2>
      <p>
        GuestPost can restrict or suspend access when reasonably necessary to
        contain security risk, investigate fraud, meet legal or provider
        requirements, protect another user, or enforce these Terms. Where
        appropriate, the platform records the reason and preserves affected
        order and financial history.
      </p>
      <p>
        Termination does not cancel accrued payment obligations, active
        disputes, lawful holds, record-retention duties, indemnities, or
        provisions that are intended to survive.
      </p>

      <h2>15. Privacy and communications</h2>
      <p>
        The <Link href="/legal/privacy">Privacy Policy</Link> describes personal
        data processing. Transactional, security, legal, and service messages
        may be required to operate an account and are not marketing
        subscriptions.
      </p>

      <h2>16. Service availability and external systems</h2>
      <p>
        The service is provided on an “as available” basis. Maintenance,
        security incidents, provider outages, publisher systems, search engines,
        and events outside reasonable control can affect availability. GuestPost
        will not use this clause to avoid a policy-defined remedy for its own
        platform-owned fulfillment failure.
      </p>

      <h2>17. Liability</h2>
      <p>
        To the maximum extent permitted by law, GuestPost is not liable for
        indirect, incidental, special, punitive, or consequential loss, or for
        third-party SEO outcomes. Subject to non-excludable law, aggregate
        liability arising from a transaction is limited to the amount paid for
        the affected order or the fees GuestPost earned from it, as applicable.
      </p>
      <p>
        These limitations do not apply where liability cannot lawfully be
        limited, including applicable liability for fraud, willful misconduct,
        gross negligence, or the express platform-owned remedy stated in the
        order and Refund Policy.
      </p>

      <h2>18. Indemnity</h2>
      <p>
        A publisher must defend and indemnify GuestPost against third-party
        claims caused by its unlawful listing, content, publication,
        infringement, site operation, or material misrepresentation. A customer
        must do the same for unlawful customer-supplied content, destinations,
        instructions, or rights violations. Indemnity does not cover loss caused
        by GuestPost&apos;s own non-excludable misconduct.
      </p>

      <h2>19. Updates, notices, and general terms</h2>
      <p>
        Material updates use a new Terms version and may require renewed
        acceptance. If a provision is unenforceable, the remaining provisions
        continue to the extent permitted by law. Failure to enforce one breach
        is not a waiver of another. Assignment, governing law, dispute forum,
        and contracting-entity details must be completed in the applicable
        entity-specific commercial terms before production launch.
      </p>
    </ProsePage>
  )
}
