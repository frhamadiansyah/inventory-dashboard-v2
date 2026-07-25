"use client"

import { useState } from "react"
import type { InvoiceOrderLine } from "@/lib/db"
import { useModalDismiss } from "@/hooks/useModalDismiss"

// ─── Cancel order from invoice modal ─────────────────────────────────────────
//
// Customer backed out of this line. Cancels the order (drops it off the invoice
// + packing list, auto-refunds if already paid) and returns its still-in-hand
// bought units to Inventory as ready stock. Distinct from "Create refund",
// which only records money owed and keeps the order line intact.

export function CancelOrderFromInvoiceModal({
  line,
  event,
  customer,
  productName,
  onClose,
  onCancelled,
}: {
  line: InvoiceOrderLine
  event: string
  customer: string
  productName: string
  onClose: () => void
  onCancelled: () => void
}) {
  useModalDismiss(onClose)

  const [qty, setQty] = useState(String(line.unit))
  // Tags the returned-to-inventory stock; defaults to the customer's username so
  // it's traceable to who cancelled (editable).
  const [receipt, setReceipt] = useState(customer)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Actual units returned to Inventory, filled from the server response so the
  // done-state reflects already-shipped units being excluded.
  const [returnedUnits, setReturnedUnits] = useState<number | null>(null)

  const qtyNum = Math.round(Number(qty)) || 0
  const qtyValid = qtyNum >= 1 && qtyNum <= line.unit
  const isFull = qtyNum === line.unit
  // Approximate preview — the server has the authoritative unit_ship figure;
  // this just caps at what's known to have been bought at all.
  const previewReturn = Math.max(0, Math.min(qtyNum, line.unitBuy))

  async function handleSubmit() {
    if (!qtyValid) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "customer_cancelled",
          event,
          productName,
          orderId: line.orderId,
          qty: qtyNum,
          receipt,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel order")
      setReturnedUnits(typeof data.excessUnits === "number" ? data.excessUnits : 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel order")
      setSaving(false)
    }
  }

  const done = returnedUnits !== null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Cancel Order</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {productName || (line.order ?? "").replace(/ x \d+$/, "")} × {line.unit}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
              <circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />
            </svg>
            <p className="text-sm font-medium text-foreground">
              {qtyNum} unit{qtyNum === 1 ? "" : "s"} cancelled
            </p>
            <p className="text-xs text-gray-400">
              {returnedUnits! > 0
                ? `${returnedUnits} unit${returnedUnits === 1 ? "" : "s"} returned to Inventory. `
                : "No stock returned to Inventory. "}
              A refund appears on the Refunds page if this order was already paid.
            </p>
            <button
              type="button"
              onClick={onCancelled}
              className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm text-gray-600">
              <p>
                Cancel units for <span className="font-medium">{customer}</span> on this order.
              </p>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">
                  Units to cancel <span className="text-gray-400 font-normal">(of {line.unit} ordered)</span>
                </span>
                <input
                  type="number"
                  min={1}
                  max={line.unit}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  disabled={saving}
                  className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                />
                {!qtyValid && qty !== "" && (
                  <span className="text-xs text-red-500">Enter a number between 1 and {line.unit}.</span>
                )}
              </label>

              {previewReturn > 0 && (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-500">
                    Inventory receipt <span className="text-gray-400 font-normal">(tags the returned stock)</span>
                  </span>
                  <input
                    type="text"
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    disabled={saving}
                    placeholder="e.g. customer username"
                    className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                  />
                </label>
              )}

              <ul className="flex flex-col gap-1.5 text-xs">
                <li className="flex gap-2">
                  <span className="text-gray-400">•</span>
                  <span>
                    {isFull
                      ? "Drop the line from the invoice and packing list."
                      : <>Reduce this order from {line.unit} to <span className="font-medium">{line.unit - qtyNum}</span> unit{line.unit - qtyNum === 1 ? "" : "s"}.</>}
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-gray-400">•</span>
                  <span>Create a refund on the Refunds page if the cancelled portion was already paid.</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-gray-400">•</span>
                  <span>
                    {previewReturn > 0
                      ? <>Return up to <span className="font-medium">{previewReturn} bought unit{previewReturn === 1 ? "" : "s"}</span> to Inventory as ready stock (already-shipped units aren&apos;t returned).</>
                      : <>Return nothing to Inventory — this portion hasn&apos;t been bought yet.</>}
                  </span>
                </li>
              </ul>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Keep order
              </button>
              <button type="button" onClick={handleSubmit} disabled={saving || !qtyValid} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
                {saving ? "Cancelling…" : isFull ? "Cancel Order" : `Cancel ${qtyNum} Unit${qtyNum === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
