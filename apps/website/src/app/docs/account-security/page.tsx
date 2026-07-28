import Link from "next/link"
import { DocsArticle } from "../../../components/docs-article"
import { getDocumentationMetadata } from "../../../lib/docs-registry"

export const metadata = getDocumentationMetadata("/docs/account-security")

export default function AccountSecurityPage() {
  return (
    <DocsArticle docHref="/docs/account-security">
      <h2>Sign-in and passwords</h2>
      <ul>
        <li>Use a unique password that is not used on another service.</li>
        <li>
          Access GuestPost only through an expected GuestPost website or account
          portal.
        </li>
        <li>
          Never send a password, reset token, session value, or one-time code to
          support.
        </li>
      </ul>

      <h2>Password recovery</h2>
      <p>
        Password-reset requests use a generic response so the public form does
        not reveal whether an email address has an account. Reset links should
        be treated as secrets and used only on the device where recovery was
        requested.
      </p>

      <h2>Organization access</h2>
      <p>
        Organization owners should grant the minimum role required and remove
        access when a member no longer needs it. Interface visibility does not
        replace server authorization; protected actions are checked again by the
        service.
      </p>

      <h2>Suspension and sessions</h2>
      <p>
        Account suspension is an audited lifecycle. Active sessions can be
        revoked when an account is suspended or a security event requires
        containment. Restoring account eligibility does not restore an old
        session.
      </p>

      <h2>Report suspicious activity</h2>
      <p>
        Use authenticated support for account-specific activity. For a suspected
        vulnerability, email{" "}
        <a href="mailto:security@guestpost.cc">security@guestpost.cc</a>. For
        suspected marketplace fraud, email{" "}
        <a href="mailto:fraud@guestpost.cc">fraud@guestpost.cc</a>.
      </p>

      <h2>Responsible security research</h2>
      <p>
        Good-faith reports should avoid privacy violations, data destruction,
        service disruption, social engineering, and access beyond what is
        necessary to demonstrate the issue. Include reproduction steps and
        affected URLs without sending unrelated personal data.
      </p>

      <h2>Related references</h2>
      <ul>
        <li>
          <Link href="/legal/privacy">Privacy Policy</Link>
        </li>
        <li>
          <Link href="/docs/fraud-protection">Fraud protection</Link>
        </li>
      </ul>
    </DocsArticle>
  )
}
