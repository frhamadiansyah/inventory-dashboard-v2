"use client"

import { useState } from "react"
import type { ExcessTransitItem } from "@/lib/db"
import { REASON_LABEL, REASON_CLASS } from "@/app/dashboard/excess-purchase/ExcessTable"
import { fmt } from "@/lib/format"

type Stage = "dispatch" | "arrive"

// Matches the per-row action icon on the Dispatch List (paper airplane) and
// Receiving List (package) pages, so this section's action reads the same.
function StageIcon({ stage }: { stage: Stage }) {
  if (stage === "dispatch") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="22" y1="2" x2="11" y2="13" />
        <polygon points="22 2 15 22 11 13 2 9 22 2" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

export default function OverbuyTransitList({
  items,
  stage,
  onMarked,
}: {
  items: ExcessTransitItem[]
  stage: Stage
  onMarked: () => void
}) {
  const [openRow, setOpenRow] = useState<number | null>(null)

  if (items.length === 0) return null

  const title = stage === "dispatch" ? "Overbuy in transit" : "Overbuy awaiting arrival"
  const subtitle = stage === "dispatch"
    ? "Bought but not yet dispatched — no customer, tracked separately from ready stock."
    : "Dispatched but not yet arrived — no customer, tracked separately from ready stock."
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"
  const openItem = openRow != null ? items.find((i) => i.rowNumber === openRow) ?? null : null

  return (
    <div className="mt-4 rounded-xl border border-cream-border bg-white overflow-hidden">
      <div className="px-4 py-2.5 border-b border-cream-border bg-gray-50/80">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="text-xs text-gray-400">{subtitle}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-cream-border bg-gray-50/80">
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-44">Event</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Store</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Item</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-32">Reason</th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-20">Qty</th>
              <th className="px-4 py-2.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.rowNumber} className="border-b border-cream-border last:border-0 hover:bg-gray-50/50 transition-colors">
                <td className="px-4 py-2.5 text-foreground">{it.event}</td>
                <td className="px-4 py-2.5 text-gray-600">{it.store || "—"}</td>
                <td className="px-4 py-2.5 text-foreground">{it.items}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-medium border ${REASON_CLASS[it.reason]}`}>
                    {REASON_LABEL[it.reason]}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="tabular-nums font-bold text-foreground">{fmt(it.pending)}</span>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => setOpenRow(it.rowNumber)}
                    title={actionLabel}
                    className="text-gray-400 hover:text-green-600 transition-colors"
                  >
                    <StageIcon stage={stage} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openItem && (
        <MarkStageModal
          item={openItem}
          stage={stage}
          onClose={() => setOpenRow(null)}
          onSuccess={() => { setOpenRow(null); onMarked() }}
        />
      )}
    </div>
  )
}

function MarkStageModal({
  item,
  stage,
  onClose,
  onSuccess,
}: {
  item: ExcessTransitItem
  stage: Stage
  onClose: () => void
  onSuccess: () => void
}) {
  const [qty, setQty] = useState(String(item.pending))
  const [receipt, setReceipt] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const quantity = Math.max(0, Number(qty) || 0)
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"

  async function handleSubmit() {
    if (quantity < 1) return
    setSaving(true)
    setError(null)
    try {
      const body: { qty: number; receipt?: string } = { qty: quantity }
      if (stage === "dispatch") body.receipt = receipt.trim()
      const res = await fetch(`/api/sheets/excess-purchase/${item.rowNumber}/${stage}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">{actionLabel}</div>
        <p className="text-sm text-gray-600">{item.items} — {item.event}</p>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-500">Quantity <span className="text-gray-400">(pending: {item.pending})</span></span>
          <input
            type="number"
            min={1}
            max={item.pending}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            autoFocus
            className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
          />
        </label>
        {stage === "dispatch" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Dispatch tracking <span className="text-gray-400 font-normal">(optional)</span></span>
            <input
              type="text"
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              placeholder="e.g. TRK-001"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </label>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={handleSubmit} disabled={saving || quantity < 1} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
