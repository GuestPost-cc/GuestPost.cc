# Public Website Architecture and Operations

Last updated: 2026-07-28

## Purpose

`apps/website` is the public GuestPost application served locally on port
`3000`. It provides:

- Public product and publisher marketing
- Pricing principles
- Customer and publisher authentication entry points
- Operational documentation
- Legal and privacy policies
- Search-engine and LLM discovery files
- The handoff to the independently hosted WordPress journal

The website is not the customer portal, publisher portal, API, or WordPress
runtime. Those systems use separate origins and deployment boundaries.

## Product and Content Principles

The website must describe behavior that is supported by the product. Marketing
copy is not a substitute for database state, order terms, provider state, or a
legal agreement.

Required rules:

- Do not advertise customer or partner logos without documented authorization.
- Do not hard-code the configurable publisher platform fee in marketing copy.
- Do not advertise a payment or payout method unless the authenticated account
  currently exposes that method.
- Describe customer funds as platform wallet balances or reserved order funds.
  Do not imply a regulated bank, deposit, trust, or escrow arrangement unless
  the operating entity and counsel have approved that characterization.
- Distinguish platform-owned listings from publisher-owned listings.
- Do not guarantee search ranking, indexation, traffic, conversions, or
  algorithmic outcomes.
- Platform-owned copy must preserve GuestPost responsibility for listing
  accuracy, operational fulfillment, delivery verification, support,
  settlement sequencing, and the policy-defined remedy.
- Publisher-owned copy must preserve publisher responsibility for site control,
  listing representations, publication legality, intellectual property, and
  delivery. GuestPost remains responsible for its own moderation, payment,
  evidence, dispute, and support systems.

## Application Structure

Important files:

| Area | Source |
|---|---|
| Root metadata and global imports | `apps/website/src/app/layout.tsx` |
| Website-specific design tokens | `apps/website/src/app/website.css` |
| Homepage | `apps/website/src/app/page.tsx` |
| Homepage motion and visual treatments | `apps/website/src/app/page.module.css` |
| Client-side responsive header | `apps/website/src/components/site-header.tsx` |
| Server-rendered footer | `apps/website/src/components/site-footer.tsx` |
| Shared text-page shell | `apps/website/src/components/prose-page.tsx` |
| Documentation registry | `apps/website/src/lib/docs-registry.ts` |
| Documentation layout and navigation | `apps/website/src/app/docs/layout.tsx`, `apps/website/src/components/docs-navigation.tsx` |
| Documentation article and pagination | `apps/website/src/components/docs-article.tsx`, `apps/website/src/components/docs-pagination.tsx` |
| Canonical origins and indexable routes | `apps/website/src/lib/site-config.ts` |
| Generated LLM discovery response | `apps/website/src/app/llms.txt/route.ts` |
| Documentation route integrity check | `scripts/check-website-docs.ts` |
| Content Security Policy | `apps/website/src/proxy.ts` |
| Static security headers | `apps/website/next.config.ts` |

`site-chrome.ts` re-exports the header, footer, and public application origins
to preserve a small shared import surface.

Public presentation should remain server-rendered by default. Add a Client
Component only for actual interaction. The responsive header is a Client
Component because it owns mobile-menu state; the footer and marketing content
remain Server Components.

## Documentation Architecture

`apps/website/src/lib/docs-registry.ts` is the source of truth for public
documentation navigation and discovery. Each registered guide defines its
canonical route, title, navigation label, description, section, icon key,
content date, sitemap values, and whether it belongs in the concise footer.

The registry drives:

- The sticky desktop documentation sidebar
- The native, keyboard-accessible mobile documentation disclosure
- Active-route labels and documentation groups
- The documentation overview cards
- Breadcrumb context and previous/next links
- Documentation entries in `sitemap.xml`
- Documentation entries in `llms.txt`
- The selected documentation links in the site footer

The shared `/docs` layout owns `SiteHeader`, `DocsNavigation`, and `SiteFooter`.
Individual documentation pages render `DocsArticle` and their page-specific
content only. This prevents duplicate chrome and keeps documentation content
server-rendered. The navigation is the only Client Component because it reads
the current route and closes the mobile disclosure after navigation.

### Adding or changing a documentation page

1. Add or update the entry in `apps/website/src/lib/docs-registry.ts`.
2. Add the matching App Router `page.tsx` under `apps/website/src/app/docs`.
3. Export metadata with `getDocumentationMetadata()` and wrap the content in
   `DocsArticle` using the registered route.
4. Update the entry's `updatedAt` date when its public meaning changes.
5. Run `pnpm check:website-docs`.

The integrity check fails when a registered route has no page, an existing
documentation page is not registered, a route is duplicated, or a page uses an
unknown documentation section. It runs as part of `pnpm repo:check`.

Legal pages are intentionally not rendered inside the documentation layout.
They remain separate controlling documents. The sidebar and overview may link
to them, but product documentation must not summarize away, weaken, or conflict
with their terms. Production entity and jurisdiction details remain a launch
gate until confirmed by the operator and reviewed by qualified counsel.

## Visual System

The design direction is editorial credibility combined with financial and
operational control.

- Warm paper background
- Deep ink-navy primary surfaces
- Restrained verification green and muted sky blue
- Editorial display typography with a clear UI typeface
- Fine ledger-style grids and evidence-oriented status treatments
- Compact information hierarchy instead of generic SaaS decoration

Website color and typography overrides live in `website.css`. Do not change the
shared `packages/ui` theme solely to restyle the public website, because shared
tokens affect the customer, publisher, and administrative applications.

### Responsive behavior

- Minimum supported layout width: `320px`
- Primary mobile review widths: `360px`, `390px`, and `621px`
- Tablet review widths: `768px` and `1024px`
- Desktop review widths: `1199px`, `1237px`, and `1440px`
- Interactive controls should provide at least a `44px` touch target.
- Pages must not create horizontal document overflow.
- The trust rail is a correctly divided `2 x 2` grid below `1024px` and four
  equal columns from `1024px`.
- Footer link groups use a two-column narrow layout and one aligned desktop row.
- Documentation uses a full-width mobile disclosure below the article and a
  bounded, sticky sidebar at desktop widths. Navigation items maintain a
  minimum `44px` touch target and exact `aria-current` state.
- The hero headline uses separate block and line-height contexts for
  "Guest-post work" and "that holds up to scrutiny" so wrapping cannot overlap.

### Motion

Animations must be subtle and informative:

- Short entrance reveals
- Restrained hover elevation on interactive cards
- A low-intensity status pulse
- No essential content hidden behind JavaScript
- No continuous decorative movement that distracts from reading

Every animation must have a `prefers-reduced-motion: reduce` fallback. Do not
use `styled-jsx` in a Server Component. Use CSS modules or the website
stylesheet.

## Homepage Information Architecture

The homepage is organized as:

1. Managed-marketplace hero and order control map
2. Four-point trust rail
3. Customer and publisher paths
4. Recorded order workflow
5. Platform-owned and publisher-owned responsibility model
6. Customer-facing security controls
7. Commercial model and pricing principles
8. Documentation entry point
9. Role-specific final calls to action

Public security copy must describe customer-visible protection. Do not expose
internal staff roles, administrative topology, privileged workflows, or
security implementation details that do not help a customer make a safe
decision.

## WordPress Journal Boundary

The GuestPost journal is hosted separately on WordPress.

- Canonical journal origin: `NEXT_PUBLIC_BLOG_URL`
- Default: `https://blog.guestpost.cc`
- Header and footer journal links use the configured external origin.
- The legacy `/blog` route uses a permanent redirect to the configured origin.
- The main website sitemap does not claim WordPress articles.
- WordPress must publish and maintain its own canonical URLs, XML sitemap,
  robots policy, structured data, security updates, backups, and content
  retention.

Do not share authentication cookies between the public website and WordPress.
Any future cross-origin integration must be separately threat-modeled and added
to the Content Security Policy only when required.

## Security Boundary

Security is a release requirement, not a visual feature.

### Content Security Policy

`apps/website/src/proxy.ts` creates a per-request nonce and applies the CSP to
the request and response.

The policy:

- Defaults resources to the same origin
- Uses nonce-based scripts and `strict-dynamic`
- Allows development evaluation only outside production
- Restricts connections to configured application origins and Sentry ingestion
- Blocks plugins and embedded objects
- Restricts base URLs and form submission to the same origin
- Blocks framing with `frame-ancestors 'none'`
- Restricts manifests and workers
- Upgrades insecure requests in production

When adding a third-party script, font, frame, image host, analytics product, or
external API, do not broadly weaken the policy. Document the business need,
privacy impact, exact origin, and minimum required directive.

### Static response headers

`apps/website/next.config.ts` applies:

- `Strict-Transport-Security` in production
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- Strict origin referrer behavior
- Restrictive browser permissions
- Cross-origin opener and resource policies
- Disabled DNS prefetch
- Disabled legacy XSS filtering
- Disabled cross-domain policy files
- Origin-agent isolation

Authentication and password-recovery routes also receive:

- `Cache-Control: private, no-store, max-age=0`
- `X-Robots-Tag: noindex, nofollow, noarchive`

Route metadata independently marks these pages as non-indexable.

### Public security disclosure

`apps/website/public/.well-known/security.txt` provides the canonical security
contact and policy URL. Keep its `Expires` value in the future and refresh it
before expiration.

### Authentication entry points

Login and signup:

- Sanitize `returnTo` before constructing a destination.
- Use only configured customer and publisher origins.
- Keep password recovery responses account-enumeration resistant.
- Require Terms acceptance before email or OAuth registration.
- Record the immutable Terms version through the shared legal contract.

The current Terms identifier is defined in `packages/shared/src/legal.ts`.
Material changes require a new version.

## Search, Social, and Machine Discovery

| Resource | Source |
|---|---|
| XML sitemap | `apps/website/src/app/sitemap.ts` |
| Robots policy | `apps/website/src/app/robots.ts` |
| LLM reference | `apps/website/src/app/llms.txt/route.ts` |
| Web manifest | `apps/website/src/app/manifest.ts` |
| Social preview | `apps/website/public/og.png` |
| Root metadata | `apps/website/src/app/layout.tsx` |

Rules:

- Sitemap routes come from `INDEXABLE_ROUTES`.
- `lastModified` must represent a real content date, not request time.
- Login, signup, password recovery, and reset pages do not belong in the
  sitemap.
- Do not block `/_next/` assets in `robots.txt`; crawlers need page resources
  for rendering.
- WordPress posts belong to the WordPress sitemap.
- `llms.txt` must use factual summaries and canonical absolute URLs.
- Policy pages control over `llms.txt`, metadata, documentation, or marketing
  summaries when language differs.

## Documentation and Legal Routes

Operational documentation:

- `/docs`
- `/docs/order-lifecycle`
- `/docs/payments-and-settlement`
- `/docs/platform-owned-listings`
- `/docs/fraud-protection`
- `/docs/account-security`

Legal policies:

- `/legal/terms`
- `/legal/privacy`
- `/legal/refund-policy`
- `/legal/acceptable-use`
- `/legal/cookie-policy`

Documentation explains product behavior. Legal policies control contractual,
privacy, acceptable-use, cancellation, dispute, and refund obligations.

## Legal Production Gate

The repository does not currently contain confirmed production values for:

- Contracting legal entity
- Registered address
- Company or registration number
- Governing law
- Dispute forum or arbitration decision
- Primary privacy jurisdiction
- Privacy representative or regulator details
- Jurisdiction-specific retention periods
- Approved launch countries and consumer-versus-business scope

These details must not be guessed. Paid production launch remains blocked until
the operator supplies them and qualified counsel approves the entity-specific
Terms and Privacy disclosures.

No contract can exclude every form of liability. In particular, product
controls and legal language must not claim to remove applicable liability for
GuestPost's own fraud, gross negligence, willful misconduct, or mandatory
statutory obligations.

## Environment Variables

| Variable | Purpose | Local default |
|---|---|---|
| `NEXT_PUBLIC_WEBSITE_URL` | Canonical public website origin | `http://localhost:3000` |
| `NEXT_PUBLIC_BLOG_URL` | Independent WordPress journal origin | `https://blog.guestpost.cc` |
| `NEXT_PUBLIC_API_URL` | Public API origin | `http://localhost:4000` |
| `NEXT_PUBLIC_PORTAL_URL` | Customer application origin | `http://localhost:3001` |
| `NEXT_PUBLIC_PUBLISHER_URL` | Publisher application origin | `http://localhost:3002` |

`site-config.ts` also recognizes `NEXT_PUBLIC_SITE_URL` and
`NEXT_PUBLIC_APP_URL` for canonical-site compatibility, but
`NEXT_PUBLIC_WEBSITE_URL` is the repository's documented primary key.

Production values must be exact HTTPS origins without credentials, paths,
fragments, or wildcard hosts.

## Development and Validation

Start only the public website:

```bash
pnpm dev:website
```

Focused checks:

```bash
pnpm --filter @guestpost/website lint
pnpm --filter @guestpost/website typecheck
pnpm --filter @guestpost/website build
```

The root `pnpm lint` command includes `@guestpost/website`.

Before release:

1. Verify all public routes return the expected status.
2. Confirm `/blog` redirects to the configured WordPress origin.
3. Inspect `robots.txt`, `sitemap.xml`, `llms.txt`, and
   `/.well-known/security.txt`.
4. Confirm auth routes are no-store and no-index.
5. Confirm the CSP is present without browser violations.
6. Review desktop and mobile widths listed above.
7. Test keyboard navigation, visible focus, the mobile menu, and reduced motion.
8. Check for horizontal overflow and dead calls to action.
9. Verify public prices, fees, providers, warranties, and security claims
   against current product behavior.
10. Obtain business and legal approval for production policy text.

## Current Validation Record

The current 2026-07-28 website passed:

- Website ESLint
- Website TypeScript checking
- Next.js production build
- Static generation of 27 routes
- Desktop checks at `1199px` and `1237px`
- Mobile checks at `390px` and `621px`
- Header, hero, trust rail, primary touch-target, footer, and overflow checks
- Browser checks with no CSP, hydration, or runtime errors

The production build reports an existing non-blocking Sentry configuration
deprecation for `disableLogger`. Replace it with the supported Sentry/Turbopack
configuration during a dedicated observability-maintenance change.
