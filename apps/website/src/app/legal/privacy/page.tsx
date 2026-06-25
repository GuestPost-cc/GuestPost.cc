import type { Metadata } from "next"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Privacy Policy | GuestPost",
  description: "How GuestPost collects, uses, and protects personal data.",
}

export default function PrivacyPage() {
  return (
    <ProsePage title="Privacy Policy" subtitle="Last updated: June 12, 2026">
      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data</strong> — name, email, password hash,
          organization membership.
        </li>
        <li>
          <strong>Transaction data</strong> — orders, deposits, settlements,
          withdrawals, and the audit trail required to operate a money-handling
          marketplace.
        </li>
        <li>
          <strong>Payout details</strong> — publisher banking/PayPal/Wise
          details, stored encrypted (AES-256-GCM); raw access requires an
          explicitly granted, audited staff permission.
        </li>
        <li>
          <strong>Usage data</strong> — session, device, and IP information for
          security and fraud prevention.
        </li>
      </ul>
      <h2>What we never do</h2>
      <ul>
        <li>Sell personal data.</li>
        <li>
          Store card numbers — card payments are processed by Stripe; we never
          see the PAN.
        </li>
        <li>
          Expose publisher payout details to customers or other publishers.
        </li>
      </ul>
      <h2>Processors</h2>
      <p>
        Stripe (payments), Wise (payouts), and our infrastructure providers
        process data on our behalf under their own compliance programs (PCI-DSS
        for payment processors).
      </p>
      <h2>Retention</h2>
      <p>
        Financial records (transactions, settlements, audit logs) are retained
        as required for accounting and regulatory purposes, including after
        account closure. Non-financial personal data is deleted on request.
      </p>
      <h2>Your rights</h2>
      <p>
        You may request access, correction, or deletion of your personal data
        (subject to financial-record retention) via{" "}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="mailto:privacy@guestpost.cc"
        >
          privacy@guestpost.cc
        </a>
        .
      </p>
    </ProsePage>
  )
}
