import type { Metadata } from "next"
import { ProsePage } from "../../components/prose-page"

export const metadata: Metadata = {
  title: "About | GuestPost",
  description:
    "GuestPost is a managed marketplace connecting brands with vetted publishers — built on escrowed payments and verified delivery.",
}

export default function AboutPage() {
  return (
    <ProsePage
      title="About GuestPost"
      subtitle="A marketplace where link building works like commerce — with escrow, verification, and accountability."
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
          <strong>Escrowed orders</strong> — customer funds are captured before
          work starts and released only after verified delivery.
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
          <strong>Financial-grade bookkeeping</strong> — every cent is ledgered
          and reconciled hourly against transaction history.
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
