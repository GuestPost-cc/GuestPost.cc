import { DocsArticle } from "../../../components/docs-article"
import { getDocumentationMetadata } from "../../../lib/docs-registry"

export const metadata = getDocumentationMetadata(
  "/docs/platform-owned-listings",
)

export default function PlatformOwnedListingsDocsPage() {
  return (
    <DocsArticle docHref="/docs/platform-owned-listings">
      <h2>How this category is defined</h2>
      <p>
        Platform-owned listings are marketplace listings created and managed by
        GuestPost staff. The marketplace identifies this ownership model so a
        customer can distinguish GuestPost-managed fulfillment from an
        independent publisher&apos;s fulfillment.
      </p>

      <h2>Our responsibilities</h2>
      <ul>
        <li>
          We are responsible for the accuracy of the platform listing and the
          authority used to coordinate its fulfillment.
        </li>
        <li>
          We apply the required readiness and quality checks before marketplace
          availability.
        </li>
        <li>
          We coordinate the accepted service and record delivery verification
          before completion.
        </li>
        <li>
          We operate the support, exception, cancellation, dispute, and remedy
          workflow for the placement.
        </li>
        <li>
          We control settlement sequencing and prevent release while required
          verification or review is incomplete.
        </li>
      </ul>

      <h2>Settlement for platform-owned listings</h2>
      <p>
        For these listings, GuestPost accepts direct operational responsibility
        for the agreed placement workflow. Required customer funds remain
        reserved until the recorded publication and review requirements permit
        the financial workflow to continue.
      </p>
      <p>
        If the agreed placement is not delivered or materially fails the
        recorded service requirements, GuestPost applies the policy-defined
        remedy. That can include correction, replacement, wallet credit, or
        refund depending on the order state and applicable policy.
      </p>

      <h2>Limitations</h2>
      <p>
        Search-engine indexing, ranking changes, traffic, conversions, and
        algorithmic positioning are third-party outcomes and are not guaranteed.
        Any placement-duration or correction commitment is limited to the
        warranty displayed with the selected service.
      </p>

      <h2>Publisher-owned listings vs platform-owned</h2>
      <p>
        For publisher-owned listings, the publisher is responsible for site
        control, listing representations, publication conduct, content legality,
        and delivery. GuestPost remains responsible for its own moderation,
        financial controls, evidence workflow, and dispute operations.
      </p>
    </DocsArticle>
  )
}
