# Support messaging

## Purpose

Support tickets are a shared conversation between a customer, the publisher or
Operations team fulfilling an order, and authorized staff. The API, not the
dashboard, decides who may see or mutate a ticket. Every client renders the
server-projected `sender.party`, `sender.displayName`, and `sender.isSelf`
fields; clients must not infer a sender from a current user role or email.

The implementation lives in `apps/api/src/modules/support/`. The canonical
client DTOs and query keys live in
`packages/api-client/src/services/support.ts`, and the shared conversation UI
lives in `packages/ui/src/components/support-conversation.tsx`.

## Actors and routing

| Ticket kind | Requester | Routing source | Public participants |
|---|---|---|---|
| General support | Customer only | Customer organization; Platform queue | Customer organization, assigned Operations, Super Admin |
| Publisher order | Customer or authorized publisher | Order channel and website publisher | Customer organization, active publisher members, Super Admin |
| Platform order | Customer | Active `FulfillmentAssignment` on the locked order | Customer organization, assigned Operations, Super Admin |

An order-linked ticket derives its organization, channel, and assignment from
the authoritative order inside a serializable transaction. Clients cannot
nominate a tenant, publisher, or staff assignee. A publisher must supply an
`orderId` and must currently be authorized for that publisher-channel order;
general publisher ticket creation is intentionally unavailable. Foreign,
Platform, and otherwise unauthorized order references are returned through the
same not-found policy so the endpoint is not an order-enumeration oracle.

General tickets created before channel snapshots are grandfathered into the
Platform queue only when `orderId`, `fulfillmentChannel`, and
`assignedPublisherId` are all null. Any other null or contradictory routing
shape fails closed to Operations and remains available only to Super Admin for
investigation. The support service and Operations workbench consume the same
predicate.

For a Platform order, routing follows its active `FulfillmentAssignment`, not a
mutable website owner field. Order claim/reassignment and ticket creation share
the order lock. A general, unassigned Platform ticket may be claimed from the
support inbox. During active fulfillment, an order-linked ticket remains
read-only until the order itself is claimed. After fulfillment ends, the latest
active Operations owner is retained when possible; an otherwise unassigned
ticket may be claimed independently without creating or changing a fulfillment
assignment.

Operations demotion and suspension fail while any assigned ticket is not
`CLOSED`; `RESOLVED` remains blocking because it can be reopened. Historical
`CLOSED` tickets do not permanently pin a staff account: the serializable
offboarding transaction clears their assignee and records the released count in
the protected staff audit event. A later reopen therefore enters the unassigned
support queue instead of retaining an actor who no longer has Operations
authority.

## Visibility and staff policy

`PUBLIC` messages are part of the customer-facing conversation. `INTERNAL`
messages are staff-only notes and are never returned to customers or
publishers.

| Actor | Publisher-channel public | Platform-channel public | Internal notes |
|---|---:|---:|---:|
| Customer in the ticket organization | Reply | Reply | Never |
| Assigned publisher member | Reply | No access | Never |
| Assigned Operations | Not applicable | Reply after claim | Yes |
| Finance | No access | No access | No access |
| Super Admin | Reply | Reply | Yes |
| Unknown or missing staff role | Deny | Deny | Deny |

The matrix is enforced again inside each locked mutation. A list or detail read
is not proof that a later reply, status change, claim, or reassignment is still
authorized.

## Response and privacy contract

Customer and publisher responses are strict projections. Public ticket objects
omit requester, organization, assignment, and publisher identity objects. A
public message contains only:

- `id`, `content`, `visibility`, `messageType`, and `createdAt`
- `sender: { party, displayName, isSelf }`

Public messages omit `user`, email, files, raw IDs, `participantRole`,
`actorSnapshot`, and `authorEvidence`. This is key absence, not redaction with
`null`, so accidental serialization is detectable in contract tests. Internal
notes are filtered before projection.

Staff responses add display-only requester, organization, and assignment
objects plus forensic message fields. Raw `userId`, `publisherId`, and requester
email are included only for Super Admin. Other staff receive display names
without those properties. A deleted author remains attributable through the
role snapshot and safe display fallback; the nullable user relation is never a
reason to place the message on the wrong side.

`FINANCE` remains a valid historical `participantRole` for older evidence, but
Finance has no live generic support list, detail, reply, note, or status access.

The stored ticket description is projected as `openingMessage`, not as a raw
identity-bearing ticket row. Clients render that opening message, then the
ordered `messages` collection, so the initial request uses the same sender and
accessibility treatment as every reply.

`capabilities` is returned with each ticket and drives the visible controls:
reply, close, reopen, internal note, claim, allowed visibilities, allowed
statuses, and a read-only reason. Capabilities improve the user experience but
are not authorization; the mutation always rechecks policy.

## Status behavior

Customers and publishers may send only two status commands:

- `CLOSED` closes any ticket that is not already closed.
- `OPEN` reopens a resolved or closed ticket.

Staff workflows may use `OPEN`, `IN_PROGRESS`, `WAITING_ON_CUSTOMER`,
`RESOLVED`, and `CLOSED` when allowed by the server capability. Public replies
are blocked while a ticket is `RESOLVED` or `CLOSED`; reopening is a separate,
auditable command. Authorized staff may still add an internal note to a
terminal ticket.

## Write integrity and idempotency

Ticket subjects, descriptions, search terms, and messages are normalized to
NFC, line endings are normalized, surrounding whitespace is removed, length is
bounded, and unsafe control/bidirectional characters are rejected. The UI
renders text, never trusted HTML. Attachments are not an accepted or projected
part of the support API.

Every create command requires `clientRequestId`; every reply or internal note
requires `clientMessageId`. Both are UUID v4 values. Generate the ID once when
the user submits, keep it for retries after timeouts or ambiguous responses,
and generate a new ID only for a new user intent. The server derives a
deterministic, actor-scoped record identity. An exact replay returns the
original result without a second row, audit event, or notification. Reusing an
ID with different normalized content, order, or visibility fails with `409
Conflict`. This provides durable idempotency without a schema migration.

Messages are ordered deterministically by creation time with ID as the tie
breaker. Detail responses return at most 200 messages and
`messagePage: { nextCursor, limit }`. `nextCursor` is an opaque cursor for the
next older page; each individual page remains chronological so a client can
prepend it and deduplicate by message ID. Public cursor selection filters to
`PUBLIC` before applying the cursor and limit, so internal rows cannot change a
public page boundary, count, or cursor.

External ticket lists return `{ items, nextCursor, limit }`; the default page
size is 50 and the maximum is 100. The opaque `cursor` loads the next older
page. Tickets are ordered by latest public activity descending, then ticket ID
ascending. A ticket with no replies uses its creation time. Clients append
older pages and deduplicate by ticket ID. Internal notes are excluded from the
activity computation, so they cannot reveal staff activity, reorder a public
inbox, or perturb its cursor.

## HTTP surface

| Method and route | Actors | Purpose |
|---|---|---|
| `POST /support/tickets` | Customer; authorized publisher with `orderId` | Create an idempotent ticket |
| `GET /support/tickets?status=&orderId=&cursor=&limit=` | Customer, publisher | Cursor-page the actor's projected tickets |
| `GET /support/tickets/:id?messageCursor=…` | Customer, publisher | Read the latest or next older projected message page |
| `POST /support/tickets/:id/messages` | Customer, publisher | Add an idempotent public reply |
| `PATCH /support/tickets/:id/status` | Customer, publisher | Close or reopen |
| `GET /admin/support/tickets` | Authorized staff | Paginated staff inbox |
| `GET /admin/support/tickets/:id?messageCursor=…` | Authorized staff | Staff conversation projection and older pages |
| `POST /admin/support/tickets/:id/messages` | Authorized staff | Public reply or internal note |
| `PATCH /admin/support/tickets/:id/status` | Authorized staff | Staff status transition |
| `PATCH /admin/support/tickets/:id/claim` | Operations | Claim a general or eligible post-fulfillment unassigned Platform ticket |
| `PATCH /support/tickets/:id/reassign` | Super Admin | Validated reassignment |

Use `supportKeys` from `@guestpost/api-client` for list, detail, and order-scoped
cache invalidation. Do not introduce dashboard-local copies of the support DTOs
or query-key hierarchy.

## Logging and telemetry

Support telemetry may record route, actor class, channel, status, duration,
result code, serialization retry/conflict count, idempotent replay count, and
notification/outbox outcome. Logs and metrics must not contain message text,
subject, email, client request IDs, database IDs, order IDs, or raw actor
snapshots. Use the platform request ID to correlate an operator-visible error.

Alert on sustained increases in 5xx responses, serializable retry exhaustion,
outbox backlog age, and authorization-denial rate. A denial spike can indicate
stale UI state or probing; investigate with protected audit data rather than
adding identifiers to application logs.

## Deployment and rollback

Deploy the API contract and all dashboards together. Before enabling traffic,
run the focused API, API-client, shared UI, and application type/build gates
listed in `docs/TESTING.md`. Verify with one disposable ticket per actor and
channel that alignment, privacy, close/reopen, internal-note invisibility, and
notification recipients are correct.

If a dashboard regression appears, disable its mutation controls or roll back
the dashboard while retaining the secure API projection and authorization
checks. Do not roll back to raw Prisma responses or expose staff evidence as a
compatibility measure. No database migration is required for this change.

## Remaining browser acceptance gate

The repository does not yet have a safe Playwright fixture that provisions a
customer, an assigned publisher, Operations, and Super Admin in one isolated
journey. Do not replace that gap with a mocked or string-matching E2E test.
Before paid launch, add a disposable local/CI-only multi-actor fixture and prove
the following in real browsers:

1. Customer, publisher, and support messages use the correct side, label, and
   accessible sender name.
2. A publisher can open support only from an authorized publisher order and
   can open the resulting assigned thread route.
3. An internal note is visible to authorized staff and absent from both public
   sessions after cache refresh.
4. Close blocks public reply, reopen restores it, and an ambiguous retry does
   not duplicate a ticket or message.
5. Keyboard focus, live announcements, contrast, mobile layout, and reduced
   motion remain usable across the conversation.
