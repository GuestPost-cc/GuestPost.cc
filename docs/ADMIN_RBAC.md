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
orders through the publisher-equivalent delivery flow, and perform operational
verification and moderation.

Operations is not a platform-wide people or tenant administrator. It cannot
browse global Users, Organizations, Publishers, other Operations staff, or
Finance records.

### Finance

Finance owns publisher money movement and financial risk. It can inspect the
Publisher directory, manage publisher tiers, approve eligible settlements,
manage withdrawals and payouts, inspect revenue and reconciliation, and
approve financial cancellation/refund stages.

Finance cannot browse global Users or customer Organizations and cannot manage
platform inventory or fulfillment.

## Capability Matrix

| Area | Super Admin | Operations | Finance |
|---|---|---|---|
| Global Users | Full read and management | No access | No access |
| Staff account creation | Create Super Admin, Operations, and Finance | No access | No access |
| Customer Organizations | Full directory read | No access | No access |
| Publishers | Read and governance | No global directory | Read, tier, balances, debt, settlement and withdrawal context |
| Staff roles and Operations roster | Full management/read | No roster access | No access |
| Platform websites | Create, view all, manage, reassign | Create and manage assigned sites | No access |
| Marketplace inventory | Full moderation and platform inventory management | Operational moderation and inventory management | No admin marketplace access |
| Platform fulfillment queue | View all, claim as break-glass, assign/reassign | Assigned orders plus unassigned claimable orders; claim self | No access |
| Platform delivery | Full break-glass progression | Deliver only with an active assignment to self | Read only where required for a financial work item |
| Orders, disputes, cancellations | Full | Operational actions and contextual reads | Financial actions and contextual reads |
| Settlements | Full, including force approval | No settlement list/detail | List/detail, normal approval, cancellation and review |
| Withdrawals and payouts | Full | No access | Full finance lifecycle |
| Revenue and reconciliation | Full | No access | Full read/reconciliation |
| Publisher tier | Read/update | No access | Read/update |
| Platform fee | Read/update | Read only | Read/update |
| Support | Full | Platform operational workflow | Publisher replies; platform tickets are read-only except internal notes |
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

## Platform Fulfillment

- Operations sees only orders actively assigned to them and platform orders
  with no active assignment that are available to claim.
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
- A platform-fulfilled order recognizes the full order amount as platform
  revenue. It does not create a publisher settlement or publisher payout.

## Staff Administration And Monitoring

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
- `apps/api/src/modules/orders/deliveries.controller.ts`
- `apps/api/src/modules/orders/services/order-fulfillment-assignment.service.ts`
- `apps/api/src/modules/orders/services/order-operations.service.ts`
- `apps/api/src/modules/settlements/settlements.controller.ts`
- `apps/admin/src/app/dashboard/layout.tsx`
- `apps/admin/src/lib/use-require-role.tsx`
