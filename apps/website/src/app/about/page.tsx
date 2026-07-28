import type { Metadata } from "next"
import { ProsePage } from "../../components/prose-page"

export const metadata: Metadata = {
  title: "About",
  description:
    "GuestPost is a managed marketplace connecting customers with reviewed publisher inventory through recorded orders and verified delivery.",
  alternates: {
    canonical: "/about",
  },
}

export default function AboutPage() {
  return (
    <ProsePage
      title="About GuestPost"
      subtitle="A marketplace where guest-post work follows recorded requirements, verified delivery, and accountable settlement."
    >
      <p>
        Guest posting has historically run on spreadsheets, DMs, and trust.
        Payments go out before content goes live; links disappear weeks later;
        nobody can prove what was agreed. We built GuestPost to replace that
        with the mechanics of a real marketplace.
      </p>
      <h2>What makes us different</h2>
      <ul>
        <li>
          <strong>Funded orders</strong> — required customer funds are reserved
          against accepted work and settlement follows the verified order state.
        </li>
        <li>
          <strong>Verified placements</strong> — every order passes a
          publication check before settlement begins.
        </li>
        <li>
          <strong>Protected settlement</strong> — dual approval, dispute pauses,
          and refund clawbacks keep both sides honest.
        </li>
        <li>
          <strong>Vetted inventory</strong> — every listing is reviewed by our
          moderation team before it can sell.
        </li>
        <li>
          <strong>Durable financial records</strong> — money movements are
          recorded through explicit wallet, ledger, settlement, and payout
          states.
        </li>
      </ul>
      <h2>Who it serves</h2>
      <p>
        SEO teams and agencies that need placements at scale without procurement
        chaos — and publishers who want prepaid, well-specified orders instead
        of invoice chasing.
      </p>
    </ProsePage>
  )
}
