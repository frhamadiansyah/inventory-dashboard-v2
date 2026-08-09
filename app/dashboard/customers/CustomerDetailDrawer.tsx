"use client"

import { useEffect, useState } from "react"
import { displayIg, fmt } from "@/lib/format"
import type {
  InvoiceResult,
  InvoiceEvent,
  PaymentRow,
  AdjustmentRow,
  RefundRow,
  RefundReason,
  RefundStatus,
} from "@/lib/db"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import InvoiceSummary from "@/components/InvoiceSummary"

type CustomerSummary = {
  invoices: InvoiceResult
  payments: PaymentRow[]
  adjustments: AdjustmentRow[]
  refunds: RefundRow[]
}

const REASON_LABELS: Record<string, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}
const reasonLabel = (reason: RefundReason) => REASON_LABELS[reason] ?? reason

const STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "Pending",
  awaiting_bank_info: "Awaiting Bank Info",
  ready_to_refund: "Ready to Refund",
  refunded: "Refunded",
  applied_to_next_order: "Applied to Next Order",
  cancelled: "Cancelled",
}

export function CustomerDetailDrawer({
  customer,
  onClose,
}: {
  customer: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CustomerSummary | null>(null)

  useModalDismiss(onClose)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    fetch(`/api/sheets/customers/summary?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? "Failed to load")
        return json as CustomerSummary
      })
      .then((json) => { if (!cancelled) setData(json) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [customer])

  // Money header — summed across the customer's invoices.
  const events = data?.invoices.events ?? []
  const invoiced = events.reduce((s, e) => s + e.invoice.total, 0)
  const paid = events.reduce((s, e) => s + e.invoice.pembayaran, 0)
  const balance = events.reduce((s, e) => s + e.invoice.sisaPelunasan, 0)

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 transition-opacity" />
      <div
        className="relative w-full max-w-3xl h-full bg-cream shadow-2xl border-l border-cream-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-cream-border bg-white shrink-0 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">{displayIg(customer)}</div>
            {data && (
              <div className="text-xs text-gray-400 mt-0.5">
                {events.length} event{events.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors p-1 rounded shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {loading && (
            <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
              Loading customer…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          {data && (
            <>
              {/* Money header */}
              <div className="grid grid-cols-3 gap-2 rounded-xl border border-cream-border bg-white p-4">
                <Money label="Invoiced" value={invoiced} />
                <Money label="Paid" value={paid} />
                <Money
                  label={balance < 0 ? "Overpaid" : "Balance"}
                  value={Math.abs(balance)}
                  className={balance > 0 ? "text-red-600" : balance < 0 ? "text-purple-600" : "text-green-700"}
                />
              </div>

              {/* Customer detail */}
              {data.invoices.customerDetail && (
                <div className="rounded-xl border border-cream-border bg-white p-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <DetailField label="WhatsApp" value={data.invoices.customerDetail.whatsapp} />
                  <DetailField label="Ekspedisi" value={data.invoices.customerDetail.ekspedisi} />
                  <DetailField label="Alamat" value={data.invoices.customerDetail.dataDiri} className="col-span-2" valueClassName="whitespace-pre-line" />
                  <DetailField label="Bank" value={data.invoices.customerDetail.bankName} />
                  <DetailField label="No. Rekening" value={data.invoices.customerDetail.bankAccountNumber} />
                  <DetailField label="Atas Nama" value={data.invoices.customerDetail.bankAccountHolder} />
                </div>
              )}

              {/* Invoices */}
              <Section title="Order history" count={events.length} empty="No invoices yet">
                {events.map((ev) => (
                  <InvoiceBlock key={ev.eventId} event={ev} />
                ))}
              </Section>

              {/* Payments */}
              <Section title="Payments" count={data.payments.length} empty="No payments yet">
                <div className="rounded-xl border border-cream-border bg-white divide-y divide-cream-border">
                  {data.payments.map((p) => (
                    <div key={p.rowNumber} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="text-foreground">{p.event}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {p.payDate || "—"} · {p.account}
                          {p.kind !== "deposit" ? ` · ${p.kind}` : ""}
                          {p.remarks ? ` · ${p.remarks}` : ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="tabular-nums text-foreground">Rp {fmt(p.amount)}</span>
                        <span className={`text-[11px] ${p.isChecked ? "text-green-600" : "text-gray-400"}`}>
                          {p.isChecked ? "✓" : "pending"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Adjustments */}
              <Section title="Adjustments" count={data.adjustments.length} empty="No adjustments yet">
                <div className="rounded-xl border border-cream-border bg-white divide-y divide-cream-border">
                  {data.adjustments.map((a) => (
                    <div key={a.rowNumber} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="text-foreground">{a.event}</div>
                        {a.description && <div className="text-xs text-gray-400 mt-0.5">{a.description}</div>}
                      </div>
                      <span className={`tabular-nums shrink-0 ${a.amount < 0 ? "text-green-700" : "text-foreground"}`}>
                        {a.amount < 0 ? "− " : "+ "}Rp {fmt(Math.abs(a.amount))}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>

              {/* Refunds */}
              <Section title="Refunds" count={data.refunds.length} empty="No refunds yet">
                <div className="rounded-xl border border-cream-border bg-white divide-y divide-cream-border">
                  {data.refunds.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="text-foreground">{r.event}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {reasonLabel(r.reason)} · {STATUS_LABELS[r.status]}
                        </div>
                      </div>
                      <span className="tabular-nums text-foreground shrink-0">Rp {fmt(r.refundAmount)}</span>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function DetailField({ label, value, className, valueClassName }: {
  label: string; value: string; className?: string; valueClassName?: string
}) {
  return (
    <div className={`flex flex-col gap-0.5 min-w-0 ${className ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</span>
      <span className={`text-foreground ${valueClassName ?? "truncate"}`}>{value || "—"}</span>
    </div>
  )
}

function Money({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${className ?? "text-foreground"}`}>Rp {fmt(value)}</span>
    </div>
  )
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string
  count: number
  empty: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</span>
        <span className="text-xs text-gray-400">{count}</span>
      </div>
      {count === 0 ? (
        <div className="rounded-xl border border-cream-border bg-white px-4 py-5 text-center text-sm text-gray-400">{empty}</div>
      ) : (
        children
      )}
    </div>
  )
}

// Read-only invoice block: collapsible event header + order lines + the shared
// totals summary. No action buttons (that's the interactive EventCard on the
// invoice page). Collapsed by default so a customer with many events stays
// scannable; the header carries the total and outstanding at a glance.
function InvoiceBlock({ event }: { event: InvoiceEvent }) {
  const [open, setOpen] = useState(false)
  const { total, sisaPelunasan } = event.invoice
  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full px-4 py-2.5 bg-cream border-b border-cream-border flex items-center gap-2 text-left hover:bg-cream/70 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}><path d="m9 18 6-6-6-6" /></svg>
        <span className="text-sm font-semibold text-foreground">{event.eventId}</span>
        {event.status && <span className="text-xs text-gray-500">{event.status}</span>}
        <span className="ml-auto flex items-center gap-3 shrink-0 tabular-nums">
          <span className="text-sm text-foreground">Rp {fmt(total)}</span>
          {sisaPelunasan > 0 && <span className="text-xs text-red-600">Rp {fmt(sisaPelunasan)} owed</span>}
          {sisaPelunasan < 0 && <span className="text-xs text-purple-600">Rp {fmt(-sisaPelunasan)} over</span>}
        </span>
      </button>
      {open && (
        <>
          <div className="divide-y divide-cream-border/60">
            {event.orders.map((o) => (
              <div key={o.orderId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 truncate text-foreground">{o.order}</span>
                <span className="flex items-center gap-3 shrink-0 tabular-nums text-gray-500">
                  <span>{o.unit} × {o.price}</span>
                  <span className="text-foreground">{o.subtotal}</span>
                </span>
              </div>
            ))}
          </div>
          <InvoiceSummary event={event} />
        </>
      )}
    </div>
  )
}
