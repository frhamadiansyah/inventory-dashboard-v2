"use client"

import { useState } from "react"
import type { ExcessTransitItem } from "@/lib/db"
import { REASON_LABEL, REASON_CLASS } from "@/app/dashboard/excess-purchase/ExcessTable"
import { fmt } from "@/lib/format"

type Stage = "dispatch" | "arrive"

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
      <div className="divide-y divide-cream-border">
        {items.map((it) => (
          <div key={it.rowNumber} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground truncate">{it.items}</div>
              <div className="text-xs text-gray-400">{it.event}</div>
            </div>
            <span className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-full text-[10px] font-medium border ${REASON_CLASS[it.reason]}`}>
              {REASON_LABEL[it.reason]}
            </span>
            <span className="text-sm font-bold tabular-nums text-foreground w-12 text-right">{fmt(it.pending)}</span>
            <button
              type="button"
              onClick={() => setOpenRow(it.rowNumber)}
              className="text-xs font-medium text-brand hover:underline shrink-0"
            >
              {actionLabel}
            </button>
          </div>
        ))}
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
