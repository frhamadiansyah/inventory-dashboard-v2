"use client"

import { displayIg, fmt } from "@/lib/format"
import { useEffect, useMemo, useState } from "react"
import SearchableSelect from "@/components/SearchableSelect"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"

type ItemLine = {
  id: number
  item: string
  qty: string
  wrongProduct: boolean
  expectedItem: string
}
type UpdatedRow = { rowNumber: number; customer: string; oldUnitArrive: number; unitArrive: number }
type ItemResult = {
  item: string
  expectedItem?: string
  rows: UpdatedRow[]
  unmatched: number
  loggedAs?: "overship" | "wrong_product"
}
type Result = { type: "success"; results: ItemResult[] } | { type: "error"; message: string }

const FIELD =
  "w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
const LABEL = "text-sm font-medium text-foreground mb-1.5 block"

let _nextId = 0
function newLine(): ItemLine {
  return { id: _nextId++, item: "", qty: "", wrongProduct: false, expectedItem: "" }
}

export default function ArriveBulkModal({
  onClose,
  onProcessed,
}: {
  onClose: () => void
  onProcessed: () => void
}) {
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  const [lines, setLines] = useState<ItemLine[]>([newLine()])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  function updateLine<K extends keyof Omit<ItemLine, "id">>(
    id: ItemLine["id"],
    field: K,
    value: ItemLine[K],
  ) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, [field]: value } : l)))
    setResult(null)
  }

  function addLine() {
    setLines((prev) => [...prev, newLine()])
  }

  function removeLine(id: ItemLine["id"]) {
    setLines((prev) => prev.filter((l) => l.id !== id))
  }

  const itemOptions = useMemo(
    () => (options?.items ?? []).map((it) => ({
      value: it.name,
      label: it.name,
      meta: `Rp ${fmt(it.price)}`,
    })),
    [options?.items],
  )

  const canSubmit =
    Boolean(event) &&
    lines.length > 0 &&
    lines.every((l) => {
      if (!l.item || !l.qty || Number(l.qty) <= 0) return false
      if (l.wrongProduct && (!l.expectedItem || l.expectedItem === l.item)) return false
      return true
    })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setResult(null)
    try {
      const res = await fetch("/api/sheets/arrive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          items: lines.map((l) => ({
            item: l.item,
            qty: Number(l.qty),
            ...(l.wrongProduct && l.expectedItem ? { expectedItem: l.expectedItem } : {}),
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")
      setResult({ type: "success", results: data.results })
      setLines([newLine()])
      onProcessed()
    } catch (err) {
      setResult({ type: "error", message: err instanceof Error ? err.message : "Failed" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4 md:py-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl md:rounded-xl shadow-xl border-x border-t border-cream-border md:border w-full max-w-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-base md:text-sm font-semibold text-foreground">Add Bulk Arrival</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Select an event, add items + quantities. Extra units beyond demand are logged as overship in Inventory. Toggle &ldquo;wrong product&rdquo; on a line if the supplier shipped a different SKU.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto">
          {result?.type === "success" && (
            <div className="mb-4 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-green-50 border border-green-200">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-600 shrink-0 mt-0.5">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-green-800">Arrival processed</div>
                <div className="text-xs text-green-700 mt-0.5">
                  {(() => {
                    const totalOrders = result.results.reduce((s, r) => s + r.rows.length, 0)
                    const overshipUnits = result.results
                      .filter((r) => r.loggedAs === "overship")
                      .reduce((s, r) => s + r.unmatched, 0)
                    const wrongUnits = result.results
                      .filter((r) => r.loggedAs === "wrong_product")
                      .reduce((s, r) => s + r.unmatched, 0)
                    const parts = [
                      `${result.results.length} item${result.results.length === 1 ? "" : "s"}`,
                      `${totalOrders} order${totalOrders === 1 ? "" : "s"} updated`,
                    ]
                    if (overshipUnits > 0) parts.push(`${overshipUnits} overship → ready stock`)
                    if (wrongUnits > 0) parts.push(`${wrongUnits} wrong product → ready stock`)
                    return parts.join(" · ")
                  })()}
                </div>
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-5" id="arrive-bulk-form">
            {/* Event */}
            <div>
              <label className={LABEL}>
                Event <span className="text-brand">*</span>
              </label>
              <EventSelect
                value={event}
                onChange={(v) => { setEvent(v); setResult(null) }}
                events={options?.events ?? []}
                placeholder="Select event…"
              />
            </div>

            {/* Item lines */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className={LABEL + " mb-0"}>
                  Items <span className="text-brand">*</span>
                </label>
                <button
                  type="button"
                  onClick={addLine}
                  className="text-xs text-brand hover:underline"
                >
                  + Add item
                </button>
              </div>

              <div className="space-y-3">
                {lines.map((line) => {
                  const receivedLabel = line.wrongProduct ? "Received item (what supplier sent)" : "Item"
                  return (
                    <div
                      key={line.id}
                      className={`flex flex-col gap-2 ${line.wrongProduct ? "rounded-lg border border-yellow-200 bg-yellow-50/40 p-2" : ""}`}
                    >
                      <div className="flex gap-2 items-start">
                        <div className="flex-1">
                          {line.wrongProduct && (
                            <div className="text-[10px] uppercase tracking-wide text-yellow-700 font-medium mb-1">
                              {receivedLabel}
                            </div>
                          )}
                          <SearchableSelect
                            value={line.item}
                            onChange={(v) => updateLine(line.id, "item", v)}
                            options={itemOptions}
                            placeholder="Search item…"
                          />
                        </div>
                        <div>
                          {line.wrongProduct && (
                            <div className="text-[10px] uppercase tracking-wide text-yellow-700 font-medium mb-1">Qty</div>
                          )}
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={line.qty}
                            onChange={(e) => updateLine(line.id, "qty", e.target.value)}
                            placeholder="Qty"
                            className="w-20 border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                          />
                        </div>
                        {lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            className={`text-gray-300 hover:text-red-400 transition-colors ${line.wrongProduct ? "mt-7" : "mt-2"}`}
                            aria-label="Remove"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>

                      {line.wrongProduct && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wide text-yellow-700 font-medium mb-1">
                            Expected item (what we ordered)
                          </div>
                          <SearchableSelect
                            value={line.expectedItem}
                            onChange={(v) => updateLine(line.id, "expectedItem", v)}
                            options={itemOptions}
                            placeholder="Search expected item…"
                          />
                        </div>
                      )}

                      <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={line.wrongProduct}
                          onChange={(e) => {
                            updateLine(line.id, "wrongProduct", e.target.checked)
                            if (!e.target.checked) updateLine(line.id, "expectedItem", "")
                          }}
                          className="accent-yellow-600"
                        />
                        Supplier sent wrong product
                      </label>
                    </div>
                  )
                })}
              </div>
            </div>

            {result?.type === "error" && (
              <p className="text-sm text-red-600">{result.message}</p>
            )}
          </form>

          {/* Results */}
          {result?.type === "success" && (
            <div className="mt-4 space-y-3">
              {result.results.map((itemResult) => (
                <div key={`${itemResult.item}-${itemResult.expectedItem ?? ""}`} className="rounded-lg border border-cream-border bg-white overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-cream-border bg-cream flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">{itemResult.item}</div>
                      {itemResult.expectedItem && (
                        <div className="text-xs text-yellow-700 mt-0.5 truncate">
                          expected: {itemResult.expectedItem}
                        </div>
                      )}
                    </div>
                    <span className={`text-xs font-medium ml-3 shrink-0 ${itemResult.rows.length > 0 ? "text-green-600" : "text-gray-400"}`}>
                      {itemResult.rows.length === 0
                        ? "No orders updated"
                        : `${itemResult.rows.length} order${itemResult.rows.length === 1 ? "" : "s"} updated`}
                    </span>
                  </div>

                  {itemResult.unmatched > 0 && (
                    <div className="px-4 py-2 border-b border-cream-border bg-yellow-50 flex items-center gap-2">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-600 shrink-0">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                      <span className="text-xs text-yellow-700">
                        <strong>{itemResult.unmatched}</strong> unit{itemResult.unmatched === 1 ? "" : "s"} →{" "}
                        {itemResult.loggedAs === "wrong_product"
                          ? "logged as wrong product in Inventory"
                          : itemResult.loggedAs === "overship"
                            ? "logged as overship in Inventory"
                            : "could not be matched to any order"}
                      </span>
                    </div>
                  )}

                  {itemResult.rows.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-gray-400">
                      No eligible orders found.
                    </p>
                  ) : (
                    <ArriveResultTable rows={itemResult.rows} />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 pt-3 pb-8 md:py-3 border-t border-cream-border shrink-0 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="arrive-bulk-form"
            disabled={submitting || !canSubmit}
            title={!canSubmit ? "Select an event and add at least one item with a quantity" : undefined}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Processing…" : result?.type === "success" ? "Process Another" : "Process Arrival"}
          </button>
        </div>
      </div>
    </div>
  )
}

function ArriveResultTable({ rows }: { rows: UpdatedRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-cream-border text-left">
          <th className="px-4 py-2 text-xs font-medium text-gray-500 w-10">#</th>
          <th className="px-4 py-2 text-xs font-medium text-gray-500">Customer</th>
          <th className="px-4 py-2 text-xs font-medium text-gray-500 text-right w-20">Unit Arrive</th>
          <th className="px-4 py-2 text-xs font-medium text-gray-500 text-right w-24"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.rowNumber} className="border-b border-cream-border last:border-0">
            <td className="px-4 py-2 text-xs text-gray-400">{i + 1}</td>
            <td className="px-4 py-2 text-foreground">{displayIg(row.customer)}</td>
            <td className="px-4 py-2 text-foreground text-right font-medium">{row.unitArrive}</td>
            <td className="px-4 py-2 text-right">
              {row.oldUnitArrive > 0 && (
                <span className="text-xs text-gray-400">(was {row.oldUnitArrive})</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
