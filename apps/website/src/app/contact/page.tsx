import type { Metadata } from "next"
import { ProsePage } from "../../components/prose-page"
import { PORTAL_URL, PUBLISHER_URL } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Get in touch with the GuestPost team — support, publisher relations, and general inquiries.",
  alternates: {
    canonical: "/contact",
  },
}

export default function ContactPage() {
  return (
    <ProsePage
      title="Contact"
      subtitle="We answer fast — most tickets get a first response within one business day."
    >
      <h2>Authenticated support</h2>
      <p>
        The fastest channel is the in-app support center: sign in and open a
        ticket from your dashboard. Tickets are tracked, threaded, and visible
        to the authorized support team.
      </p>
      <ul>
        <li>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={`${PORTAL_URL}/dashboard/support`}
          >
            Customer support center
          </a>
        </li>
        <li>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={`${PUBLISHER_URL}/dashboard/support`}
          >
            Publisher support center
          </a>
        </li>
      </ul>
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
