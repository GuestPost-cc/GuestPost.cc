import type { Metadata } from "next"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description:
    "GuestPost rules against fraud, unlawful content, platform abuse, security attacks, and marketplace circumvention.",
  alternates: {
    canonical: "/legal/acceptable-use",
  },
}

export default function AcceptableUsePage() {
  return (
    <ProsePage
      title="Acceptable Use Policy"
      subtitle="Last updated: July 27, 2026"
    >
      <h2>1. Accurate identity and authority</h2>
      <p>
        Do not impersonate another person or organization, create deceptive
        accounts, misstate organization authority, sell access to an account, or
        list a website or service you are not authorized to control.
      </p>

      <h2>2. Listing and metric integrity</h2>
      <p>
        Do not fabricate or manipulate ownership evidence, traffic, authority
        metrics, audience information, publication history, availability,
        pricing, turnaround, placement attributes, or other listing facts.
      </p>

      <h2>3. Order and delivery integrity</h2>
      <p>
        Do not submit false briefs, hide prohibited requirements, fabricate
        publication evidence, substitute an undisclosed site or destination,
        misrepresent delivery, remove a placement contrary to the recorded
        warranty, or request a non-delivery refund after compliant delivery.
      </p>

      <h2>4. Financial abuse</h2>
      <p>
        Payment fraud, laundering, stolen instruments, chargeback abuse,
        collusive orders, self-dealing intended to extract funds, sanctions
        evasion, payout manipulation, duplicate refunds, and attempts to conceal
        the beneficial recipient are prohibited.
      </p>

      <h2>5. Security abuse</h2>
      <p>
        Do not access another account, probe beyond a good-faith security test,
        evade rate limits, distribute malware, scrape protected data, disrupt
        service, exploit a vulnerability for benefit, or expose credentials,
        tokens, private keys, or personal data.
      </p>

      <h2>6. Unlawful or harmful content</h2>
      <p>
        Do not use GuestPost for content or destinations that are unlawful,
        infringing, deceptive, defamatory, exploitative, malicious, or that
        violate privacy, confidentiality, publicity, consumer-protection,
        advertising, sanctions, or intellectual-property law.
      </p>

      <h2>7. Marketplace circumvention</h2>
      <p>
        Do not use marketplace discovery or order data to move the same
        transaction off-platform for the purpose of avoiding recorded
        requirements, fees, financial controls, evidence, support, or dispute
        handling.
      </p>

      <h2>8. Enforcement</h2>
      <p>
        Depending on evidence and risk, GuestPost can warn, limit an action,
        require verification, hold an affected financial workflow, remove a
        listing, suspend an account, preserve evidence, reverse eligible
        entries, notify a provider, or make a legally required report.
        Enforcement is subject to applicable law and the platform&apos;s
        authorization controls.
      </p>

      <h2>9. Reporting</h2>
      <p>
        Report marketplace fraud to{" "}
        <a href="mailto:fraud@guestpost.cc">fraud@guestpost.cc</a> and security
        vulnerabilities to{" "}
        <a href="mailto:security@guestpost.cc">security@guestpost.cc</a>. Use
        authenticated support for account-specific disputes.
      </p>
    </ProsePage>
  )
}
