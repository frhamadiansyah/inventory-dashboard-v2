import sql from "../db-pool"
import { allocateFifo } from "../fifo-fill"
import type { DBExecutor } from "./actor"

// ─── Shopping List ────────────────────────────────────────────────────────

export type PaidStatus = "paid" | "partial" | "unpaid"

// Stock is finite, so when only some of an order line is bought/arrives we hand
// it out to higher-priority customers first: already-paid before partially-paid
// before unpaid (the people who've committed money get their goods first), and
// within a tier the earliest order (smallest id) wins. Used by every FIFO
// allocator + the on-screen previews so what you see matches what gets filled.
export const PAID_PRIORITY_RANK: Record<PaidStatus, number> = { paid: 0, partial: 1, unpaid: 2 }

/**
 * Comparator for ordering a single event's order rows by allocation priority.
 * `statusMap` is keyed `${event}|${customer}` (as built by fetchPaidStatusMap);
 * a missing entry is treated as unpaid. `event` fixes the lookup key.
 */
export function compareOrderPriority(event: string, statusMap: Map<string, PaidStatus>) {
  return (a: { id: number; customer: string }, b: { id: number; customer: string }) => {
    const ra = PAID_PRIORITY_RANK[statusMap.get(`${event}|${a.customer}`) ?? "unpaid"]
    const rb = PAID_PRIORITY_RANK[statusMap.get(`${event}|${b.customer}`) ?? "unpaid"]
    return ra - rb || a.id - b.id
  }
}

export interface ShoppingListOrder {
  id: number
  customer: string
  unit: number       // original ordered qty
  unitBuy: number    // already bought (0 if none)
  pending: number    // unit - unitBuy
  // Whether the customer has settled this event's invoice. Mirrors the same
  // math as computeEventCore: paid >= subtotal + ongkir*weight + adjustments.
  paidStatus: PaidStatus
}

export interface ShoppingListItem {
  event: string
  productId: number
  productName: string
  store: string
  price: number   // rupiah selling price
  valas: number   // foreign-currency cost, 0 when the product has none
  currency: string // valas's currency code, "" when valas is 0
  totalUnits: number      // remaining to buy
  totalOriginal: number   // full ordered qty (for partial-state display)
  customerCount: number
  customers: string[]
  orderIds: number[]
  orders: ShoppingListOrder[]
}

export async function getShoppingList(event?: string): Promise<ShoppingListItem[]> {
  // Includes partially-bought orders (unit_buy < unit), not just untouched ones.
  // Aggregations expose both the remaining-to-buy quantity and the full ordered
  // quantity so the UI can show "5 / 10" when an order is partially fulfilled.
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
            p.price,
            p.valas,
            COALESCE(c.currency, '') AS currency,
            SUM(o.unit - COALESCE(o.unit_buy, 0))::int AS total_pending,
            prod_total.total_original,
            COUNT(DISTINCT o.customer)::int AS customer_count,
            ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
            ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', o.id,
              'customer', o.customer,
              'unit', o.unit,
              'unitBuy', COALESCE(o.unit_buy, 0),
              'pending', o.unit - COALESCE(o.unit_buy, 0)
            ) ORDER BY o.customer, o.id) AS orders
          FROM orders o
          JOIN products p ON p.id = o.product_id
          LEFT JOIN countries c ON c.id = p.country_id
          -- Full ordered qty spans ALL orders for the product (including the
          -- fully-bought rows the WHERE below filters out), so the UI shows
          -- "remaining / total ordered" rather than "remaining / open rows".
          JOIN (
            SELECT event, product_id, SUM(unit)::int AS total_original
            FROM orders
            WHERE event = ${event}
            GROUP BY event, product_id
          ) prod_total ON prod_total.event = o.event AND prod_total.product_id = o.product_id
          WHERE (o.unit_buy IS NULL OR o.unit_buy < o.unit) AND o.event = ${event}
          GROUP BY o.event, o.product_id, p.name, p.store, p.price, p.valas, c.currency, prod_total.total_original
          HAVING SUM(o.unit - COALESCE(o.unit_buy, 0)) > 0
          ORDER BY p.name, p.store
        `
      : sql`
          SELECT
            o.event,
            o.product_id,
            p.name AS product_name,
            p.store,
            p.price,
            p.valas,
            COALESCE(c.currency, '') AS currency,
            SUM(o.unit - COALESCE(o.unit_buy, 0))::int AS total_pending,
            prod_total.total_original,
            COUNT(DISTINCT o.customer)::int AS customer_count,
            ARRAY_AGG(DISTINCT o.customer ORDER BY o.customer) AS customers,
            ARRAY_AGG(o.id ORDER BY o.id) AS order_ids,
            JSON_AGG(JSON_BUILD_OBJECT(
              'id', o.id,
              'customer', o.customer,
              'unit', o.unit,
              'unitBuy', COALESCE(o.unit_buy, 0),
              'pending', o.unit - COALESCE(o.unit_buy, 0)
            ) ORDER BY o.customer, o.id) AS orders
          FROM orders o
          JOIN products p ON p.id = o.product_id
          LEFT JOIN countries c ON c.id = p.country_id
          JOIN events e ON e.name = o.event
          -- Full ordered qty spans ALL orders for the (event, product),
          -- including the fully-bought rows the WHERE below filters out.
          JOIN (
            SELECT event, product_id, SUM(unit)::int AS total_original
            FROM orders
            GROUP BY event, product_id
          ) prod_total ON prod_total.event = o.event AND prod_total.product_id = o.product_id
          WHERE o.unit_buy IS NULL OR o.unit_buy < o.unit
          GROUP BY o.event, o.product_id, p.name, p.store, p.price, p.valas, c.currency, prod_total.total_original
          HAVING SUM(o.unit - COALESCE(o.unit_buy, 0)) > 0
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
      throw new Error("Shopping list query returned a malformed row (missing orders array) — likely a desynced DB connection; retry the request")
    }
  }

  const items: ShoppingListItem[] = rows.map((r) => ({
    event: r.event as string,
    productId: r.product_id as number,
    productName: r.product_name as string,
    store: r.store as string,
    price: (r.price as number) ?? 0,
    // valas is NUMERIC — postgres-js returns it as a string, so coerce.
    valas: Number(r.valas) || 0,
    currency: (r.currency as string) ?? "",
    totalUnits: r.total_pending as number,
    totalOriginal: r.total_original as number,
    customerCount: r.customer_count as number,
    customers: r.customers as string[],
    orderIds: r.order_ids as number[],
    orders: (r.orders as Omit<ShoppingListOrder, "paidStatus">[]).map((o) => ({
      ...o,
      paidStatus: statusMap.get(`${r.event}|${o.customer}`) ?? "unpaid",
    })),
  }))

  // Order each product's customers by allocation priority (paid → partial →
  // unpaid, then earliest order) so the buy modal's fill preview — which walks
  // this array in order — matches the server-side allocation in markProductBought.
  for (const item of items) {
    item.orders.sort(
      (a, b) => PAID_PRIORITY_RANK[a.paidStatus] - PAID_PRIORITY_RANK[b.paidStatus] || a.id - b.id,
    )
  }

  return items
}

/**
 * Compute paid status per (event, customer) for the given events. Mirrors
 * `computeEventCore` from invoice.ts:
 *   total = subtotal + ongkir_per_kg * ceil(total_gram / 1000) + adjustments
 *   paid  = sum of checked payments
 *   status = paid <= 0 ? unpaid : paid >= total ? paid : partial
 *
 * Pass `events: null` to compute status across every event (used when the
 * shopping list isn't event-filtered — lets this query run in parallel with
 * the items query, since we no longer have to wait for the items query to
 * tell us which events to scope to).
 *
 * The customer column is stored with inconsistent casing/@-prefix across
 * tables, so payments/adjustments/customers are joined on the normalized
 * handle (lower + strip @), matching how invoice.ts does it.
 */
export async function fetchPaidStatusMap(events: string[] | null): Promise<Map<string, PaidStatus>> {
  const map = new Map<string, PaidStatus>()
  if (events !== null && events.length === 0) return map

  const rows = events === null
    ? await sql`
        WITH order_totals AS (
          SELECT
            o.event,
            o.customer,
            lower(replace(o.customer, '@', '')) AS norm_cust,
            SUM(o.unit * o.unit_price)::numeric        AS subtotal,
            SUM(o.unit * COALESCE(p.gram, 0))::numeric AS total_gram
          FROM orders o
          JOIN products p ON p.id = o.product_id
          GROUP BY o.event, o.customer
        ),
        payment_totals AS (
          SELECT
            event,
            lower(replace(customer, '@', '')) AS norm_cust,
            COALESCE(SUM(amount), 0)::numeric AS paid
          FROM payments
          WHERE is_checked = true
          GROUP BY event, norm_cust
        ),
        adjustment_totals AS (
          SELECT
            event,
            lower(replace(customer, '@', '')) AS norm_cust,
            COALESCE(SUM(amount), 0)::numeric AS adj
          FROM adjustments
          GROUP BY event, norm_cust
        ),
        customer_ongkir AS (
          -- Per-(event, customer) ongkir: the rate from the event's warehouse.
          SELECT
            ev.name AS event,
            lower(replace(c.instagram_id, '@', '')) AS norm_id,
            COALESCE(cwo.ongkos_kirim, 0)::numeric AS ongkir
          FROM events ev
          JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
          JOIN customers c ON c.id = cwo.customer_id
        )
        SELECT
          ot.event,
          ot.customer,
          ot.subtotal,
          CEIL(ot.total_gram / 1000.0)::numeric AS weight_kg,
          COALESCE(co.ongkir, 0)::numeric AS ongkir,
          COALESCE(at.adj, 0)::numeric    AS adj,
          COALESCE(pt.paid, 0)::numeric   AS paid
        FROM order_totals ot
        LEFT JOIN customer_ongkir co  ON co.norm_id = ot.norm_cust AND co.event = ot.event
        LEFT JOIN payment_totals pt   ON pt.event = ot.event AND pt.norm_cust = ot.norm_cust
        LEFT JOIN adjustment_totals at ON at.event = ot.event AND at.norm_cust = ot.norm_cust
      `
    : await sql`
        WITH order_totals AS (
          SELECT
            o.event,
            o.customer,
            lower(replace(o.customer, '@', '')) AS norm_cust,
            SUM(o.unit * o.unit_price)::numeric        AS subtotal,
            SUM(o.unit * COALESCE(p.gram, 0))::numeric AS total_gram
          FROM orders o
          JOIN products p ON p.id = o.product_id
          WHERE o.event = ANY(${events})
          GROUP BY o.event, o.customer
        ),
        payment_totals AS (
          SELECT
            event,
            lower(replace(customer, '@', '')) AS norm_cust,
            COALESCE(SUM(amount), 0)::numeric AS paid
          FROM payments
          WHERE is_checked = true AND event = ANY(${events})
          GROUP BY event, norm_cust
        ),
        adjustment_totals AS (
          SELECT
            event,
            lower(replace(customer, '@', '')) AS norm_cust,
            COALESCE(SUM(amount), 0)::numeric AS adj
          FROM adjustments
          WHERE event = ANY(${events})
          GROUP BY event, norm_cust
        ),
        customer_ongkir AS (
          -- Per-(event, customer) ongkir: the rate from the event's warehouse.
          SELECT
            ev.name AS event,
            lower(replace(c.instagram_id, '@', '')) AS norm_id,
            COALESCE(cwo.ongkos_kirim, 0)::numeric AS ongkir
          FROM events ev
          JOIN customer_warehouse_ongkir cwo ON cwo.warehouse_id = ev.warehouse_id
          JOIN customers c ON c.id = cwo.customer_id
        )
        SELECT
          ot.event,
          ot.customer,
          ot.subtotal,
          CEIL(ot.total_gram / 1000.0)::numeric AS weight_kg,
          COALESCE(co.ongkir, 0)::numeric AS ongkir,
          COALESCE(at.adj, 0)::numeric    AS adj,
          COALESCE(pt.paid, 0)::numeric   AS paid
        FROM order_totals ot
        LEFT JOIN customer_ongkir co  ON co.norm_id = ot.norm_cust AND co.event = ot.event
        LEFT JOIN payment_totals pt   ON pt.event = ot.event AND pt.norm_cust = ot.norm_cust
        LEFT JOIN adjustment_totals at ON at.event = ot.event AND at.norm_cust = ot.norm_cust
      `

  for (const r of rows) {
    const subtotal = Number(r.subtotal) || 0
    const weightKg = Number(r.weight_kg) || 0
    const ongkir   = Number(r.ongkir) || 0
    const adj      = Number(r.adj) || 0
    const paid     = Number(r.paid) || 0
    const total    = subtotal + weightKg * ongkir + adj
    const status: PaidStatus = paid <= 0 ? "unpaid" : paid >= total ? "paid" : "partial"
    map.set(`${r.event}|${r.customer}`, status)
  }
  return map
}

export async function markOrdersAsBought(orderIds: number[], db: DBExecutor = sql): Promise<void> {
  if (orderIds.length === 0) return
  await db`
    UPDATE orders
    SET unit_buy = unit, updated_at = NOW()
    WHERE id = ANY(${orderIds}) AND unit_buy IS NULL
  `
}

/**
 * Out-of-stock: the supplier can't provide some/all pending units. FIFO-reduce
 * the earliest pending orders' quantity by `quantityOutOfStock`, only ever
 * touching un-bought units (unit stays >= unit_buy). The lowered `unit` drops
 * those units off both the shopping list and the customer's invoice; if they'd
 * already paid, the existing overpayment materializer (Refunds page) turns the
 * resulting overpayment into a refund — same mechanism as wrong-product/broken.
 * Nothing is logged to inventory, since nothing was ever received.
 */
export async function markProductOutOfStock(data: {
  event: string
  productId: number
  quantityOutOfStock: number
}, actor?: string | null): Promise<{ reducedOrderIds: number[]; reducedUnits: number }> {
  type Row = { id: number; customer: string; unit: number; unitBuy: number; pending: number }
  const orders = (await sql`
    SELECT
      id,
      customer,
      unit::int AS unit,
      COALESCE(unit_buy, 0)::int AS "unitBuy",
      (unit - COALESCE(unit_buy, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND (unit_buy IS NULL OR unit_buy < unit)
    ORDER BY id ASC
  `) as unknown as Row[]

  // Out of stock removes goods, so it's the mirror of buying: cancel the
  // LOWEST-priority orders first (unpaid → partial → paid, latest order within a
  // tier) to protect customers who've already paid. This is the buy priority
  // order reversed, matching the modal's out-of-stock preview.
  const statusMap = await fetchPaidStatusMap([data.event])
  orders.sort(compareOrderPriority(data.event, statusMap)).reverse()

  // Allocate the out-of-stock count across pending units in FIFO order. Each
  // order's `allocated` is bounded by its pending qty, so newUnit never drops
  // below unit_buy (already-bought units are never cancelled). Any leftover
  // beyond total pending is ignored — you can't be out of stock for units no
  // one is still waiting on.
  const { allocations } = allocateFifo(orders, (o) => o.pending, data.quantityOutOfStock)
  const reducedOrderIds: number[] = []
  let reducedUnits = 0

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    for (const { item: o, allocated } of allocations) {
      if (allocated <= 0) continue
      reducedOrderIds.push(o.id)
      reducedUnits += allocated
      await tx`
        UPDATE orders
        SET unit = ${o.unit - allocated}, updated_at = NOW()
        WHERE id = ${o.id}
      `
    }
  })

  return { reducedOrderIds, reducedUnits }
}

export async function markProductBought(data: {
  event: string
  productId: number
  productName: string
  quantityBought: number
  receipt: string
}, actor?: string | null): Promise<{ filledOrderIds: number[]; excessUnits: number }> {
  // Partial allocation lets an order have unit_buy < unit, so it stays in the
  // shopping list with reduced "remaining" qty. Mirrors /api/sheets/purchasing.
  type Row = { id: number; customer: string; unit: number; unitBuy: number; receipt: string; pending: number }
  const orders = (await sql`
    SELECT
      id,
      customer,
      unit::int AS unit,
      COALESCE(unit_buy, 0)::int AS "unitBuy",
      COALESCE(receipt, '') AS receipt,
      (unit - COALESCE(unit_buy, 0))::int AS pending
    FROM orders
    WHERE event = ${data.event}
      AND product_id = ${data.productId}
      AND (unit_buy IS NULL OR unit_buy < unit)
    ORDER BY id ASC
  `) as unknown as Row[]

  // Allocate to paid customers first, then partial, then unpaid (earliest order
  // within a tier). Matches the buy modal's preview ordering in getShoppingList.
  const statusMap = await fetchPaidStatusMap([data.event])
  orders.sort(compareOrderPriority(data.event, statusMap))

  const { allocations, excess: excessUnits } = allocateFifo(orders, (o) => o.pending, data.quantityBought)
  const filledOrderIds: number[] = []

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    for (const { item: o, allocated } of allocations) {
      const newUnitBuy = o.unitBuy + allocated
      const combinedReceipt = data.receipt
        ? (o.receipt ? `${o.receipt}, ${data.receipt}` : data.receipt)
        : o.receipt
      if (newUnitBuy >= o.unit) filledOrderIds.push(o.id)
      await tx`
        UPDATE orders
        SET unit_buy = ${newUnitBuy}, receipt = ${combinedReceipt}, updated_at = NOW()
        WHERE id = ${o.id}
      `
    }
    if (excessUnits > 0) {
      await tx`
        INSERT INTO excess_purchase (event, items, unit_buy, receipt)
        VALUES (${data.event}, ${data.productName}, ${excessUnits}, ${data.receipt})
      `
    }
  })

  return { filledOrderIds, excessUnits }
}

