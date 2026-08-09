"use client"

import { useState } from "react"
import { displayIg, fmt } from "@/lib/format"
import type { CustomerDetail, InvoiceEvent, InvoiceOrderLine } from "@/lib/db"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import InvoiceSummary from "@/components/InvoiceSummary"
import { CustomerInfoModal } from "./CustomerInfoModal"
import { InvoiceMessageActions } from "./InvoiceMessageActions"
import { RefundFromInvoiceModal } from "./RefundFromInvoiceModal"
import { CancelOrderFromInvoiceModal } from "./CancelOrderFromInvoiceModal"
import { AddAdjustmentFromInvoiceModal } from "./AddAdjustmentFromInvoiceModal"

export function EventCard({
  event,
  customer,
  customerDetail,
  onMutated,
}: {
  event: InvoiceEvent
  customer: string
  customerDetail: CustomerDetail | null
  onMutated?: () => void
}) {
  const [infoOpen, setInfoOpen] = useState(false)
  const [refundLine, setRefundLine] = useState<InvoiceOrderLine | null>(null)
  const [cancelLine, setCancelLine] = useState<InvoiceOrderLine | null>(null)
  const [addAdjOpen, setAddAdjOpen] = useState(false)
  const { eta, status, shipments, showShipments, orders, totals } = event
  const { widths, startResize } = useResizableColumns({ order: 220, unit: 60, price: 100, subtotal: 100, ready: 60, refund: 56 })
  const shipmentCount = shipments.length

  return (
    <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-brand">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-white">{displayIg(customer).toUpperCase()}</span>
            {customerDetail && (
              <button
                type="button"
                onClick={() => setInfoOpen(true)}
                aria-label="Customer info"
                className="text-white/60 hover:text-white transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
            )}
          </div>
          {infoOpen && customerDetail && (
            <CustomerInfoModal customer={customer} detail={customerDetail} onClose={() => setInfoOpen(false)} />
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-white">
            <span className="font-medium">{event.eventId}</span>
            {eta && <span className="text-white/70">• {eta}</span>}
          </div>
          {status && (
            <div className="text-xs text-white/80">
              <span className="font-medium text-white">Status:</span> {status}
            </div>
          )}
          {showShipments &&
            shipments.map((s, i) => (
              <div key={i} className="text-xs text-white/80">
                <span className="font-medium text-white">
                  Resi{shipmentCount > 1 ? ` ${i + 1}/${shipmentCount}` : ""}:
                </span>{" "}
                <span className="font-mono">{s.resi}</span>
                {s.tanggalKirim && <span className="ml-2">({s.tanggalKirim})</span>}
              </div>
            ))}
        </div>
      </div>

      {/* Orders table (desktop) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs font-semibold text-brand border-b border-cream-border bg-cream">
              <th className="px-4 py-2 font-medium relative select-none" style={{ width: widths.order }}>
                Order
                <div onMouseDown={(e) => startResize("order", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unit }}>
                Unit
                <div onMouseDown={(e) => startResize("unit", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.price }}>
                Price
                <div onMouseDown={(e) => startResize("price", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.subtotal }}>
                Subtotal
                <div onMouseDown={(e) => startResize("subtotal", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.ready }}>
                Ready
                <div onMouseDown={(e) => startResize("ready", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-2 py-2" style={{ width: widths.refund }} />
            </tr>
          </thead>
          <tbody>
            {[...orders].reverse().map((r, i) => (
              <tr key={i} className="border-b border-cream-border/60 group">
                <td className="px-4 py-2">{r.productName || r.order}</td>
                <td className="px-4 py-2 text-right">{r.unit}</td>
                <td className="px-4 py-2 text-right">{r.price}</td>
                <td className="px-4 py-2 text-right">{r.subtotal}</td>
                <td className="px-4 py-2 text-right">{r.unitArrive}</td>
                <td className="px-2 py-2">
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRefundLine(r)}
                      title="Create refund for this line (money only — keeps the order)"
                      className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCancelLine(r)}
                      title="Cancel this order (customer backed out) — removes the line, refunds if paid, returns stock to Inventory"
                      className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-all"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="m4.9 4.9 14.2 14.2" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            <tr className="font-semibold bg-cream/40">
              <td className="px-4 py-2">Total</td>
              <td className="px-4 py-2 text-right">{totals.unit}</td>
              <td className="px-4 py-2"></td>
              <td className="px-4 py-2 text-right">{fmt(totals.subtotal)}</td>
              <td className="px-4 py-2 text-right">{totals.arrive}</td>
              <td className="px-2 py-2 text-center">
                <button
                  type="button"
                  onClick={() => setAddAdjOpen(true)}
                  title="Add adjustment for this invoice"
                  className="text-gray-400 hover:text-brand transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Orders list (mobile) */}
      <div className="md:hidden divide-y divide-cream-border/60">
        {[...orders].reverse().map((r, i) => (
          <div key={i} className="px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-foreground truncate">{r.productName || r.order}</div>
              <div className="text-xs text-gray-500 tabular-nums mt-0.5">
                {r.unit} × {r.price} = <span className="font-medium text-foreground">{r.subtotal}</span>
              </div>
              <div className="text-xs text-gray-400 tabular-nums mt-0.5">Ready {r.unitArrive}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setRefundLine(r)}
                title="Create refund for this line (money only — keeps the order)"
                className="text-gray-400 hover:text-red-500 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setCancelLine(r)}
                title="Cancel this order (customer backed out) — removes the line, refunds if paid, returns stock to Inventory"
                className="text-gray-400 hover:text-red-500 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m4.9 4.9 14.2 14.2" />
                </svg>
              </button>
            </div>
          </div>
        ))}
        <div className="px-4 py-3 flex items-center justify-between gap-3 bg-cream/40 font-semibold">
          <span className="text-sm text-foreground">Total</span>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-foreground">{totals.unit} units · {fmt(totals.subtotal)}</span>
            <button
              type="button"
              onClick={() => setAddAdjOpen(true)}
              title="Add adjustment for this invoice"
              className="text-gray-400 hover:text-brand transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Invoice summary */}
      <InvoiceSummary event={event} actions={<InvoiceMessageActions event={event} whatsapp={customerDetail?.whatsapp} />} />

      {/* Refund modal — triggered per order line */}
      {refundLine && (
        <RefundFromInvoiceModal
          line={refundLine}
          event={event.eventId}
          customer={customer}
          onClose={() => setRefundLine(null)}
        />
      )}

      {/* Cancel-order modal — customer backed out of this line */}
      {cancelLine && (
        <CancelOrderFromInvoiceModal
          line={cancelLine}
          event={event.eventId}
          customer={displayIg(customer)}
          productName={cancelLine.productName || (cancelLine.order ?? "").replace(/ x \d+$/, "")}
          onClose={() => setCancelLine(null)}
          onCancelled={() => { setCancelLine(null); onMutated?.() }}
        />
      )}

      {/* Add Adjustment modal — triggered from the Total row */}
      {addAdjOpen && (
        <AddAdjustmentFromInvoiceModal
          event={event.eventId}
          customer={customer}
          onClose={() => setAddAdjOpen(false)}
          onSaved={() => onMutated?.()}
        />
      )}
    </div>
  )
}
