import type { Metadata } from "next"
import { ProsePage } from "../../../components/prose-page"

export const metadata: Metadata = {
  title: "Cookie Policy",
  description:
    "How GuestPost uses essential cookies, local storage, security telemetry, and any future non-essential tracking.",
  alternates: {
    canonical: "/legal/cookie-policy",
  },
}

export default function CookiePolicyPage() {
  return (
    <ProsePage title="Cookie Policy" subtitle="Last updated: July 27, 2026">
      <h2>1. Current approach</h2>
      <p>
        GuestPost uses cookies or similar browser storage when required for
        authentication, security, session continuity, account recovery, and
        essential service operation. The public marketing site is not intended
        to depend on advertising cookies.
      </p>

      <h2>2. Essential storage</h2>
      <p>
        Essential storage can maintain a signed-in session, protect a request,
        preserve a security state, remember a necessary account context, or
        complete an authentication or recovery flow. Disabling it can prevent
        sign-in or other protected functionality.
      </p>

      <h2>3. Security and reliability telemetry</h2>
      <p>
        The service may send technical error, performance, and security events
        to an authorized monitoring provider. These events are used to diagnose
        failures, detect abuse, and protect service reliability rather than to
        create advertising profiles.
      </p>

      <h2>4. Third-party workflows</h2>
      <p>
        Authentication, payment, payout, or authorized integration providers can
        set their own essential cookies when you visit their hosted pages. Their
        policies govern storage on their domains.
      </p>

      <h2>5. Non-essential analytics or advertising</h2>
      <p>
        If GuestPost introduces non-essential analytics, personalization, or
        advertising storage in a jurisdiction that requires consent, the site
        must provide the required notice and choice before activating it. This
        Policy must be updated to identify the categories and providers.
      </p>

      <h2>6. Controls</h2>
      <p>
        Browser settings can remove or block cookies. Blocking essential storage
        may sign you out or make authenticated services unavailable. Contact{" "}
        <a href="mailto:privacy@guestpost.cc">privacy@guestpost.cc</a> with
        questions about browser storage.
      </p>
    </ProsePage>
  )
}
