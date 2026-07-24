# Admin Staff RBAC

This document defines the staff authorization contract for the GuestPost admin
application. Backend guards are the source of truth. Navigation, page guards,
and action visibility must mirror the API, but must never be treated as the
security boundary.

## Roles

### Super Admin

Super Admin is the platform governance and break-glass role. It can access all
staff areas, manage users and roles, allocate work across staff, perform
high-impact overrides, and inspect audit records.

One exception is deliberately stronger than the role: decrypted payout data
requires the explicit `FINANCIAL_DATA_DECRYPT` permission. Super Admin does not
inherit this sensitive permission automatically.

### Operations

Operations owns platform inventory and platform fulfillment. It can enlist and
manage its platform sites, claim available platform orders, complete assigned
orders through the publisher-equivalent delivery flow, support platform
listings and orders assigned to it, and perform operational verification and
moderation.

Operations is not a platform-wide people or tenant administrator. It cannot
browse global Users, Organizations, Publishers, other Operations staff, or
Finance records.

### Finance

Finance owns publisher money movement and financial risk. It can inspect the
Publisher directory, manage publisher tiers, approve eligible settlements,
manage withdrawals and payouts, inspect revenue and reconciliation, and
approve financial cancellation/refund stages.

Finance cannot browse global Users or customer Organizations and cannot manage
platform inventory or fulfillment. It receives read-only marketplace listing
context when that evidence is needed to investigate an order, settlement, or
reconciliation issue.

## Capability Matrix

| Area | Super Admin | Operations | Finance |
|---|---|---|---|
| Command center governance summary | Full cross-domain read | No access | No access |
| Global Users | Full read and management | No access | No access |
| Staff account creation | Create Super Admin, Operations, and Finance | No access | No access |
| Customer Organizations | Full directory read | No access | No access |
| Publishers | Read and governance | No global directory | Read, tier, balances, debt, settlement and withdrawal context |
| Staff roles and Operations roster | Full management/read | No roster access | No access |
| Platform websites | Create, view all, manage, reassign | Create and manage assigned sites | No access |
| Marketplace inventory | Full moderation and platform inventory management | Operational moderation and assigned-inventory management | Read-only listing, publisher, price, service, and metric context; no moderation or inventory mutation |
| Platform fulfillment queue | View all, claim as break-glass, assign/reassign | Assigned orders plus unassigned claimable orders; claim self | No access |
| Platform delivery | Full break-glass progression | Deliver only with an active assignment to self | Read only where required for a financial work item |
| Orders, disputes, cancellations | Full | Assigned/claimable fulfillment, assigned-Support orders, and active operational exception contexts | Financial actions and contextual reads |
| Settlements | Full, including force approval | No settlement list/detail | List/detail, normal approval, cancellation and review |
| Withdrawals and payouts | Full | No access | Full finance lifecycle |
| Revenue and reconciliation | Full | No access | Full read/reconciliation |
| Publisher tier | Read/update | No access | Read/update |
| Platform fee | Read/update | Read only | Read/update |
| Support | Full | Assigned platform listing/order workflow; unassigned platform pool remains read-only until assigned | Publisher replies; platform tickets are read-only except internal notes |
| Domain verification | Full | Operational domain ownership verification | Contextual evidence only when needed for finance work |
| Delivery verification | Full | Review failed and manual-review deliveries | Contextual evidence only when needed for finance work |
| Audit logs | Full | No access | No access |
| Decrypted payout data | Only with explicit permission | No access | Only with explicit permission |

## Platform Site Ownership

- A site enlisted by an Operations user is always created with
  `managedByUserId` set to that user. A crafted request cannot assign it to a
  different operator.
- A site created by Super Admin may be assigned to an active, non-banned
  Operations user or left in the shared queue.
- Operations can list, open, update, pause, and archive only sites assigned to
  them. Direct access by a guessed site ID is rejected.
- Only Super Admin can reassign a platform site. Reassignment affects new work;
  active order and ticket assignments are not silently migrated.
- New platform orders for an assigned site receive an automatic active
  fulfillment assignment to that site's Operations owner.
- New platform sites require current staff-supplied Ahrefs organic traffic and
  Moz Domain Authority in the same transaction as the site/listing aggregate.
  Ahrefs DR and OpenPageRank collection is queued after commit. Provenance and
  freshness use the same model as publisher inventory; API collection failure
  never rolls back the durable aggregate.

## Marketplace Staff Context

- Marketplace list, stats, and detail reads are available to all staff roles.
  Finance is explicitly read-only; every mutation route remains unavailable to
  Finance regardless of client rendering.
- Operations may moderate listing status. Service changes still require either
  Super Admin or the assigned Operations owner of a platform site. Publisher
  contacts and Operations email addresses are withheld from Operations and
  Finance; Super Admin receives them only in explicit staff projections.
- Staff listing responses are allowlisted projections. They exclude raw metric
  provider payloads, integration credentials, internal fulfillment settings,
  and unrestricted related records.
- Domain metrics expose value, source, status, measured time, and collection
  time. GSC and GA4 appear only when that website has a visible linked data
  source; otherwise those sections remain absent.

## Platform Fulfillment

- Operations sees only orders actively assigned to them and platform orders
  with no active assignment that are available to claim. The order monitor may
  also show an order when its platform Support is assigned to the operator or
  it has an active dispute, cancellation, or delivery-verification context the
  operator is authorized to resolve.
- The Operations dashboard and Fulfillment page refresh active and claimable
  work every five seconds and on window focus. A new order becomes available
  independently; claiming one order never reserves or suppresses later orders
  for the same platform site.
- Claim creates a new self-assignment and never cancels someone else's active
  assignment. The database active-assignment uniqueness constraint resolves
  concurrent claims for the same order; the loser receives a conflict response
  and the client immediately refreshes its queue.
- Claim and reassignment also advance the order's optimistic-lock version in
  the same transaction. A claim, cancellation, publication, or reassignment
  racing on one order cannot both commit; cancellation-held orders are omitted
  from the claimable queue.
- Cross-staff assignment and reassignment are Super Admin-only and the target
  must be an active, non-banned Operations staff member.
- Progression and delivery actions verify the active assignment again in the
  service layer. Queue visibility alone never authorizes mutation.
- Operations performs daily work from `/dashboard/fulfillment`: claim or open
  an assignment, accept it, create and submit content for customer review,
  handle revisions, publish the approved content, track verification, and use
  the structured cancellation flow. Saving content and submitting it for
  review use assignment-version guards so reassignment cannot race a write.
- Active cancellation requests block incompatible fulfillment mutations until
  the request is resolved. Delivered history remains visible to the operator
  who completed it, while another operator's direct order ID is hidden.
- Operations direct-order reads apply the same scope as the order monitor.
  Unrelated guessed IDs return not found, and the response omits customer and
  staff/publisher contact fields, customer user type, publisher tier/trust,
  settlements, platform revenue, event metadata, and other finance or
  audit-only details. Finance receives settlement evidence but not customer
  contact/user-type fields or order-event metadata. Only Super Admin receives
  those global-oversight identifiers.
- Customer, publisher, and staff order pages render one canonical seven-stage
  lifecycle from `@guestpost/shared`. Exception states stay off the happy-path
  rail. Admin detail responses also include a server-derived integrity report
  for route ownership, assignment, delivery evidence, financial record,
  lifecycle events, and exception holds; the report exposes check outcomes,
  not hidden financial values or sensitive metadata.
- A platform-fulfilled order recognizes the full order amount as platform
  revenue. It does not create a publisher settlement or publisher payout.

## Staff Administration And Monitoring

- The Super Admin command center is a read-only governance surface. It uses a
  dedicated `SUPER_ADMIN` endpoint for exact cross-domain counts, a bounded
  server-prioritized exception queue, sanitized audit activity, and financial
  integrity summaries. It never exposes decrypted payout data and never moves
  break-glass mutations out of their dedicated reasoned and audited workflows.
- The Finance workbench is a read-only money-operations surface available only
  to Finance and Super Admin. Its exact server-side KPIs and bounded action
  queue cover settlements, withdrawals, payouts, reconciliation, cancellation
  decisions, disputes, publisher debt, and Support. Support is first within an
  equal severity band and is guaranteed a place in the bounded queue, while
  critical financial-integrity failures retain the highest severity.
- Finance Support obeys the existing role contract: Finance may reply to
  publisher/general tickets and add internal notes to platform tickets; Super
  Admin retains full reply capability. The overview never broadens those
  permissions.
- Finance activity is selected from a fixed action allowlist and excludes raw
  audit metadata, request/IP details, provider configuration, execution error
  payloads, payout credentials, and decrypted payout data. All financial
  mutations stay in the dedicated reasoned and audited workflows.
- The Operations workbench is a read-only assignment surface available only to
  Operations and Super Admin. `GET /admin/operations-workbench` combines exact
  counts and a bounded server-prioritized queue for assigned/claimable
  fulfillment, assigned platform Support, operational cancellations and
  disputes, verification, moderation, and assigned-site readiness. Assigned
  Support is guaranteed a queue place within an equal severity band.
- Only safely claimable fulfillment can mutate inline from the workbench, and
  it uses the existing transactional claim path. Every other item deep-links
  to its existing role-checked workspace. The workbench does not expose emails,
  credentials, audit metadata, raw provider errors, settlements, or revenue.
- Operations Support opens on the current user assignment by default;
  unassigned platform tickets remain read-only until assignment. Force-approval
  verification reporting is restricted to Super Admin.
- Access to one role-focused overview endpoint is not implied by access to any
  other overview or to contextual orders, disputes, cancellations, support, or
  financial records.

- Only Super Admin can open the Users & Staff area or create staff accounts.
  Staff creation supports `SUPER_ADMIN`, `OPERATIONS`, and `FINANCE` and creates
  a Better Auth credential account plus one active staff membership. It never
  provisions a customer Organization or Publisher profile.
- Customers and Publishers enter through their own signup flows. Super Admin
  can inspect and govern those accounts but cannot create them from the staff
  form or promote them into staff through the role-update endpoint.
- The Users & Staff page is ordered for operational monitoring: Staff first,
  then Publishers, then Customers. Staff details show role-specific activity
  without exposing Finance records to Operations or staff directories to
  non-Super Admin roles.
- An Operations member cannot be suspended or moved to another role while they
  own an active fulfillment assignment. Super Admin must reassign or complete
  the work first. Self-suspension, self-demotion, and removal of the last active
  Super Admin are rejected by the API.

### Performance metric definitions

- **Assigned**: distinct platform orders with an assignment history for that
  Operations member, including site-owner auto-assignment.
- **Claimed**: orders the Operations member explicitly self-claimed from the
  shared queue. Auto-assigned work is not counted as claimed.
- **Completed**: assigned orders whose fulfillment assignment is delivered and
  whose order has reached `DELIVERED`, `SETTLED`, or `COMPLETED`.
- **Sales**: full order amount for completed platform-fulfilled work, grouped
  by currency. This is operational production value, not staff compensation.
- **Finance handled volume**: gross order value associated with the Finance
  member's settlement approvals, grouped by currency; withdrawal and audited
  action counts are shown separately.

## Context Without Directory Access

Removing a global directory does not remove the minimum identity context needed
to complete a work item. An order, dispute, cancellation, support ticket,
settlement, or withdrawal may include a customer, organization, publisher, or
assignee name relevant to that record.

Context must remain scoped to the work item. It must not become a searchable or
pageable substitute for a forbidden global directory.

## Implementation Rules

1. Every `AdminController` and staff delivery route declares its own
   `@StaffRoles(...)`; missing metadata is fail-closed and covered by tests.
2. Backend service methods enforce ownership and assignment scope for direct-ID
   requests, not only list queries.
3. Admin navigation, page guards, queries, and action buttons mirror the API so
   staff do not encounter avoidable 403 errors.
4. High-impact actions require an audit reason where the existing workflow
   supports one.
5. New staff capabilities must update this matrix and RBAC coverage tests in the
   same change.

## Primary Code Locations

- `apps/api/src/modules/admin/admin.controller.ts`
- `apps/api/src/modules/admin/admin.service.ts`
- `apps/api/src/modules/admin/operations-workbench.service.ts`
- `apps/api/src/modules/orders/deliveries.controller.ts`
- `apps/api/src/modules/orders/services/order-fulfillment-assignment.service.ts`
- `apps/api/src/modules/orders/services/order-operations.service.ts`
- `apps/api/src/modules/settlements/settlements.controller.ts`
- `apps/admin/src/app/dashboard/layout.tsx`
- `apps/admin/src/lib/use-require-role.tsx`
