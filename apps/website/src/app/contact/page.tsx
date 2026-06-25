import type { Metadata } from "next"
import { ProsePage } from "../../components/prose-page"
import { PORTAL_URL } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "Contact | GuestPost",
  description:
    "Get in touch with the GuestPost team — support, publisher relations, and general inquiries.",
}

export default function ContactPage() {
  return (
    <ProsePage
      title="Contact"
      subtitle="We answer fast — most tickets get a first response within one business day."
    >
      <h2>Customers &amp; publishers</h2>
      <p>
        The fastest channel is the in-app support center: sign in and open a
        ticket from your dashboard. Tickets are tracked, threaded, and visible
        to our whole operations team.
      </p>
      <p>
        <a
          className="text-primary underline-offset-4 hover:underline"
          href={`${PORTAL_URL}/dashboard/support`}
        >
          Open a support ticket →
        </a>
      </p>
      <h2>General inquiries</h2>
      <p>
        Email{" "}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="mailto:hello@guestpost.cc"
        >
          hello@guestpost.cc
        </a>{" "}
        for partnerships, press, or anything that doesn&apos;t fit a ticket.
      </p>
      <h2>Security disclosures</h2>
      <p>
        Found a vulnerability? Email{" "}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="mailto:security@guestpost.cc"
        >
          security@guestpost.cc
        </a>
        . We acknowledge within 48 hours and don&apos;t pursue good-faith
        researchers.
      </p>
    </ProsePage>
  )
}
