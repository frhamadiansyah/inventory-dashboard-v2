import sql from "../db-pool"
import { PAID_PRIORITY_RANK, fetchPaidStatusMap, type PaidStatus } from "./shopping-list"
import type { ExcessTransitItem, ExcessReason } from "./types"

// ─── Dispatch List ──────────────────────────────────────────────────────────
//
// Clone of the shopping-list step, one lifecycle stage later: buy → DISPATCH →
// arrive. Where the shopping list gates on "still needs buying" (unit_buy <
// unit), the dispatch list gates on "bought but not yet dispatched"
// (unit_dispatch < unit_buy) — an order only shows up here once it has a
// unit_buy to dispatch against at all.

export interface DispatchListOrder {
  id: number
  customer: string
  unitBuy: number      // cap for this stage — units bought, i.e. dispatchable
  unitDispatch: number // already dispatched (0 if none)
  pending: number      // unitBuy - unitDispatch
  // Whether the customer has settled this event's invoice. Mirrors the same
  // math as computeEventCore: paid >= subtotal + ongkir*weight + adjustments.
  paidStatus: PaidStatus
}

export interface DispatchListItem {
  event: string
  productId: number
  productName: string
  store: string
  totalUnits: number      // remaining to dispatch
  totalOriginal: number   // full bought qty (SUM(unit_buy), for partial-state display)
  customerCount: number
  customers: string[]
  orderIds: number[]
  orders: DispatchListOrder[]
}

export async function getDispatchList(event?: string): Promise<DispatchListItem[]> {
  // Includes partially-dispatched orders (unit_dispatch < unit_buy), not just
  // untouched ones. Aggregations expose both the remaining-to-dispatch
  // quantity and the full bought quantity so the UI can show "5 / 10" when an
  // order is partially dispatched.
  //
  // The paid-status fetch runs in parallel with the items query — they touch
  // overlapping tables but don't depend on each other's results, so paying for
  // both RTTs at once is wasted latency. When an event is selected we already
  // know the event list upfront ([event]); when not, we pass null and let the
  // status query span all events (a touch more work than scoping it to the
  // events the items query returns, but worth it for the parallelism).
  const eventsForStatus = event ? [event] : null

  const [rows, statusMap] = await Promise.all([
    event
      ? sql`
          SELECT
            o.event,
            o.product_id,
            p.name AS product_name,
            p.store,
            SUM(o.unit_buy - COALESCE(o.unit_dispatch, 0))::int AS total_pending,
            prod_total.total_original,
            COUNT(DISTINCT o.customer)::int AS customer_count,
            ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
            ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', o.id,
              'customer', o.customer,
              'unitBuy', o.unit_buy,
              'unitDispatch', COALESCE(o.unit_dispatch, 0),
              'pending', o.unit_buy - COALESCE(o.unit_dispatch, 0)
            ) ORDER BY o.customer, o.id) AS orders
          FROM orders o
          JOIN products p ON p.id = o.product_id
          -- Full bought qty spans ALL bought orders for the product (including
          -- the fully-dispatched rows the WHERE below filters out), so the UI
          -- shows "remaining / total bought" rather than "remaining / open rows".
          JOIN (
            SELECT event, product_id, SUM(unit_buy)::int AS total_original
            FROM orders
            WHERE event = ${event} AND unit_buy IS NOT NULL
            GROUP BY event, product_id
          ) prod_total ON prod_total.event = o.event AND prod_total.product_id = o.product_id
          WHERE (o.unit_buy IS NOT NULL AND (o.unit_dispatch IS NULL OR o.unit_dispatch < o.unit_buy)) AND o.event = ${event}
          GROUP BY o.event, o.product_id, p.name, p.store, prod_total.total_original
          HAVING SUM(o.unit_buy - COALESCE(o.unit_dispatch, 0)) > 0
          ORDER BY p.name, p.store
        `
      : sql`
          SELECT
            o.event,
            o.product_id,
            p.name AS product_name,
            p.store,
            SUM(o.unit_buy - COALESCE(o.unit_dispatch, 0))::int AS total_pending,
            prod_total.total_original,
            COUNT(DISTINCT o.customer)::int AS customer_count,
            ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
            ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', o.id,
              'customer', o.customer,
              'unitBuy', o.unit_buy,
              'unitDispatch', COALESCE(o.unit_dispatch, 0),
              'pending', o.unit_buy - COALESCE(o.unit_dispatch, 0)
            ) ORDER BY o.customer, o.id) AS orders
          FROM orders o
          JOIN products p ON p.id = o.product_id
          JOIN events e ON e.name = o.event
          -- Full bought qty spans ALL bought orders for the (event, product),
          -- including the fully-dispatched rows the WHERE below filters out.
          JOIN (
            SELECT event, product_id, SUM(unit_buy)::int AS total_original
            FROM orders
            WHERE unit_buy IS NOT NULL
            GROUP BY event, product_id
          ) prod_total ON prod_total.event = o.event AND prod_total.product_id = o.product_id
          WHERE o.unit_buy IS NOT NULL AND (o.unit_dispatch IS NULL OR o.unit_dispatch < o.unit_buy)
          GROUP BY o.event, o.product_id, p.name, p.store, prod_total.total_original
          HAVING SUM(o.unit_buy - COALESCE(o.unit_dispatch, 0)) > 0
          -- Most recently created event first (matches the dashboard's event
          -- ordering); product name then store within each event. MAX() because
          -- created_at is constant per event but not in the GROUP BY.
          ORDER BY MAX(e.created_at) DESC NULLS LAST, o.event, p.name, p.store
        `,
    fetchPaidStatusMap(eventsForStatus),
  ])

  // A row without an `orders` array is impossible for this query (JSON_AGG over
  // a grouped join always yields one). If it happens anyway, the connection
  // handed back a response that belongs to a different query — seen once when
  // dev-mode pool churn desynced a pooled connection. Fail with a clear message
  // instead of a baffling `undefined.map` crash deep in the mapping below.
  for (const r of rows) {
    if (!Array.isArray(r.orders)) {
      throw new Error("Dispatch list query returned a malformed row (missing orders array) — likely a desynced DB connection; retry the request")
    }
  }

  const items: DispatchListItem[] = rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    totalUnits: r.total_pending as number,
    totalOriginal: r.total_original as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    orders: (r.orders as Omit<DispatchListOrder, "paidStatus">[]).map((o) => ({
      ...o,
      paidStatus: statusMap.get(`${r.event}|${o.customer}`) ?? "unpaid",
    })),
  }))

  // Order each product's customers by allocation priority (paid → partial →
  // unpaid, then earliest order) so the dispatch modal's fill preview — which
  // walks this array in order — matches the server-side allocation.
  for (const item of items) {
    item.orders.sort(
      (a, b) => PAID_PRIORITY_RANK[a.paidStatus] - PAID_PRIORITY_RANK[b.paidStatus] || a.id - b.id,
    )
  }

  return items
}

// ─── Excess (overbuy) Dispatch Pending ─────────────────────────────────────
//
// excess_purchase rows that have been bought but not yet dispatched. Unlike
// getDispatchList these have no customer to allocate to — the row just
// advances its own buy -> dispatch stage (see the "Overbuy in transit"
// section on the Dispatch List page).

export async function getExcessDispatchPending(event?: string): Promise<ExcessTransitItem[]> {
  const rows = event
    ? await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_buy IS NOT NULL
          AND (unit_dispatch IS NULL OR unit_dispatch < unit_buy)
          AND event = ${event}
        ORDER BY id ASC
      `
    : await sql`
        SELECT id, event, items, reason, unit_buy,
               COALESCE(unit_dispatch, 0) AS unit_dispatch,
               COALESCE(unit_arrive, 0) AS unit_arrive,
               receipt
        FROM excess_purchase
        WHERE unit_buy IS NOT NULL
          AND (unit_dispatch IS NULL OR unit_dispatch < unit_buy)
        ORDER BY id ASC
      `
  return rows.map((r) => ({
    rowNumber: r.id as number,
    event: r.event as string,
    items: r.items as string,
    reason: r.reason as ExcessReason,
    unitBuy: r.unit_buy as number,
    unitDispatch: r.unit_dispatch as number,
    unitArrive: r.unit_arrive as number,
    pending: (r.unit_buy as number) - (r.unit_dispatch as number),
    receipt: (r.receipt as string) ?? "",
  }))
}

// ─── Dispatch Document ──────────────────────────────────────────────────────

export interface DispatchDocLine {
  productName: string
  qty: number
  valas: number
  currency: string
  receipt: string
}

/**
 * Per-(dispatch_receipt, product) tally of *dispatched* units for one event, for
 * the cargo-style dispatch document. `receipt` is an optional case-insensitive
 * SUBSTRING match on the receipt (e.g. "MNC" matches "MNC38179"); empty/absent =
 * every dispatched batch for the event. valas/currency come from the product and
 * its country, so the cargo template can price and group the lines by currency.
 *
 * Read from the append-only `audit.audit_log` (migration 029) rather than the
 * orders table, because a single order dispatched in several batches accumulates
 * its receipts comma-joined in one `dispatch_receipt` field (the dispatch route
 * appends `"<existing>, <new>"`) while `unit_dispatch` holds only the running
 * total — so the orders row alone can't say how many units went under each
 * receipt. Each dispatch UPDATE is one audit entry: the per-row delta
 * `new.unit_dispatch − old.unit_dispatch` is that batch's qty, and the newly
 * appended tail of `dispatch_receipt` (everything after the old value + ", ") is
 * that batch's receipt. Summing per (receipt, product) gives an accurate row for
 * each receipt. A batch dispatched without a tracking ref leaves the string
 * unchanged, so its receipt resolves to '' (shown as "—").
 */
export async function getDispatchDocument(
  event: string,
  receipt?: string | null,
): Promise<DispatchDocLine[]> {
  const receiptFilter =
    receipt && receipt.trim()
      ? sql`AND batch.receipt ILIKE '%' || ${receipt.trim()} || '%'`
      : sql``
  const rows = await sql`
    SELECT
      p.name AS product_name,
      p.valas,
      COALESCE(c.currency, '') AS currency,
      batch.receipt AS receipt,
      SUM(batch.qty)::int AS qty
    FROM (
      SELECT
        (a.new_row->>'product_id')::int AS product_id,
        COALESCE((a.new_row->>'unit_dispatch')::int, 0)
          - COALESCE((a.old_row->>'unit_dispatch')::int, 0) AS qty,
        CASE
          WHEN COALESCE(a.old_row->>'dispatch_receipt', '') = ''
            THEN COALESCE(a.new_row->>'dispatch_receipt', '')
          ELSE substring(
            COALESCE(a.new_row->>'dispatch_receipt', '')
            FROM char_length(a.old_row->>'dispatch_receipt') + 3
          )
        END AS receipt
      FROM audit.audit_log a
      WHERE a.table_name = 'orders'
        AND a.action IN ('INSERT', 'UPDATE')
        AND (a.new_row->>'event') = ${event}
        AND COALESCE((a.new_row->>'unit_dispatch')::int, 0)
            > COALESCE((a.old_row->>'unit_dispatch')::int, 0)
    ) batch
    JOIN products p ON p.id = batch.product_id
    LEFT JOIN countries c ON c.id = p.country_id
    WHERE TRUE
      ${receiptFilter}
    GROUP BY p.id, c.currency, batch.receipt
    HAVING SUM(batch.qty) > 0
    ORDER BY batch.receipt, p.name
  `
  return rows.map((r) => ({
    productName: r.product_name as string,
    qty: r.qty as number,
    valas: Number(r.valas) || 0,
    currency: (r.currency as string) ?? "",
    receipt: (r.receipt as string) ?? "",
  }))
}
