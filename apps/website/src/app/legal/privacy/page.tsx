import type { Metadata } from "next"
import Link from "next/link"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How GuestPost processes account, marketplace, payment, security, support, and integration data.",
  alternates: {
    canonical: "/legal/privacy",
  },
}

export default function PrivacyPage() {
  return (
    <ProsePage title="Privacy Policy" subtitle="Last updated: July 27, 2026">
      <div className="rounded-2xl border bg-accent/35 p-5 text-sm leading-7 text-foreground/72">
        The operating legal entity, registered address, applicable privacy
        representative, and regulator details must be added when the production
        business entity and supported jurisdictions are finalized.
      </div>

      <h2>1. Scope and roles</h2>
      <p>
        This Policy covers the public website and GuestPost customer, publisher,
        support, administrative, marketplace, payment, and integration
        workflows. GuestPost acts as controller for account administration,
        marketplace operations, security, fraud prevention, support, and its own
        financial records. Customers and publishers may separately control
        personal data they include in content or instructions.
      </p>

      <h2>2. Information we process</h2>
      <ul>
        <li>
          <strong>Account data:</strong> name, email, role, organization,
          publisher relationship, verification state, and preferences.
        </li>
        <li>
          <strong>Authentication and security data:</strong> sessions, IP
          address, device and browser signals, access events, recovery activity,
          rate-limit events, and security findings.
        </li>
        <li>
          <strong>Marketplace data:</strong> websites, listings, services,
          metrics, moderation decisions, orders, briefs, articles, evidence,
          messages, cancellations, disputes, and support history.
        </li>
        <li>
          <strong>Financial operations data:</strong> prices, wallet entries,
          funding attempts, provider references, reservations, settlements,
          refunds, withdrawals, payout states, reconciliation findings, and
          audit evidence.
        </li>
        <li>
          <strong>Integration data:</strong> connection identifiers,
          permissions, selected properties, synchronization status, and the
          marketplace metrics produced by an authorized integration.
        </li>
        <li>
          <strong>Communications:</strong> support requests, policy notices,
          security reports, and other correspondence.
        </li>
      </ul>
      <p>
        Payment providers process card or bank information under their own
        terms. GuestPost does not intentionally store raw card numbers.
      </p>

      <h2>3. Purposes and legal bases</h2>
      <ul>
        <li>Perform the service and administer the user agreement.</li>
        <li>
          Protect legitimate interests in platform security, fraud prevention,
          service reliability, support, moderation, and legal claims.
        </li>
        <li>
          Meet accounting, tax, sanctions, payment-provider, court, and other
          legal obligations.
        </li>
        <li>
          Use consent where applicable law requires it, including for
          non-essential tracking if introduced.
        </li>
      </ul>

      <h2>4. Service providers and recipients</h2>
      <p>
        Data may be processed by infrastructure, database, authentication,
        email, monitoring, customer-support, payment, payout, analytics, and
        integration providers where required to operate the service. Stripe,
        eligible payout providers, Sentry, and authorized Google integrations
        are examples depending on the enabled workflow.
      </p>
      <p>
        Data may also be disclosed to professional advisers, insurers,
        processors, financial institutions, counterparties where required for an
        order, and authorities where lawfully required. GuestPost does not sell
        personal data as an independent product.
      </p>

      <h2>5. International processing</h2>
      <p>
        Providers and marketplace participants may operate in different
        countries. Where required, GuestPost will use an approved transfer
        mechanism and contractual or organizational safeguards. The final
        production policy must identify the operating entity&apos;s primary
        location and jurisdiction-specific transfer mechanism.
      </p>

      <h2>6. Cookies and local storage</h2>
      <p>
        Essential cookies or similar storage may support authentication,
        security, session continuity, CSRF protection, and account recovery. The
        separate <Link href="/legal/cookie-policy">Cookie Policy</Link>{" "}
        describes the current categories and how future non-essential tracking
        must be handled.
      </p>

      <h2>7. Security</h2>
      <p>
        GuestPost uses role-based authorization, session controls, transport
        encryption, restricted administrative access, audit events, provider
        verification, and additional controls appropriate to the affected data.
        No internet service can guarantee absolute security.
      </p>

      <h2>8. Retention</h2>
      <p>Retention depends on purpose rather than one universal period:</p>
      <ul>
        <li>
          Account and organization data is retained while the account is active
          and for a reasonable closure and claims period.
        </li>
        <li>
          Financial, tax, settlement, payout, and audit records are retained for
          applicable accounting, provider, fraud, and legal obligations.
        </li>
        <li>
          Security and fraud evidence is retained for investigation,
          enforcement, chargeback defense, and recurrence prevention.
        </li>
        <li>
          Support and order content is retained while needed to operate the
          order, resolve disputes, and meet legal obligations.
        </li>
      </ul>
      <p>
        The production retention schedule must supply jurisdiction-specific
        periods once the legal entity and launch regions are approved.
      </p>

      <h2>9. Automated tools</h2>
      <p>
        Automated signals can prioritize review, apply rate limits, or hold a
        risky workflow. Material enforcement and sensitive financial exceptions
        can be routed to authorized human review. Contact support to challenge
        an account-specific outcome.
      </p>

      <h2>10. Individual rights</h2>
      <p>
        Depending on location, you may have rights to access, correct, delete,
        restrict, object, receive a portable copy, withdraw consent, or complain
        to a regulator. These rights can be limited by identity verification,
        another person&apos;s rights, legal privilege, fraud prevention, and
        mandatory retention.
      </p>
      <p>
        Submit a request to{" "}
        <a href="mailto:privacy@guestpost.cc">privacy@guestpost.cc</a>. Do not
        send passwords, payment credentials, or unnecessary identity documents
        by email.
      </p>

      <h2>11. Children</h2>
      <p>
        GuestPost is a business marketplace and is not directed to children.
        Users must have legal capacity to enter the applicable agreement. Report
        suspected child data to the privacy contact.
      </p>

      <h2>12. Changes and contact</h2>
      <p>
        Material changes will update the date and may require notice or renewed
        consent where law requires it. Contact{" "}
        <a href="mailto:privacy@guestpost.cc">privacy@guestpost.cc</a> with
        privacy questions or requests.
      </p>
    </ProsePage>
  )
}
