import Link from "next/link"
import { DocsArticle } from "../../../components/docs-article"
import { getDocumentationMetadata } from "../../../lib/docs-registry"

export const metadata = getDocumentationMetadata("/docs/order-lifecycle")

export default function OrderLifecyclePage() {
  return (
    <DocsArticle docHref="/docs/order-lifecycle">
      <h2>1. Order creation</h2>
      <p>
        A customer selects a listing service and reviews the website access
        state, price and currency, turnaround, revisions, warranty,
        requirements, article responsibility, and campaign context. Those
        reviewed values become part of the submitted order.
      </p>

      <h2>2. Funding and reservation</h2>
      <p>
        When funding is required, the platform verifies the customer&apos;s
        available wallet balance and records the amount reserved for the order.
        A displayed balance or checkout attempt is not treated as successful
        funding until the provider and platform state confirm it.
      </p>

      <h2>3. Acceptance</h2>
      <p>
        A publisher-owned order must be accepted by the responsible publisher.
        Platform-owned fulfillment is assigned to an authorized GuestPost
        operator. Acceptance confirms responsibility for the recorded service;
        it does not authorize hidden scope changes.
      </p>

      <h2>4. Fulfillment and article history</h2>
      <p>
        Brief and article submissions remain associated with the order. When a
        new article version is supplied, the relevant role can review the
        immutable version history rather than silently replacing earlier
        content.
      </p>

      <h2>5. Delivery and verification</h2>
      <p>
        The fulfiller submits publication evidence. The platform records the
        delivery state and applies the required verification workflow before
        completion or settlement. A completion message alone is not delivery
        proof.
      </p>

      <h2>6. Customer review</h2>
      <p>
        The customer can review the delivered result during the window shown in
        the order. Confirmation, expiry of an applicable review window, or an
        opened dispute determines the next valid transition.
      </p>

      <h2>7. Cancellation and disputes</h2>
      <p>
        Pre-acceptance cancellation is different from cancellation after work
        begins. Accepted work may require counterparty consent or authorized
        review. Published or delivered work uses the dispute path so evidence,
        responsibility, and financial effects are recorded together.
      </p>

      <h2>8. Completion and settlement</h2>
      <p>
        Completion does not bypass financial checks. Publisher-owned orders
        enter the applicable settlement workflow; platform-owned orders record
        platform revenue directly. Active disputes, provider uncertainty, and
        required holds prevent premature release.
      </p>

      <h2>Related references</h2>
      <ul>
        <li>
          <Link href="/docs/payments-and-settlement">
            Payments and settlement
          </Link>
        </li>
        <li>
          <Link href="/legal/refund-policy">
            Refund, cancellation, and dispute policy
          </Link>
        </li>
        <li>
          <Link href="/docs/platform-owned-listings">
            Platform-owned listings
          </Link>
        </li>
      </ul>
    </DocsArticle>
  )
}
