"use client"

import { useEffect, useState } from "react"
import { fmt } from "@/lib/format"
import type { InvoiceOrderLine, RefundReason } from "@/lib/db"
import { REFUND_REASONS } from "@/lib/db/types"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import SearchableSelect from "@/components/SearchableSelect"

// ─── Refund from invoice modal ───────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  overpayment: "Overpayment",
  unavailable: "Item Unavailable",
  shipping_loss: "Lost in Shipping",
  damaged: "Damaged",
  goodwill: "Goodwill",
  other: "Other",
}
const toReasonOptions = (reasons: string[]) =>
  Array.from(new Set([...REFUND_REASONS, ...reasons])).map((r) => ({ value: r, label: REASON_LABELS[r] ?? r }))

const INPUT_CLASS =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

export function RefundFromInvoiceModal({
  line,
  event,
  customer,
  onClose,
}: {
  line: InvoiceOrderLine
  event: string
  customer: string
  onClose: () => void
}) {
  useModalDismiss(onClose)

  // Resolve unit price: use raw if valid, otherwise parse the formatted string ("390.000" → 390000)
  const unitPrice =
    Number(line.rawUnitPrice) > 0
      ? Number(line.rawUnitPrice)
      : Number(String(line.price ?? "").replace(/\D/g, "")) || 0

  const unfulfilledUnits = Math.max(0, line.unit - line.unitArrive)
  const defaultReason: RefundReason = unfulfilledUnits > 0 ? "shipping_loss" : "other"

  const [reason, setReason] = useState<RefundReason>(defaultReason)
  const [reasonOptions, setReasonOptions] = useState(() => toReasonOptions([]))
  const [affectedUnits, setAffectedUnits] = useState(String(line.unit))
  const [refundAmount, setRefundAmount] = useState(String(line.unit * unitPrice))
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Pull in any previously-typed custom reasons so they show up as suggestions.
  useEffect(() => {
    let cancelled = false
    fetch("/api/sheets/refunds?meta=reasons")
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setReasonOptions(toReasonOptions(data.reasons ?? [])) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  function handleAffectedUnitsChange(val: string) {
    setAffectedUnits(val)
    const n = Number(val)
    if (Number.isFinite(n)) {
      setRefundAmount(String(n * unitPrice))
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          customer,
          reason,
          refundAmount: Number(refundAmount),
          orderId: line.orderId,
          affectedUnits: Number(affectedUnits),
          note: note.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to create")
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Create Refund</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {line.productName || (line.order ?? "").replace(/ x \d+$/, "")} × {line.unit}
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
            <p className="text-sm font-medium text-foreground">Refund created</p>
            <p className="text-xs text-gray-400">Track it on the Refunds page</p>
            <button type="button" onClick={onClose} className="mt-1 px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Reason</span>
                <SearchableSelect
                  value={reason}
                  onChange={(v) => setReason(v)}
                  options={reasonOptions}
                  placeholder="Select or type…"
                  allowNewValue
                  disabled={saving}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">
                  Affected units <span className="text-gray-400 font-normal">(of {line.unit} ordered, {line.unitArrive} arrived)</span>
                </span>
                <input
                  type="number"
                  min="1"
                  max={line.unit}
                  value={affectedUnits}
                  onChange={(e) => handleAffectedUnitsChange(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Refund amount (Rp)</span>
                <input
                  type="number"
                  min="1"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  disabled={saving}
                  className={INPUT_CLASS}
                />
                <span className="text-xs text-gray-400">
                  {Number(affectedUnits)} × Rp {fmt(unitPrice)}
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-gray-500">Note <span className="text-gray-400 font-normal">(optional)</span></span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={saving}
                  rows={2}
                  placeholder="e.g. Lost during international transit"
                  className={`${INPUT_CLASS} resize-none`}
                />
              </label>
            </div>

            {error && <p className="text-xs text-red-500">{error}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={saving || Number(refundAmount) < 1} className="px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 disabled:opacity-50 transition-colors">
                {saving ? "Creating…" : "Create Refund"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
