import sql from "../db-pool"
import { getShipOrdersFiltered } from "./fulfillment"

// ─── Dashboard Summary ─────────────────────────────────────────────────────

export interface DashboardActionQueue {
  overpaymentCandidates: number
  refundsReadyToTransfer: number
  itemsPendingPurchase: number
  paymentsUnverified: number
  customersReadyToShip: number
}

export interface DashboardEvent {
  name: string
  eta: string
  orderCount: number
  customerCount: number
  totalUnits: number
  totalSubtotal: number
  totalBought: number
  totalArrived: number
  totalShipped: number
  totalPaid: number
}

export interface DashboardTotals {
  itemsSold: number
  eventCount: number
  omzet: number
  invoiceCount: number
  profit: number
  outstanding: number
  outstandingCount: number
  refundNeeded: number
  refundCount: number
}

export interface DashboardSummary {
  actionQueue: DashboardActionQueue
  totals: DashboardTotals
  events: DashboardEvent[]
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [
    readyToShipCount,
    totalsRow,
    scalarsRow,
    eventRows,
  ] = await Promise.all([
    // "Ready to ship" reuses the exact same per-invoice status computation as
    // the packing list page (buildShipGroups) so the count here can never
    // drift from "Siap Dikirim" there — a plain unit_arrive > unit_ship count
    // used to overcount (it missed the all-lines-arrived, payment-clear, and
    // not-on-hold requirements).
    getShipOrdersFiltered({ segment: "ready" }).then((r) => r.counts.ready),
    // Headline money totals across all events, all-time. Omzet = full invoice
    // value billed (subtotal + ongkir + adjustments); invoice_count = number of
    // customer-event invoices; outstanding = per-customer unpaid balance floored
    // at 0. The payments join stays for the outstanding subtraction.
    // overpayment_candidates rides the same per-invoice scan (it used to be a
    // separate query with identical CTEs): invoices paid above their total
    // that don't already have an active overpayment refund ticket.
    sql`
      WITH order_aggregates AS (
        SELECT
          o.event,
          o.customer,
          SUM(o.unit_price * o.unit) AS subtotal,
          SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
        FROM orders o
        JOIN products p ON p.id = o.product_id
        GROUP BY o.event, o.customer
      ),
      payment_aggregates AS (
        SELECT event, customer, SUM(amount) AS total_paid
        FROM payments
        WHERE is_checked = true
        GROUP BY event, customer
      ),
      adjustment_aggregates AS (
        SELECT event, customer, SUM(amount) AS total_adj
        FROM adjustments
        GROUP BY event, customer
      )
      SELECT
        COUNT(*)::int AS invoice_count,
        COALESCE(SUM(
          oa.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0)
        ), 0)::bigint AS omzet,
        COALESCE(SUM(GREATEST(
          oa.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0)
          - COALESCE(pa.total_paid, 0)
        , 0)), 0)::bigint AS outstanding,
        COUNT(*) FILTER (WHERE
          oa.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
          + COALESCE(adj.total_adj, 0)
          - COALESCE(pa.total_paid, 0) > 0
        )::int AS outstanding_count,
        COUNT(*) FILTER (WHERE
          COALESCE(pa.total_paid, 0) > (
            oa.subtotal
            + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oa.total_gram::numeric / 1000)
            + COALESCE(adj.total_adj, 0)
          )
          AND NOT EXISTS (
            SELECT 1 FROM refunds r
            WHERE r.event = oa.event AND r.customer = oa.customer
              AND r.reason = 'overpayment' AND r.status != 'cancelled'
          )
        )::int AS overpayment_candidates
      FROM order_aggregates oa
      LEFT JOIN customers c ON c.instagram_id = oa.customer
      -- Ongkir is the rate from the event's warehouse (per-event routing).
      LEFT JOIN events ev ON ev.name = oa.event
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event AND pa.customer = oa.customer
      LEFT JOIN adjustment_aggregates adj ON adj.event = oa.event AND adj.customer = oa.customer
    `,
    // Single-row scalars, one round-trip. Each subselect was its own query
    // (its own pool slot); merged they cost the same DB work on one slot.
    sql`
      SELECT
        -- Refund tickets ready to pay out now.
        (SELECT COUNT(*)::int FROM refunds WHERE status = 'ready_to_refund') AS refunds_ready,
        -- Event-product groups still short of stock to buy.
        (SELECT COUNT(*)::int FROM (
          SELECT 1
          FROM orders
          WHERE unit_buy IS NULL OR unit_buy < unit
          GROUP BY event, product_id
          HAVING SUM(unit - COALESCE(unit_buy, 0)) > 0
        ) g) AS pending_purchase,
        -- Deposits awaiting verification.
        (SELECT COUNT(*)::int FROM payments WHERE kind = 'deposit' AND is_checked = false) AS unverified_payments,
        -- Operational costs across the active-event set — the trip/operating
        -- expense ledger (033), summed in rupiah (amount_idr is the IDR source).
        (SELECT COALESCE(SUM(oe.amount_idr), 0)::bigint
         FROM operational_expenses oe
         JOIN (
           SELECT event
           FROM orders
           GROUP BY event
           HAVING SUM(unit) > SUM(COALESCE(unit_ship, 0))
         ) ae ON ae.event = oe.event) AS operational_costs,
        -- Money owed back to customers — open refund tickets (any reason),
        -- across all events (a refund on a closed event still gets paid out).
        (SELECT COALESCE(SUM(refund_amount), 0)::bigint FROM refunds
         WHERE status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')) AS refund_needed,
        (SELECT COUNT(*)::int FROM refunds
         WHERE status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')) AS refund_count,
        -- Items sold all-time — every order across every event (not just the
        -- active set the money cards use), plus event count for the subline.
        (SELECT COALESCE(SUM(unit), 0)::int FROM orders) AS items_sold,
        (SELECT COUNT(DISTINCT event)::int FROM orders) AS event_count
    `,
    sql`
      WITH order_aggregates AS (
        SELECT
          o.event,
          COUNT(*)::int AS order_count,
          COUNT(DISTINCT o.customer)::int AS customer_count,
          SUM(o.unit)::int AS total_units,
          SUM(o.unit * o.unit_price)::int AS total_subtotal,
          SUM(COALESCE(o.unit_buy, 0))::int AS total_bought,
          SUM(COALESCE(o.unit_arrive, 0))::int AS total_arrived,
          SUM(COALESCE(o.unit_ship, 0))::int AS total_shipped
        FROM orders o
        GROUP BY o.event
      ),
      payment_aggregates AS (
        SELECT event, SUM(amount)::int AS total_paid
        FROM payments
        WHERE is_checked = true
        GROUP BY event
      )
      SELECT
        e.name,
        COALESCE(e.eta, '') AS eta,
        oa.order_count,
        oa.customer_count,
        oa.total_units,
        oa.total_subtotal,
        oa.total_bought,
        oa.total_arrived,
        oa.total_shipped,
        COALESCE(pa.total_paid, 0)::int AS total_paid
      FROM order_aggregates oa
      JOIN events e ON e.name = oa.event
      LEFT JOIN payment_aggregates pa ON pa.event = oa.event
      WHERE oa.total_units > oa.total_shipped
      ORDER BY e.created_at DESC NULLS LAST, e.name
    `,
  ])

  const scalars = scalarsRow[0] ?? {}

  return {
    actionQueue: {
      overpaymentCandidates: Number(totalsRow[0]?.overpayment_candidates ?? 0),
      refundsReadyToTransfer: Number(scalars.refunds_ready ?? 0),
      itemsPendingPurchase: Number(scalars.pending_purchase ?? 0),
      paymentsUnverified: Number(scalars.unverified_payments ?? 0),
      customersReadyToShip: readyToShipCount,
    },
    totals: {
      itemsSold: Number(scalars.items_sold ?? 0),
      eventCount: Number(scalars.event_count ?? 0),
      omzet: Number(totalsRow[0]?.omzet ?? 0),
      invoiceCount: Number(totalsRow[0]?.invoice_count ?? 0),
      profit: Number(totalsRow[0]?.omzet ?? 0) - Number(scalars.operational_costs ?? 0),
      outstanding: Number(totalsRow[0]?.outstanding ?? 0),
      outstandingCount: Number(totalsRow[0]?.outstanding_count ?? 0),
      refundNeeded: Number(scalars.refund_needed ?? 0),
      refundCount: Number(scalars.refund_count ?? 0),
    },
    events: eventRows.map((r) => ({
      name: r.name as string,
      eta: r.eta as string,
      orderCount: r.order_count as number,
      customerCount: r.customer_count as number,
      totalUnits: r.total_units as number,
      totalSubtotal: r.total_subtotal as number,
      totalBought: r.total_bought as number,
      totalArrived: r.total_arrived as number,
      totalShipped: r.total_shipped as number,
      totalPaid: r.total_paid as number,
    })),
  }
}

// ─── Per-Event Performance ─────────────────────────────────────────────────

/** One event's mini-dashboard stats, powering the expandable Events-page panel.
 *  Unlike getDashboardSummary's event list (active events only), this covers
 *  EVERY event — an event with no orders yet comes back with zeroed fields and
 *  hasActivity = false so the UI can render an empty state. */
export interface EventPerformance {
  name: string
  hasActivity: boolean
  // Sales
  orderCount: number
  customerCount: number
  totalUnits: number
  revenue: number
  kurs: number
  // Payments
  totalPaid: number
  outstanding: number
  unpaidCount: number
  overpaidCount: number
  dueRefund: number
  // Fulfillment
  totalBought: number
  totalArrived: number
  totalShipped: number
  // Profit — simple cash view: paid in minus operational expenses and money
  // still owed back to customers (overpayment) out.
  opsExpenses: number
  netProfit: number
}

export async function getEventPerformance(): Promise<EventPerformance[]> {
  const rows = await sql`
    WITH order_inv AS (
      -- Per (event, customer) invoice line-item aggregate.
      SELECT
        o.event,
        o.customer,
        SUM(o.unit_price * o.unit) AS subtotal,
        SUM(COALESCE(p.gram, 0) * o.unit) AS total_gram
      FROM orders o
      JOIN products p ON p.id = o.product_id
      GROUP BY o.event, o.customer
    ),
    pay_inv AS (
      SELECT event, customer, SUM(amount) AS total_paid
      FROM payments
      WHERE is_checked = true
      GROUP BY event, customer
    ),
    adj_inv AS (
      SELECT event, customer, SUM(amount) AS total_adj
      FROM adjustments
      GROUP BY event, customer
    ),
    invoice AS (
      -- Per (event, customer) invoice total + paid, ongkir routed via the
      -- event's warehouse (mirrors getDashboardSummary's omzet formula).
      SELECT
        oi.event,
        oi.subtotal
          + COALESCE(cwo.ongkos_kirim, 0) * CEIL(oi.total_gram::numeric / 1000)
          + COALESCE(aj.total_adj, 0) AS invoice_total,
        COALESCE(pi.total_paid, 0) AS paid
      FROM order_inv oi
      LEFT JOIN customers c ON c.instagram_id = oi.customer
      LEFT JOIN events ev ON ev.name = oi.event
      LEFT JOIN customer_warehouse_ongkir cwo
        ON cwo.customer_id = c.id AND cwo.warehouse_id = ev.warehouse_id
      LEFT JOIN pay_inv pi ON pi.event = oi.event AND pi.customer = oi.customer
      LEFT JOIN adj_inv aj ON aj.event = oi.event AND aj.customer = oi.customer
    ),
    sales AS (
      -- Revenue and outstanding are invoice-driven: only (event, customer)
      -- pairs that have orders have an invoice. Total-paid is deliberately NOT
      -- summed here — see pay_event below.
      SELECT
        event,
        COALESCE(SUM(invoice_total), 0)::bigint AS revenue,
        COALESCE(SUM(GREATEST(invoice_total - paid, 0)), 0)::bigint AS outstanding,
        COUNT(*) FILTER (WHERE invoice_total - paid > 0)::int AS unpaid_count,
        COUNT(*) FILTER (WHERE invoice_total - paid < 0)::int AS overpaid_count
      FROM invoice
      GROUP BY event
    ),
    pay_event AS (
      -- Headline "paid" = every checked payment for the event, including any
      -- from customers with no order rows (mistagged/overpayment). This matches
      -- the payments page total; invoice.paid above stays per-customer so the
      -- outstanding maths is unaffected.
      SELECT event, SUM(amount)::bigint AS total_paid
      FROM payments
      WHERE is_checked = true
      GROUP BY event
    ),
    order_agg AS (
      SELECT
        o.event,
        COUNT(*)::int AS order_count,
        COUNT(DISTINCT o.customer)::int AS customer_count,
        SUM(o.unit)::int AS total_units,
        SUM(COALESCE(o.unit_buy, 0))::int AS total_bought,
        SUM(COALESCE(o.unit_arrive, 0))::int AS total_arrived,
        SUM(COALESCE(o.unit_ship, 0))::int AS total_shipped
      FROM orders o
      GROUP BY o.event
    ),
    ops AS (
      -- avg_rate = amount-weighted average kurs actually paid on this event's
      -- non-IDR expenses (total IDR ÷ total foreign). Only rows with a genuine
      -- conversion rate count (rate NOT IN (0, 1)): pure-IDR rows (rate = 1) and
      -- rows with no rate set (rate = 0) are excluded — a rate-0 row would
      -- otherwise add its foreign amount to the denominator with ~no IDR on top,
      -- dragging the average below the real kurs. Sub-1 rates (e.g. VND ~0.86)
      -- are kept.
      SELECT
        event,
        SUM(amount_idr)::bigint AS ops_expenses,
        SUM(amount_idr) FILTER (WHERE rate NOT IN (0, 1))::numeric
          / NULLIF(SUM(amount_foreign) FILTER (WHERE rate NOT IN (0, 1)), 0) AS avg_rate
      FROM operational_expenses
      GROUP BY event
    ),
    refund_due AS (
      -- Money still owed back to customers — open refund tickets for the event.
      SELECT event, SUM(refund_amount)::bigint AS due_refund
      FROM refunds
      WHERE status IN ('pending', 'awaiting_bank_info', 'ready_to_refund')
      GROUP BY event
    )
    SELECT
      e.name,
      COALESCE(op.avg_rate, 0)::numeric AS kurs,
      COALESCE(oa.order_count, 0)::int AS order_count,
      COALESCE(oa.customer_count, 0)::int AS customer_count,
      COALESCE(oa.total_units, 0)::int AS total_units,
      COALESCE(oa.total_bought, 0)::int AS total_bought,
      COALESCE(oa.total_arrived, 0)::int AS total_arrived,
      COALESCE(oa.total_shipped, 0)::int AS total_shipped,
      COALESCE(s.revenue, 0)::bigint AS revenue,
      COALESCE(pe.total_paid, 0)::bigint AS total_paid,
      COALESCE(s.outstanding, 0)::bigint AS outstanding,
      COALESCE(s.unpaid_count, 0)::int AS unpaid_count,
      COALESCE(s.overpaid_count, 0)::int AS overpaid_count,
      COALESCE(op.ops_expenses, 0)::bigint AS ops_expenses,
      COALESCE(rd.due_refund, 0)::bigint AS due_refund
    FROM events e
    LEFT JOIN order_agg oa ON oa.event = e.name
    LEFT JOIN sales s ON s.event = e.name
    LEFT JOIN pay_event pe ON pe.event = e.name
    LEFT JOIN ops op ON op.event = e.name
    LEFT JOIN refund_due rd ON rd.event = e.name
  `

  return rows.map((r) => {
    const totalPaid = Number(r.total_paid ?? 0)
    const opsExpenses = Number(r.ops_expenses ?? 0)
    const dueRefund = Number(r.due_refund ?? 0)
    return {
      name: r.name as string,
      hasActivity: Number(r.order_count ?? 0) > 0,
      orderCount: Number(r.order_count ?? 0),
      customerCount: Number(r.customer_count ?? 0),
      totalUnits: Number(r.total_units ?? 0),
      revenue: Number(r.revenue ?? 0),
      kurs: Number(r.kurs ?? 0),
      totalPaid,
      outstanding: Number(r.outstanding ?? 0),
      unpaidCount: Number(r.unpaid_count ?? 0),
      overpaidCount: Number(r.overpaid_count ?? 0),
      dueRefund,
      totalBought: Number(r.total_bought ?? 0),
      totalArrived: Number(r.total_arrived ?? 0),
      totalShipped: Number(r.total_shipped ?? 0),
      opsExpenses,
      netProfit: totalPaid - opsExpenses - dueRefund,
    }
  })
}
