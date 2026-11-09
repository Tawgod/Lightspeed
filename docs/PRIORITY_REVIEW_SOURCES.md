# Priority Review — current read-only data contract

**Status:** In Development / Testing (PR #35). **No production deployment.**

## Source and authorization

The authenticated existing `GET /api/special-orders/priority-review` endpoint on `special-orders.js` uses the same Special Orders Timeclock session or legacy authorization middleware and `requireDb` guard as existing Special Orders statistics. It performs a single static PostgreSQL `SELECT` with four aggregate counts and returns no customer names, addresses, notes, exception payloads or raw integration errors. `Cache-Control: no-store` prevents reuse of old counts.

## Count definitions

| Field | Source | Meaning | Caveat |
| --- | --- | --- | --- |
| `old_open_items` | `special_order_items` | Item status not COMPLETED/CANCELLED and created at least 30 days ago | **Items, not unique customer orders.** 30 days is a proposed threshold |
| `ordered_over_7_days` | `special_order_items` | ORDERED item with non-null ordered_at at least seven days old | Not necessarily a late promised delivery; a follow-up indicator |
| `supplier_sync_failures` | `supplier_orders` | Lightspeed sync status ERROR | May remain until the underlying record changes; not every integration failure |
| `delivery_failures` | `notifications` | ERROR status for the five supported ready-delivery channels | Does not cover all Discord/GW/background jobs |
| Application bugs / global incidents | None | **Not connected** | No central trusted, authorized incident feed |

Each count measures a distinct category and an item may qualify in multiple categories. The dashboard therefore shows **number of affected categories**, not the sum of counts or a fake number of unique issues. Zero means *no flags in monitored categories*, not system health or no bugs. A failed DB request, invalid data or expired employee session results in an unavailable indicator; it does not silently render zero.

## UI and interaction

- Special Orders shows counts only after successful authenticated loading. Polls follow existing live-mode stats refresh; sign-out clears previously shown counts.
- The overdue ordered-items link toggles the existing 7-day Attention checkbox and scrolls to the current orders table; the old-order link opens the broader table but does **not** claim to apply a 30-day-specific filter.
- Supplier sync points to Ordering and delivery errors to the current Ordering delivery queue. Those pages retain their own auth checks. Links are review entrypoints, not automatic remediations.
- Status/category rows use semantic HTML and textual labels; they must remain usable at keyboard/narrow widths.
- No acknowledgment, dismissal, assignment, auto-retry, notification sending, PO modification, receiving, inventory change, or staff rights are implemented by Priority Review.

## Next required work

1. Browser/employee acceptance of real stored counts, auth expiry, bad DB response, and link clickthrough; validate counts against read-only database aggregates.
2. Decide exact 30-day threshold and item-vs-order semantics with manager.
3. For bugs/general job failures, reuse an existing durable operational event/error store or shared services once access control and redaction policy are approved. **Do not query raw Railway logs into a staff-facing page or create a second credential/client.**
4. Build the future Store Operations Home dashboard as an authorized aggregation consumer; do not fabricate activity, totals, outages or source timestamps.

**Safety:** The dashboard is read-only and authorization is enforced on the backend. Never infer employee authorization from a visible nav link; do not expose customer records in aggregate payloads.
