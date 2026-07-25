import sql from "../db-pool"
import { PAID_PRIORITY_RANK, fetchPaidStatusMap, type PaidStatus } from "./shopping-list"

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

// ─── Dispatch Document ──────────────────────────────────────────────────────

export interface DispatchDocLine {
  productName: string
  qty: number
  valas: number
  currency: string
  receipt: string
}

/**
 * Per-(product, dispatch_receipt) tally of *dispatched* units for one event, for
 * the cargo-style dispatch document. `receipt` is an optional case-insensitive
 * SUBSTRING match on dispatch_receipt (e.g. "MNC" matches "MNC38179");
 * empty/absent = every dispatched line for the event. qty = SUM(unit_dispatch).
 * Grouping by receipt (not just product) so the document can show a RECEIPT
 * column — a product dispatched under two receipts becomes two rows.
 * valas/currency come from the product and its country, so the cargo template
 * can price and group the lines by currency.
 */
export async function getDispatchDocument(
  event: string,
  receipt?: string | null,
): Promise<DispatchDocLine[]> {
  const receiptFilter =
    receipt && receipt.trim()
      ? sql`AND o.dispatch_receipt ILIKE '%' || ${receipt.trim()} || '%'`
      : sql``
  const rows = await sql`
    SELECT
      p.name  AS product_name,
      p.valas,
      COALESCE(c.currency, '') AS currency,
      COALESCE(o.dispatch_receipt, '') AS receipt,
      SUM(o.unit_dispatch)::int AS qty
    FROM orders o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN countries c ON c.id = p.country_id
    WHERE o.event = ${event}
      AND o.unit_dispatch IS NOT NULL
      AND o.unit_dispatch > 0
      ${receiptFilter}
    GROUP BY p.id, c.currency, o.dispatch_receipt
    HAVING SUM(o.unit_dispatch) > 0
    ORDER BY o.dispatch_receipt, p.store NULLS LAST, p.name
  `
  return rows.map((r) => ({
    productName: r.product_name as string,
    qty: r.qty as number,
    valas: Number(r.valas) || 0,
    currency: (r.currency as string) ?? "",
    receipt: (r.receipt as string) ?? "",
  }))
}
