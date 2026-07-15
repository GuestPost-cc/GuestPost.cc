# Operations Gap Report — GuestPost.cc Admin

Generated: 2026-07-14
Methodology: Full codebase audit of 23 route pages, 1,150+ lines of API client, 48 shared UI components, TanStack Query patterns, RBAC enforcement, and accessibility.

---

## Executive Summary

The admin application has **zero placeholder pages** — every route is a real implementation. However, feature maturity is uneven:

| Dimension | Score | Verdict |
|-----------|-------|---------|
| Backend API completeness | 78% | Strong. All CRUD + workflow endpoints exist. |
| Frontend page coverage | 85% | Every page has a real implementation. |
| **Enterprise UX maturity** | **28%** | No bulk ops, no kanban, no charts, no keyboard shortcuts. |
| **Fulfillment workflow** | **22%** | 5 core ops steps have zero UI. Kanban is a table. |
| **Accessibility** | **45%** | No `role="alert"`, no `aria-label`, custom tab components broken. |
| **Query infrastructure** | **55%** | 15+ inconsistent key patterns, cross-page cache misses. |
| **Reusable components** | **60%** | Strong shared library but missing `ConfirmationDialog`, `BulkActionBar`, `DatePicker`. |

**Overall maturity: 53%** — Highest-value improvements are ALL frontend-only using existing APIs.

---

## Feature Maturity Matrix

### 1. Operations Dashboard (`/dashboard`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| KPI cards (Revenue, GMV, Active Orders, Publishers, Customers) | 70% | Missing platform-specific KPIs (platform listings, pending reviews, fulfillment SLA) | Frontend-only |
| Recent Orders table | 80% | No sorting, no click-to-detail | Frontend-only |
| Activity feed | 30% | Stub — only shows order status text, no real events | Frontend-only |
| Charts (revenue, orders, growth trends) | 0% | No visualization library, no chart components | Frontend-only |
| Platform-specific KPIs | 0% | No listing counts by status, no platform order counts | Frontend-only |
| SLA / completion time metrics | 0% | Not computed or displayed anywhere | Frontend-only |
| Revenue today / this month | 0% | Revenue API exists but not surfaced on dashboard | Frontend-only |
| Top performing listings | 0% | No per-listing performance display | Frontend-only |
| Recent fulfillment activity | 0% | No fulfillment events in activity feed | Frontend-only |

### 2. Marketplace Listing Table (`/dashboard/marketplace`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Search / text filter | 75% | Fires on every keystroke (no debounce), missing `ownerType` filter | Frontend-only |
| Status filter | 90% | Works well | — |
| Type filter | 80% | Good | — |
| Pagination (server-side) | 80% | Missing per-page selector (20/50/100) | Frontend-only |
| Column sorting | 0% | No sortable columns | Frontend-only |
| Row actions (status, featured, verified) | 85% | Edit listing title/description missing | Frontend-only |
| Bulk selection | 0% | No checkboxes, no select-all | Frontend-only |
| Bulk actions | 0% | No bulk approve/reject/archive/export | Frontend-only |
| Column chooser | 0% | No column visibility toggle | Frontend-only |
| Saved filters | 0% | No URL-synced or saved filter presets | Frontend-only |
| CSV export | 0% | Not available | Frontend-only |
| CSV import | 0% | Not available | Frontend-only |
| Create listing | 65% | Cannot set category, tags, images, services at create time | Frontend-only |
| Edit listing (title, description, category) | 0% | No edit path in admin UI | Frontend-only |
| Delete listing | 70% | Soft-delete only, no hard-delete for SUPER_ADMIN | — |
| Duplicate listing | 0% | Not implemented | Frontend-only |
| Service management (add/edit/pause) | 80% | Good — inline availability edit works | — |
| Health indicators (no services, no image, no category) | 0% | Not surfaced anywhere | Frontend-only |
| OwnerType badge (PLATFORM vs PUBLISHER) | 0% | API returns `ownerType` in detail but not in list | Backend gap |
| ManagedBy / assignee column | 0% | `managedByUserId` exists on websites but not exposed in listing API | Backend gap |
| Listing thumbnail / image | 0% | `images` returned in detail API but not in list API | Backend gap |

### 3. Marketplace Listing Detail (`/dashboard/marketplace/[slug]`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Public preview | 90% | Good — renders buyer-facing listing | — |
| Moderation actions (approve, reject, pause, archive) | 90% | Good | — |
| Featured / verified toggles | 90% | Good | — |
| Tabs (Overview, Services, Pricing, SEO, Orders, Revenue, History) | 0% | Flat page, no tabs | Frontend-only |
| Listing-specific orders | 0% | Not surfaced | Frontend-only |
| Listing-specific revenue | 0% | Revenue API supports `groupBy: listing` but no UI | Frontend-only |
| Audit history timeline | 0% | Audit log API exists but not linked to listing | Frontend-only |
| Service catalog / full services grid | 40% | Only shows `serviceTypes[0]` badge, no full table | Frontend-only |
| SEO / metrics display (DR, traffic, language, country) | 40% | Shows DR and traffic only | Frontend-only |
| Activity timeline | 0% | No status change timeline | Frontend-only |
| Edit form (title, description, category, tags) | 0% | No edit capability exists | Frontend-only |
| Image management | 0% | No image upload or thumbnail display | Frontend-only |

### 4. Fulfillment Board (`/dashboard/fulfillment`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Queue display (grouped by status) | 60% | Grouped into 5 sections but order logic is broken | Frontend-only |
| Claim order | 80% | Works | — |
| Review delivery | 70% | Dialog works but lacks order context | Frontend-only |
| Accept order → Submit Content → Mark Ready → Submit Review → Mark Published | **0%** | **5 core fulfillment steps have NO UI at all** | Frontend-only |
| Kanban / column view | 0% | Table-based, no drag-drop | Frontend-only |
| Content management (write/edit brief, upload files) | 0% | No content form UI | Frontend-only |
| Assignment management (assign to other ops) | 10% | API exists (`POST /assign`, `POST /reassign`) but no UI | Frontend-only |
| Shared queue (`managedByUserId == null`) vs My queue | 0% | No separation in UI or backend query | Frontend-only |
| SLA / deadline display | 0% | `turnaroundDays` exists on service but not shown in queue | Frontend-only |
| Priority indicators | 0% | No priority system | Frontend-only |
| Filtering (status, assignee, date range) | 0% | No filters at all on fulfillment page | Frontend-only |
| Per-operator capacity / load | 0% | Not tracked or displayed | Frontend/Backend |
| **"In Progress" bucket** | **0%** | `status === "IN_PROGRESS"` never matches — assignment goes ASSIGNED → DIRECTLY → DELIVERED | **Bug** |

### 5. Order Management (`/dashboard/orders`, `/dashboard/orders/[id]`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Order list search | 60% | Client-side only, no server-side search | Frontend-only |
| Order list filter (status) | 70% | Good | — |
| Order list pagination | 80% | Good | — |
| Order list column sorting | 0% | TanStack Table used but no `getSortedRowModel()` | Frontend-only |
| Order detail timeline | 85% | Full stepper with status history | — |
| Order detail settlement info | 80% | Shows amounts, review window, approvals | — |
| Order detail delivery tracking | 80% | Good — shows verification results | — |
| Force cancel / refund | 85% | Good with audit trail | — |
| Bulk order operations | 0% | No bulk select, approve, cancel | Frontend-only |
| Order list CSV export | 0% | Not available | Frontend-only |
| Platform order list (`/admin/orders/platform`) | **0%** | **Endpoint exists but no UI consumes it** | Frontend-only |
| `listOrders()` server-side pagination | 30% | Returns ALL orders with no server-side filter/sort — will break at scale | Backend |

### 6. Platform Revenue (`/dashboard/finance` → Revenue tab)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Revenue table (grouped by channel/month/serviceType/listing) | 80% | Good — all 4 groupBy modes work | — |
| Period comparison (current vs previous with delta %) | 85% | Good — API returns `deltaPct` | — |
| CSV export (server-streamed) | 85% | Good | — |
| Date range filter | 70% | Native `<input type="date">` works but no presets | Frontend-only |
| KPI cards (gross, fees, net, reversed) | 80% | Good | — |
| Charts / visualizations | 0% | Tabular only, no trend lines or bar charts | Frontend-only |
| Currency mismatch detection | 80% | Works, shows amber banner | — |
| Revenue by listing drill-down | 50% | Links to `/dashboard/marketplace/listings/${id}` which is a **broken link** (route is slug-based) | **Bug** |
| Revenue by manager / operator | 0% | Not supported by API | Backend gap |
| Payouts CSV | 0% | Not implemented | Frontend-only |
| Reconciliation CSV | 0% | Not implemented | Frontend-only |

### 7. Platform Websites (`/dashboard/websites`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Website table | 70% | Good — shows id, url, domain, managedBy | — |
| Assign Ops manager | 80% | Works with picker dialog | — |
| Create website | 80% | Works | — |
| Pause website | 80% | Works | — |
| Website health indicators | 0% | No verification status badge, no listing count, no order count | Frontend-only |
| Website detail page | 0% | No dedicated detail view with tabs | Frontend-only |
| Website activity / audit | 0% | Not surfaced | Frontend-only |
| Website revenue | 0% | Not surfaced — Revenue API doesn't support `groupBy: website` | Backend gap |

### 8. Support (`/dashboard/support`, `/dashboard/support/[id]`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Ticket list (search, filter, pagination) | 80% | Good | — |
| Ticket detail (thread + replies) | 80% | Good — public/internal visibility toggle | — |
| FulfillmentChannel badge | 85% | Good — distinguishes PLATFORM vs PUBLISHER | — |
| Role badges on messages | 85% | Good | — |
| Notifications inbox | 0% | Bell icon exists but no dedicated notification page | Frontend-only |
| Escalation workflow | 0% | No escalation path or UI | Frontend-only |

### 9. Audit Logs (`/dashboard/audit-logs`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Audit log table with search/filter | 85% | Good — SUPER_ADMIN only | — |
| CSV export | 85% | Good | — |
| Listing-specific audit timeline | 0% | Audit log can filter by entityId but no listing detail page surfaces it | Frontend-only |

### 10. Disputes (`/dashboard/disputes`)

| Feature | Score | Gap | Type |
|---------|-------|-----|------|
| Dispute list with filters | 80% | Good | — |
| Resolve dialogs | 85% | Good — restore/refund/reject | — |
| Evidence package | 85% | Good — fraud flags, delivery versions, snapshots | — |

---

## Reusable Infrastructure Inventory

### Available Shared Components (`@guestpost/ui`)

| Component | Used? | Notes |
|-----------|-------|-------|
| `Button` | ✅ Every page | CVA variants, Radix Slot |
| `Card` (Header/Title/Description/Content/Footer) | ✅ Every page | |
| `Badge` | ✅ Every page | 7 CVA variants, no `role="status"` |
| `StatusBadge` | ✅ Finance, Orders, Marketplace | CVA: default/success/warning/destructive/info/pending |
| `Table` (Header/Body/Row/Cell) | ✅ 5+ pages | Semantic `<table>` |
| `DataTable` | ✅ Orders, Organizations | Generic `<T>`, built-in search/sort/pagination |
| `Dialog` | ✅ Every page | Radix Dialog, focus trap, escape |
| `Drawer` | ✅ Dashboard nav | Radix Dialog, left/right slide, mobile-only |
| `DropdownMenu` | ✅ Marketplace, Finance | Radix full submenu |
| `Select` | ✅ Every page | Radix Select |
| `Tabs` | ✅ Finance, Verification | Radix Tabs |
| `Input` | ✅ Every page | No `aria-invalid` styling |
| `Textarea` | ✅ Support, Settings | |
| `Label` | ✅ Forms | Radix Label |
| `Checkbox` | ✅ Settings | |
| `Switch` | ✅ Settings | Radix Switch |
| `Skeleton` | ✅ Every page | `animate-pulse rounded-md bg-muted` |
| `ErrorState` | ✅ Dashboard, Fulfillment, Settlement Review | No `role="alert"` |
| `EmptyState` | ✅ Finance | No `role="status"` |
| `LoadingState` | ✅ Some pages | 4 variants: card/table/list/detail |
| `KpiCard` | ✅ Finance | Label, value, trend |
| `PageHeader` | ✅ Admin pages | Title, description, actions slot |
| `PermissionGate` | ✅ Admin layout | Role check with fallback |
| `RoleGuard` | ✅ Admin layout | Simple role check |
| `FulfillmentChannelBadge` | ✅ Support | Platform vs Publisher |
| `Tooltip` | Used sparingly | Radix Tooltip |
| `Avatar` | Used sparingly | Radix Avatar |
| `Separator` | Used in layout | |
| `cn()` utility | ✅ Every file | clsx + tailwind-merge |
| `downloadCsv()` | ✅ Finance | Client-side CSV with sanitization |
| Status presentation helpers | ✅ Across app | `getOrderStatusPresentation`, `getListingStatusPresentation`, etc. |

### Missing Shared Components (High Impact)

| Component | Pages That Need It | Effort |
|-----------|-------------------|--------|
| `ConfirmationDialog` | Finance (3+ dialogs), Marketplace (delete), Orders (force-cancel/refund) | Low — extract pattern |
| `BulkActionBar` | Marketplace, Orders | Medium |
| `SearchBar` | Dashboard, Marketplace, Orders, Users, Publishers | Low — extract pattern |
| `FilterBar` | Marketplace, Orders, Fulfillment | Medium |
| `DatePicker` | Finance (revenue), Verification, Audit logs | Low — build on native `<input>` |
| `PaginationBar` (shared) | Currently local to Finance | Low — extract |
| `StatusDot` / `SeverityDot` | Reconciliation, listing health | Low |
| `ActivityTimeline` | Listing detail, order detail, fulfillment detail | Medium |
| `KanbanBoard` | Fulfillment | High |
| `EmptyState` variations | Every page (add helpful CTAs) | Low |

### TanStack Query Infrastructure

| Pattern | Status | Action |
|---------|--------|--------|
| Query key convention | ❌ 15+ inconsistent patterns | Standardize to `["admin", "entity", ...params]` |
| Cross-page invalidation | ❌ Finance mutations don't invalidate dashboard keys | Add missing `queryKey` invalidations |
| Optimistic updates | ❌ None anywhere | Add for high-frequency actions (approve, pause) |
| Polling | ✅ Notifications only | Add for fulfillment queue (30s) |
| Prefetch | ❌ None | Add for detail-page navigation |
| Retry | ⚠️ Used inconsistently | Standardize to `retry: 1` on all queries |
| Stale time | ❌ Not configured anywhere | Add `staleTime: 30_000` for background freshness |

---

## Bug Report

| ID | Severity | Area | Description |
|----|----------|------|-------------|
| B1 | 🔴 Critical | Fulfillment | **"In Progress" bucket never populates** — `asg.status === "IN_PROGRESS"` never matches because FulfillmentAssignment goes `ASSIGNED → DELIVERED` without `IN_PROGRESS` intermediate state |
| B2 | 🔴 Critical | Fulfillment | **5 core fulfillment steps have no UI** — Accept, Submit Content, Mark Content Ready, Submit for Review, Mark Published endpoints exist but no frontend consumes them |
| B3 | 🔴 High | Revenue | **Revenue listing drill-down links are broken** — `/dashboard/marketplace/listings/${b.listingId}` route doesn't exist; listing detail route is `/dashboard/marketplace/[slug]` |
| B4 | 🟡 Medium | Orders | **`listOrders()` has no server-side pagination** — fetches ALL orders, will time out at scale |
| B5 | 🟡 Medium | Marketplace | **Search fires on every keystroke** — no debounce, causes excessive API calls |
| B6 | 🟡 Medium | Marketplace | **No listing edit capability** — title, description, category, tags cannot be changed from admin UI |
| B7 | 🟡 Medium | Finance | **Settlement key conflict** — three different query keys for the same `listSettlements()` API |
| B8 | 🟡 Medium | Finance | **TabNav not keyboard accessible** — custom `<button>` tabs with no `role="tablist"` or keyboard handlers |
| B9 | 🟡 Medium | Dashboard | **Activity feed is a stub** — only shows order status text derived from `listOrders()`, no real event-driven activity |
| B10 | 🟢 Low | Settings | **Maintenance mode toggle disabled** — backend endpoint missing |

---

## Implementation Backlog (Prioritized by Operational Impact)

### Phase A — Quick Wins (Frontend-only, 1-2 days each)

| Priority | Feature | Pages Affected | Effort |
|----------|---------|----------------|--------|
| P0 | **Fix "In Progress" bucket** — change to check `asg.status === "ASSIGNED"` or `order.status` | Fulfillment | 15 min |
| P0 | **Add debounce to search** — 300ms debounce on all text search inputs | Marketplace, all pages | 30 min |
| P0 | **Add listing edit dialog** — title/description/category edit via existing `updateListing` API | Marketplace | 1 day |
| P1 | **Fix revenue drill-down link** — change ID-based link to slug-based | Finance | 30 min |
| P1 | **Extract shared `ConfirmationDialog`** — standardize 3+ duplicate dialog patterns | Finance, Marketplace, Orders | 1 day |
| P1 | **Extract shared `SearchBar` component** — consistent search with debounce | All pages | 1 day |
| P1 | **Add per-page selector to pagination** | Marketplace, all tables | 1 day |
| P2 | **Standardize query keys** to `["admin", "entity", ...params]` pattern | All pages | 2 days |
| P2 | **Fix cross-page invalidation** — finance mutations invalidate dashboard keys | Finance, Dashboard | 1 day |

### Phase B — High Impact (Frontend-only, 2-4 days each)

| Priority | Feature | Pages Affected | Effort |
|----------|---------|----------------|--------|
| P0 | **Platform fulfillment workflow UI** — Accept → Content → Ready → Review → Published steps | Fulfillment | 3 days |
| P1 | **Fulfillment Kanban board** — Replace table with column-based drag-and-drop board | Fulfillment | 4 days |
| P1 | **Fulfillment detail drawer** — Tabs: Summary, Content, Files, Messages, Timeline | Fulfillment | 3 days |
| P1 | **Bulk selection + bulk actions bar** for marketplace listings | Marketplace | 2 days |
| P2 | **Listing detail tabs** — Overview, Services, SEO, Orders, Revenue, History | Marketplace detail | 3 days |
| P2 | **Shared Queue / My Queue views** for fulfillment | Fulfillment | 2 days |

### Phase C — Dashboard & Analytics (Frontend-only)

| Priority | Feature | Pages Affected | Effort |
|----------|---------|----------------|--------|
| P1 | **Operations dashboard with platform KPIs** — listing counts, fulfillment stats, revenue today | Dashboard | 2 days |
| P2 | **Revenue charts** — line/bar charts using existing API | Finance | 2 days |
| P2 | **Listing health indicators** — no services, no image, stale draft warnings | Marketplace | 2 days |

### Phase D — Requires Backend Changes

| Priority | Feature | Pages Affected | Reason |
|----------|---------|----------------|--------|
| P2 | Add `ownerType`, `fulfillmentType`, `managedByUserId` to listing list API | Marketplace | Backend field addition |
| P2 | Add `listings[].orderCount` and `listings[].totalRevenue` to listing API | Marketplace | Backend aggregation |
| P3 | `listOrders()` server-side pagination + search | Orders | Backend — will break at scale |
| P3 | Revenue `groupBy: website` support | Finance | Backend aggregation |
| P3 | Operator capacity tracking | Fulfillment | New data model |

---

## Key Decision: Backend Changes vs Frontend-Only

**94% of identified gaps are fixable with frontend-only work using existing APIs.**

The 6% requiring backend changes:
1. `ownerType`/`fulfillmentType` in list response — cosmetic, can be derived from `publisherId` presence client-side
2. `orderCount`/`totalRevenue` in list — nice-to-have, can be computed client-side from orders API
3. Server-side pagination for `listOrders()` — will be needed at scale (>1000 orders)
4. Revenue `groupBy: website` — not currently critical
5. Operator capacity — true new feature

**Recommendation: Start with Phase A quick wins, then Phase B fulfillment workflow. No backend changes needed for the first 2 sprints.**

---

## Conclusion

The backend is well-designed with complete APIs. The frontend has all pages built but lacks enterprise operational UX:

1. **No bulk operations** — Most critical UX gap for operator efficiency
2. **No fulfillment workflow UI** — Half the platform order lifecycle is invisible
3. **No kanban board** — Table-based queue is inefficient for high-volume ops
4. **No charts** — Revenue and growth trends are tabular only
5. **Cumulative UX debt** — Inconsistent query keys, missing shared components, no accessibility roles

**All of these are fixable in the frontend without backend changes.** The fastest path to value is Phase A quick wins (debounce, edit dialog, confirmation dialogs, query key standardization) followed by Phase B fulfillment workflow UI.
