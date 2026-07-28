import { DocsArticle } from "../../../components/docs-article"
import { getDocumentationMetadata } from "../../../lib/docs-registry"

export const metadata = getDocumentationMetadata("/docs/fraud-protection")

export default function FraudProtectionDocsPage() {
  return (
    <DocsArticle docHref="/docs/fraud-protection">
      <h2>Signals reviewed by the platform</h2>
      <ul>
        <li>Account anomalies and suspicious login behavior.</li>
        <li>
          Fraud-prone order patterns, repeated chargeback indicators, and
          suspicious settlement timing.
        </li>
        <li>
          False reporting signals and manipulated verification submissions.
        </li>
        <li>
          Payment, wallet, session, or device signals that require additional
          review.
        </li>
        <li>
          Publisher or customer account behavior indicative of coordinated
          abuse.
        </li>
      </ul>

      <h2>Preventive controls</h2>
      <ul>
        <li>
          Account checks (device/session validation, rate limits, and login
          protections).
        </li>
        <li>Manual review on high-value or high-risk orders.</li>
        <li>Suspicious order freeze and evidence capture before payout.</li>
        <li>
          Escalation to legal and payment rails in severe abuse scenarios.
        </li>
      </ul>

      <h2>What happens when fraud is confirmed</h2>
      <ul>
        <li>Immediate settlement hold for affected orders.</li>
        <li>
          Account-level enforcement: warning, temporary restriction, or
          suspension.
        </li>
        <li>Financial remediation: reversal, clawback, or reserve actions.</li>
        <li>
          Evidence retention for investigation and reporting requirements.
        </li>
        <li>Cooperation with processors or authorities where law requires.</li>
      </ul>

      <h2>Customer and publisher protection</h2>
      <p>
        Risk handling can reserve funds, hold settlement, preserve evidence, and
        route a case for authorized review. The outcome is applied to the order
        and financial records according to the available evidence and policy.
      </p>

      <h2>What to do if you suspect fraud</h2>
      <p>
        Report immediately through in-product escalation tools or at
        <a href="mailto:fraud@guestpost.cc"> fraud@guestpost.cc</a>. Include
        order IDs, screenshots, and any direct links to support quick action.
      </p>
    </DocsArticle>
  )
}
