"use client"

import { useMemo, useState } from "react"
import type { ExcessTransitItem } from "@/lib/db"
import { REASON_LABEL, REASON_CLASS } from "@/app/dashboard/excess-purchase/ExcessTable"
import { fmt } from "@/lib/format"
import InfoTooltip from "@/components/InfoTooltip"

type Stage = "dispatch" | "arrive"

// Same shape as buildRows()/RowDescriptor in DispatchListClient/ArrivalListClient — Event
// and Store are real rowspan COLUMNS there, not header bars, so this mirrors that exactly
// rather than the accordion-style header rows used before.
type OverbuyRowDescriptor =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: ExcessTransitItem; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

function buildOverbuyRows(
  grouped: Map<string, Map<string, ExcessTransitItem[]>>,
  collapsedEvents: Set<string>,
  collapsedStores: Set<string>,
): OverbuyRowDescriptor[] {
  const rows: OverbuyRowDescriptor[] = []

  for (const [event, storeMap] of grouped) {
    if (collapsedEvents.has(event)) {
      const totalItems = [...storeMap.values()].reduce((s, arr) => s + arr.length, 0)
      rows.push({ type: "event-collapsed", event, totalItems })
      continue
    }

    let eventRowSpan = 0
    for (const [store, storeItems] of storeMap) {
      eventRowSpan += collapsedStores.has(`${event}|${store}`) ? 1 : storeItems.length
    }

    let firstStoreOfEvent = true
    for (const [store, storeItems] of storeMap) {
      const storeKey = `${event}|${store}`

      if (collapsedStores.has(storeKey)) {
        rows.push({
          type: "store-collapsed",
          event,
          store,
          totalItems: storeItems.length,
          showEvent: firstStoreOfEvent,
          eventRowSpan: firstStoreOfEvent ? eventRowSpan : undefined,
        })
        firstStoreOfEvent = false
        continue
      }

      storeItems.forEach((item, idx) => {
        const showEvent = firstStoreOfEvent && idx === 0
        rows.push({
          type: "item",
          item,
          event,
          store,
          showEvent,
          showStore: idx === 0,
          eventRowSpan: showEvent ? eventRowSpan : undefined,
          storeRowSpan: idx === 0 ? storeItems.length : undefined,
        })
        if (idx === 0) firstStoreOfEvent = false
      })
    }
  }

  return rows
}

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

// Same +/− box as the Customer Order desktop table's collapse control (DispatchListClient/
// ArrivalListClient each keep their own local copy of this too, rather than a shared one).
function CollapseBtn({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center w-4 h-4 rounded border border-gray-300 bg-white text-gray-500 hover:text-brand hover:border-brand transition-colors text-xs font-bold shrink-0"
    >
      {collapsed ? "+" : "−"}
    </button>
  )
}

// Same icon-plus-text-xs, gray-400 weight as the customer badge on the regular (has-a-
// customer) mobile cards — an event has no popup breakdown to show, so this is the plain,
// non-interactive version of that pattern rather than a full CustomerBadge.
function EventBadge({ event }: { event: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-gray-400">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
      <span className="text-xs">{event}</span>
    </span>
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
  // Top-level, mobile only — mirrors the event-level collapse on the regular (has-a-
  // customer) cards. Desktop's table isn't gated on this; only the mobile card list is.
  const [sectionCollapsed, setSectionCollapsed] = useState(false)
  // Store only — unlike the regular (has-a-customer) list, these items aren't worth
  // grouping by event too: overbuy is usually just one or two events' worth at a time,
  // and event is shown per row instead (see EventBadge below).
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  // Desktop table's own event -> store grouping, matching the Customer Order table beside
  // it — separate from `collapsedStores` above, which is mobile's flat store-only grouping
  // and keyed differently (bare store name there, `event|store` here, since the same store
  // name can recur across different events once event is its own level).
  const [collapsedDesktopEvents, setCollapsedDesktopEvents] = useState<Set<string>>(new Set())
  const [collapsedDesktopStores, setCollapsedDesktopStores] = useState<Set<string>>(new Set())

  const grouped = useMemo(() => {
    const byStore = new Map<string, ExcessTransitItem[]>()
    for (const it of items) {
      const key = it.store || "—"
      if (!byStore.has(key)) byStore.set(key, [])
      byStore.get(key)!.push(it)
    }
    return byStore
  }, [items])

  const desktopGrouped = useMemo(() => {
    const byEvent = new Map<string, Map<string, ExcessTransitItem[]>>()
    for (const it of items) {
      if (!byEvent.has(it.event)) byEvent.set(it.event, new Map())
      const byStore = byEvent.get(it.event)!
      const key = it.store || "—"
      if (!byStore.has(key)) byStore.set(key, [])
      byStore.get(key)!.push(it)
    }
    return byEvent
  }, [items])

  const desktopRows = useMemo(
    () => buildOverbuyRows(desktopGrouped, collapsedDesktopEvents, collapsedDesktopStores),
    [desktopGrouped, collapsedDesktopEvents, collapsedDesktopStores],
  )

  function toggleDesktopEvent(event: string) {
    setCollapsedDesktopEvents((prev) => {
      const next = new Set(prev)
      next.has(event) ? next.delete(event) : next.add(event)
      return next
    })
  }
  function toggleDesktopStore(event: string, store: string) {
    const key = `${event}|${store}`
    setCollapsedDesktopStores((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleStore(store: string) {
    setCollapsedStores((prev) => {
      const next = new Set(prev)
      next.has(store) ? next.delete(store) : next.add(store)
      return next
    })
  }

  function toggleSelect(rowNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(rowNumber) ? next.delete(rowNumber) : next.add(rowNumber)
      return next
    })
  }

  if (items.length === 0) return null

  const title = stage === "dispatch" ? "INVENTORY IN TRANSIT" : "INVENTORY AWAITING ARRIVAL"
  const subtitle = stage === "dispatch"
    ? "Bought but not yet dispatched — no customer, tracked separately from ready stock."
    : "Dispatched but not yet arrived — no customer, tracked separately from ready stock."
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"
  const openItem = openRow != null ? items.find((i) => i.rowNumber === openRow) ?? null : null

  // Each selected row goes at its own full pending qty — a bulk action has no room to
  // prompt a partial quantity per row the way the single-row modal does.
  async function handleBulkMark() {
    setBulkSaving(true)
    setBulkError(null)
    try {
      const rows = items.filter((it) => selected.has(it.rowNumber))
      await Promise.all(rows.map((it) =>
        fetch(`/api/sheets/excess-purchase/${it.rowNumber}/${stage}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qty: it.pending }),
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error ?? `Failed to mark ${it.items}`)
          }
        }),
      ))
      setSelected(new Set())
      setBulkOpen(false)
      onMarked()
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Some items failed to save")
    } finally {
      setBulkSaving(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-cream-border bg-white overflow-hidden">
      {/* Same border-l accent + bold text as the event header on the regular (has-a-
          customer) mobile cards — this title is this list's top-level grouping, the same
          role event plays there. Collapsible on mobile too, same as event; the chevron
          and the click target are both md:hidden since desktop's table isn't gated on
          this — pointer-events-none there stops the button from doing anything but
          doesn't change how it looks. */}
      <div className="px-4 py-2.5 border-b border-cream-border border-l-[3px] border-brand bg-gray-50/80 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setSectionCollapsed((c) => !c)}
          className="md:pointer-events-none flex items-center gap-2 min-w-0 text-left"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`md:hidden shrink-0 text-gray-400 transition-transform ${sectionCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
          <span className="font-bold text-sm text-foreground truncate">{title}</span>
        </button>
        <InfoTooltip text={subtitle} />
        {/* Opens a review popup rather than acting straight from a bar — this list sits
            inside a page that already has its own floating SelectionActionBar for its
            regular (has-a-customer) rows, and a second bar here read as a duplicate of
            that one. */}
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            className="md:hidden ml-auto shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
          >
            {actionLabel} ({selected.size})
          </button>
        )}
      </div>
      <div className="hidden md:block overflow-x-auto">
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
            {/* Event and Store as real rowspan columns, exactly like the Customer Order
                table beside this one — not header bars. */}
            {desktopRows.map((row) => {
              if (row.type === "event-collapsed") {
                return (
                  <tr key={`${row.event}~collapsed`} className="border-b border-cream-border">
                    <td colSpan={6} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} item{row.totalItems > 1 ? "s" : ""}</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              if (row.type === "store-collapsed") {
                return (
                  <tr key={`${row.event}|${row.store}~collapsed`} className="border-b border-cream-border">
                    {row.showEvent && (
                      <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                        <div className="flex items-center gap-2 pt-0.5">
                          <CollapseBtn collapsed={false} onClick={() => toggleDesktopEvent(row.event)} />
                          <span className="font-medium text-foreground">{row.event}</span>
                        </div>
                      </td>
                    )}
                    <td colSpan={5} className="px-4 py-2.5 bg-gray-50/40">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} item{row.totalItems > 1 ? "s" : ""}</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              const it = row.item
              return (
                <tr key={it.rowNumber} className="border-b border-cream-border last:border-0 hover:bg-gray-50/50 transition-colors">
                  {row.showEvent && (
                    <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleDesktopEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                      </div>
                    </td>
                  )}
                  {row.showStore && (
                    <td rowSpan={row.storeRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleDesktopStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                      </div>
                    </td>
                  )}
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
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: same collapsible-group card pattern as the regular (has-a-customer)
          list, grouped by store only — instead of the desktop table's horizontal
          scroll. */}
      {!sectionCollapsed && (
      <div className="md:hidden flex flex-col">
        {[...grouped.entries()].map(([store, storeItems]) => {
          const storeCollapsed = collapsedStores.has(store)
          return (
            <div key={store} className="border-t border-cream-border first:border-t-0">
              {/* Same nested-level styling as the store sub-header on the regular
                  (has-a-customer) mobile cards: lighter background, smaller/gray text,
                  smaller chevron — this is the second-level group here too. */}
              <button type="button" onClick={() => toggleStore(store)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-50/60 text-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${storeCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                <span className="text-xs font-bold text-gray-600">{store}</span>
                <span className="ml-auto text-[11px] text-gray-400">{storeItems.length}</span>
              </button>
              {!storeCollapsed && storeItems.map((it) => (
                <div key={it.rowNumber} className="flex items-center gap-3 px-4 py-2.5 border-t border-cream-border">
                  <input
                    type="checkbox"
                    checked={selected.has(it.rowNumber)}
                    onChange={() => toggleSelect(it.rowNumber)}
                    className="w-5 h-5 shrink-0 accent-brand"
                    aria-label={`Select ${it.items}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground">{it.items}</div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <EventBadge event={it.event} />
                      <span className="text-xs text-gray-400">·</span>
                      <span className="text-xs text-gray-400 uppercase">{REASON_LABEL[it.reason]}</span>
                    </div>
                  </div>
                  <div className="text-sm font-bold tabular-nums whitespace-nowrap text-foreground">{fmt(it.pending)}</div>
                  <button
                    type="button"
                    onClick={() => setOpenRow(it.rowNumber)}
                    aria-label={actionLabel}
                    className="w-9 h-9 rounded-lg border border-cream-border text-brand flex items-center justify-center shrink-0 active:bg-green-50 active:text-green-700 active:border-green-200"
                  >
                    <StageIcon stage={stage} />
                  </button>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      )}
      {openItem && (
        <MarkStageModal
          item={openItem}
          stage={stage}
          onClose={() => setOpenRow(null)}
          onSuccess={() => { setOpenRow(null); onMarked() }}
        />
      )}
      {bulkOpen && (
        <BulkMarkModal
          items={items.filter((it) => selected.has(it.rowNumber))}
          stage={stage}
          saving={bulkSaving}
          error={bulkError}
          onClose={() => setBulkOpen(false)}
          onConfirm={handleBulkMark}
        />
      )}
    </div>
  )
}

// Lists each selected item with ITS OWN pending qty — the whole point of the popup over
// the bar it replaced is to make that qty unambiguous before confirming: an overbuy row
// and a regular (has-a-customer) order can share a product name but track completely
// separate stock, so this only ever reads `pending` off the ExcessTransitItem itself,
// never anything from the other list.
function BulkMarkModal({
  items,
  stage,
  saving,
  error,
  onClose,
  onConfirm,
}: {
  items: ExcessTransitItem[]
  stage: Stage
  saving: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const actionLabel = stage === "dispatch" ? "Mark dispatched" : "Mark arrived"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-foreground">{actionLabel} — {items.length} item{items.length > 1 ? "s" : ""}</div>
        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
          {items.map((it) => (
            <div key={it.rowNumber} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <div className="text-foreground truncate">{it.items}</div>
                <div className="text-xs text-gray-400">{it.event} · {it.store || "—"}</div>
              </div>
              <span className="font-bold tabular-nums text-foreground shrink-0">{fmt(it.pending)}</span>
            </div>
          ))}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={saving} className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">
            {saving ? "Saving…" : actionLabel}
          </button>
        </div>
      </div>
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
