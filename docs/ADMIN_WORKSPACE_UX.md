# Admin Workspace UX Contract

This document defines the presentation and workflow conventions for the
GuestPost Admin application. The authorization contract remains in
[`ADMIN_RBAC.md`](./ADMIN_RBAC.md); backend guards and service-level scoping are
always the security boundary.

## Role workspaces

| Role | Workspace purpose | Visual accent | Sensitive areas intentionally absent |
|---|---|---|---|
| Super Admin | Cross-platform governance, exception oversight, staff and tenant administration | Violet | Decrypted payout data without the explicit permission |
| Operations | Assigned and claimable fulfillment, support, verification, moderation, and assigned inventory | Blue | Global people directories, finance, audit logs, publisher import |
| Finance | Publisher funds, support, settlements, payouts, reconciliation, and financial risk | Emerald | Inventory mutations, fulfillment management, global users, audit logs |

Navigation is filtered for orientation only. Every route must also retain its
page guard, and every API call must retain backend role and ownership checks.
Direct navigation to an unavailable route must fail closed.

## Shared page structure

All Admin routes use the Admin workspace primitives in
`apps/admin/src/components/admin-workspace.tsx`:

- `AdminPage` provides the responsive page boundary and prevents accidental
  document-level horizontal scrolling.
- `AdminPageHeader` provides a consistent eyebrow, title, task description,
  status badges, and action area.
- `AdminFilterBar` uses a blue information surface, reports active filters and
  result totals, and offers one predictable clear action.
- `AdminMetricCard` applies semantic tones: neutral for context, blue for
  information, green for healthy/ready, amber for attention, and red for risk.
- `AdminNotice`, `AdminEmptyState`, and `AdminStatusBadge` keep guidance and
  state presentation consistent.

Tables may scroll inside their own bounded container on narrow screens. The
document itself must not scroll horizontally. Primary actions use the platform
primary color, ordinary navigation and secondary actions use outline styling,
and destructive styling is reserved for destructive or break-glass actions.

## Workflow and data rules

- Overview metrics come from the existing exact, role-scoped workbench APIs.
  The UI does not derive security or money decisions from client-side totals.
- List pages expose the filters needed by that role's workflow and make active
  state, result count, clear behavior, loading, error, and empty states visible.
- Detail pages keep context, state, back navigation, and allowed actions in a
  consistent header. High-impact actions remain in their dedicated reasoned,
  confirmed, concurrency-protected, and audited flows.
- Private identifiers, audit metadata, credentials, provider payloads, and
  decrypted payout data are never added merely to make a page more detailed.
- A disabled control is not an authorization boundary. Unimplemented protected
  controls remain disabled until a secured API, authorization policy, and audit
  event exist.

## Order monitor and detail workflow

- `GET /admin/orders` is server-paginated and returns exact totals for the
  authenticated role's base scope. Search is limited to fields that role may
  receive; only Super Admin may search or receive customer email.
- Super Admin sees platform-wide oversight and break-glass escalation context.
  Operations sees assigned or claimable fulfillment plus assigned Support and
  active operational-exception context. Finance sees financial context without
  fulfillment controls.
- Operations order responses omit customer contact/user-type fields, publisher
  contact/tier/trust data, settlements, and event metadata. Finance responses
  omit customer contact/user-type fields and event metadata while retaining the
  settlement evidence required for financial decisions.
- Order rows lead to the role's dedicated dispute, cancellation, verification,
  fulfillment, or settlement workspace. Destructive mutations do not run from
  the list.
- The detail page presents one role-appropriate next action, then lifecycle,
  parties, requirements, evidence, settlement context where permitted, and the
  role-safe timeline. An out-of-scope direct ID uses a non-enumerating error
  state.
- The lifecycle rail is the shared `OrderLifecycleProgress` component used by
  customer, publisher, and staff detail pages. Admin adds a server-derived
  integrity report; the client does not infer route, evidence, or money
  consistency from presentation data.
- Super Admin force cancellation remains a server-authorized, audited,
  optimistic-concurrency-protected break-glass action. The UI requires a
  meaningful reason and exact full order-ID confirmation; normal cancellation
  and dispute workflows remain the default.

## Marketplace inventory and detail workflow

- The inventory page uses exact server pagination, compact workflow KPIs,
  role-visible filters, desktop rows, and mobile cards. At 390 pixels the table
  is replaced by cards and the document must have no horizontal overflow.
- Listing rows show ownership, publisher display name, active services,
  starting price, domain verification, and Ahrefs/Moz/OpenPageRank readiness.
  Missing and stale metrics are explicit states rather than zero values.
- Listing detail combines public listing facts with publisher/owner basics,
  service rows, placement policy, metric source/freshness, and visible Google
  connections. GSC/GA4 stays absent when not linked.
- Finance receives the same investigation context in a clearly labelled
  read-only view. Operations sees moderation and only the service controls
  authorized by assignment. Super Admin additionally sees global listing flags
  and protected contact context.
- Normal approval never silently forces a domain-verification override.
  Break-glass behavior, where retained, remains server-authorized and audited.

## Review checklist

For every Admin UI change:

1. Verify Super Admin, Operations, and Finance navigation separately.
2. Attempt direct access to at least one unavailable role route.
3. Confirm data comes from the intended scoped endpoint and actions still use
   the existing authorization and concurrency contract.
4. Check desktop, tablet, and 390-pixel mobile layouts for document overflow.
5. Run Admin typecheck and lint plus the focused Admin RBAC/scoping suites.
6. Inspect browser console errors without performing destructive actions.
