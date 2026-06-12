import type { Metadata } from "next"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Terms of Service | GuestPost",
  description: "Terms governing use of the GuestPost marketplace for customers and publishers.",
}

export default function TermsPage() {
  return (
    <ProsePage title="Terms of Service" subtitle="Last updated: June 12, 2026">
      <h2>1. The service</h2>
      <p>
        GuestPost operates a managed marketplace connecting customers seeking content placements with publishers
        offering them. GuestPost provides escrow, verification, settlement, and dispute handling; it is not the
        author or publisher of third-party content placed through the platform.
      </p>
      <h2>2. Accounts and organizations</h2>
      <ul>
        <li>You must provide accurate registration information and keep credentials secure.</li>
        <li>Customer activity occurs under an organization; the organization owner is responsible for member activity.</li>
        <li>Publisher accounts must control the websites they list. Listing sites you do not control is grounds for removal.</li>
      </ul>
      <h2>3. Orders, escrow, and delivery</h2>
      <ul>
        <li>Placing an order captures the listed price from your wallet into escrow.</li>
        <li>Publishers may accept or decline orders. Accepted orders follow the platform fulfillment workflow.</li>
        <li>Settlement to the publisher begins only after delivery is verified and confirmed (or the review window lapses).</li>
      </ul>
      <h2>4. Fees</h2>
      <p>
        Customers pay the listed price per placement. Publishers pay a platform fee, deducted automatically at
        settlement, at the rate displayed at the time the order is settled.
      </p>
      <h2>5. Refunds, disputes, and chargebacks</h2>
      <ul>
        <li>Refunds follow the Refund Policy. Approved refunds return funds to the customer wallet.</li>
        <li>Open disputes pause settlement. Resolutions may include refund, restoration, or rejection.</li>
        <li>Initiating a card chargeback while funds are recoverable in-platform may result in account suspension; disputed amounts are held pending the card network outcome.</li>
      </ul>
      <h2>6. Prohibited use</h2>
      <ul>
        <li>Illegal content, malware, or deceptive placements.</li>
        <li>Attempting to settle marketplace-originated transactions off-platform to avoid fees.</li>
        <li>Manipulating metrics, reviews, or the dispute process.</li>
      </ul>
      <h2>7. Termination</h2>
      <p>
        We may suspend accounts that violate these terms. On termination, lawful balances remain withdrawable
        through the standard settlement and payout process after any open disputes resolve.
      </p>
      <h2>8. Liability</h2>
      <p>
        The platform is provided &quot;as is&quot;. To the maximum extent permitted by law, GuestPost&apos;s aggregate
        liability is limited to the fees it earned from the transactions giving rise to the claim.
      </p>
      <h2>9. Changes</h2>
      <p>We may update these terms; material changes are notified in-app at least 14 days before taking effect.</p>
    </ProsePage>
  )
}
