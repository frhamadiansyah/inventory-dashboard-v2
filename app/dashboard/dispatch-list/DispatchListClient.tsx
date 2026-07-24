"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PaidStatus, DispatchListItem, DispatchListOrder } from "@/lib/db"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { allocateFifo } from "@/lib/fifo-fill"
import { fetchJson } from "@/lib/api-fetch"
import DispatchModal from "./DispatchModal"
import EventSelect from "@/components/EventSelect"
import SearchInput from "@/components/SearchInput"
import SelectionActionBar from "@/components/SelectionActionBar"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

function computeFill(orders: DispatchListOrder[], quantityDispatched: number) {
  const { allocations, unallocated, excess } = allocateFifo(orders, (o) => o.pending, quantityDispatched)
  return {
    filled: allocations.map(({ item, allocated }) => ({ order: item, allocated })),
    unfilled: unallocated,
    excessUnits: excess,
  }
}

// ─── Grouping helpers ───────────────────────────────────────────────────────

function groupItems(items: DispatchListItem[]) {
  const map = new Map<string, Map<string, DispatchListItem[]>>()
  for (const item of items) {
    if (!map.has(item.event)) map.set(item.event, new Map())
    const storeMap = map.get(item.event)!
    const key = item.store || "—"
    if (!storeMap.has(key)) storeMap.set(key, [])
    storeMap.get(key)!.push(item)
  }
  return map
}

/** Stable selection key: event + productId (productId repeats across events). */
function selKey(item: Pick<DispatchListItem, "event" | "productId">): string {
  return `${item.event}|${item.productId}`
}

type RowDescriptor =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: DispatchListItem; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

function buildRows(
  grouped: Map<string, Map<string, DispatchListItem[]>>,
  collapsedEvents: Set<string>,
  collapsedStores: Set<string>,
): RowDescriptor[] {
  const rows: RowDescriptor[] = []

  for (const [event, storeMap] of grouped) {
    if (collapsedEvents.has(event)) {
      const totalItems = [...storeMap.values()].reduce((s, arr) => s + arr.length, 0)
      rows.push({ type: "event-collapsed", event, totalItems })
      continue
    }

    // Event rowspan = sum of visible rows per store
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

function CollapseBtn({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center w-4 h-4 rounded border border-gray-300 bg-white text-gray-500 hover:text-brand hover:border-brand transition-colors text-xs font-bold shrink-0"
    >
      {collapsed ? "+" : "−"}
    </button>
  )
}

type CustomerBadgeOrder = { customer: string; qty: number; paidStatus: PaidStatus }

const PAID_DOT: Record<PaidStatus, string> = {
  paid:    "bg-green-500",
  partial: "bg-yellow-400",
  unpaid:  "bg-gray-300",
}
const PAID_LABEL: Record<PaidStatus, string> = {
  paid:    "Paid",
  partial: "Partial",
  unpaid:  "Unpaid",
}

function CustomerBadge({ orders }: { orders: CustomerBadgeOrder[] }) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
    // Orders sharing a customer also share an (event, customer) pair, so they
    // all carry the same paidStatus — keep the first one we see.
    const map = new Map<string, { qty: number; paidStatus: PaidStatus }>()
    for (const o of orders) {
      const prev = map.get(o.customer)
      map.set(o.customer, {
        qty: (prev?.qty ?? 0) + o.qty,
        paidStatus: prev?.paidStatus ?? o.paidStatus,
      })
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([customer, v]) => ({ customer, qty: v.qty, paidStatus: v.paidStatus }))
  }, [orders])

  const paidCount = entries.filter((e) => e.paidStatus === "paid").length
  const totalCount = entries.length
  const allPaid = totalCount > 0 && paidCount === totalCount

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    function onScroll(e: Event) {
      // Ignore scrolls inside the popup itself
      if (popupRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("scroll", onScroll, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("scroll", onScroll, true)
    }
  }, [open])

  function handleToggle() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const POPUP_HEIGHT = 260
      const spaceBelow = window.innerHeight - rect.bottom
      const flipUp = spaceBelow < POPUP_HEIGHT && rect.top > POPUP_HEIGHT
      setPopupStyle({
        position: "fixed",
        top: flipUp ? rect.top - POPUP_HEIGHT - 4 : rect.bottom + 4,
        left: rect.left,
        minWidth: 200,
      })
    }
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        title={allPaid ? "All customers paid" : `${paidCount} of ${totalCount} paid`}
        className="inline-flex items-baseline gap-1 text-gray-400 hover:text-brand transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="self-center">
          <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
        <span className="text-xs tabular-nums">{totalCount}</span>
        {allPaid ? (
          <span className="text-xs text-green-600"> · all paid</span>
        ) : paidCount > 0 ? (
          <span className="text-xs">
            {" · "}
            <span className="text-green-600 font-medium">{paidCount}</span>
            {" paid"}
          </span>
        ) : null}
      </button>
      {open && (
        <div
          ref={popupRef}
          style={popupStyle}
          className="z-50 max-h-64 overflow-y-auto rounded-lg border border-cream-border bg-white shadow-lg py-1"
        >
          {entries.map((e) => (
            <div
              key={e.customer}
              className="flex items-center justify-between gap-3 px-3 py-1 text-xs hover:bg-gray-50 whitespace-nowrap"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={`inline-block w-2 h-2 rounded-full shrink-0 ${PAID_DOT[e.paidStatus]}`}
                  title={PAID_LABEL[e.paidStatus]}
                  aria-label={PAID_LABEL[e.paidStatus]}
                />
                <span className="text-foreground truncate">{displayIg(e.customer)}</span>
              </span>
              <span className="text-gray-500 tabular-nums shrink-0">{e.qty}×</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function DispatchListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<DispatchListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  const [dispatchingItem, setDispatchingItem] = useState<DispatchListItem | null>(null)
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(new Set())
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())
  // Multi-select for marking several items dispatched under one shared tracking ref.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)

  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/dispatch?event=${encodeURIComponent(event)}`
      : "/api/sheets/dispatch"
    fetchJson<{ items: DispatchListItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        // Stores start collapsed (event headers + store headers visible, items
        // hidden). Only on an explicit load — a silent post-mutation refresh
        // leaves whatever the user has expanded alone.
        if (!silent) {
          setCollapsedStores(new Set(items.map((i) => `${i.event}|${i.store || "—"}`)))
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => { if (!silent) setLoading(false) })
  }, [])

  useEffect(() => {
    fetchItems(selectedEvent || undefined)
  }, [fetchItems, selectedEvent])

  // Partial fills change multiple orders' pending qty in non-trivial ways.
  // Refetching is simpler and more correct than incremental local state updates.
  // Silent so the open modal isn't unmounted by the TableSkeleton fallback.
  function handleDispatchedSuccess() {
    fetchItems(selectedEvent || undefined, true)
  }

  // Resolve selected keys back to live items (off `items`, not `filteredItems`,
  // so a search-hidden selection still submits). Drops anything no longer pending.
  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(selKey(i))),
    [items, selected],
  )

  function toggleSelect(item: DispatchListItem) {
    setSelected((prev) => {
      const next = new Set(prev)
      const k = selKey(item)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  function clearSelection() { setSelected(new Set()) }

  function toggleEvent(event: string) {
    setCollapsedEvents((prev) => {
      const next = new Set(prev)
      next.has(event) ? next.delete(event) : next.add(event)
      return next
    })
  }

  function toggleStore(event: string, store: string) {
    const key = `${event}|${store}`
    setCollapsedStores((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter(
      (i) =>
        i.productName.toLowerCase().includes(q) ||
        i.event.toLowerCase().includes(q) ||
        (i.store ?? "").toLowerCase().includes(q),
    )
  }, [items, search])

  const grouped = useMemo(() => groupItems(filteredItems), [filteredItems])
  const rows = useMemo(
    () => buildRows(grouped, collapsedEvents, collapsedStores),
    [grouped, collapsedEvents, collapsedStores],
  )

  // Select-all over the currently-visible (search-filtered) items.
  const allSelected = filteredItems.length > 0 && filteredItems.every((i) => selected.has(selKey(i)))
  const toggleSelectAll = () => setSelected(() => (allSelected ? new Set() : new Set(filteredItems.map(selKey))))

  if (loading) return <TableSkeleton />

  if (error) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{error}</span>
        <button
          onClick={() => fetchItems(selectedEvent || undefined)}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 transition-colors shrink-0"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search dispatch list…"
          className="flex-1 min-w-0 sm:min-w-[180px]"
        />
        <div className="w-40 shrink-0 sm:w-[12rem]">
          <EventSelect
            value={selectedEvent}
            onChange={(v) => { setSelectedEvent(v); clearSelection() }}
            events={options?.events ?? []}
            placeholder="All Events"
            clearable
          />
        </div>
        {/* Select-all toggle, right of the event filter (both layouts). */}
        <button
          type="button"
          onClick={toggleSelectAll}
          aria-label={allSelected ? "Deselect all" : "Select all"}
          title={allSelected ? "Deselect all" : "Select all"}
          className="inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-cream-border h-[38px] px-3 text-sm text-gray-600 bg-white hover:border-brand transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          {allSelected && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
        </button>
        <button
          onClick={() => setDispatchModalOpen(true)}
          className="hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Bulk Dispatch
        </button>
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setDispatchModalOpen(true)}
        aria-label="Add bulk dispatch"
        className="md:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Grouped table (desktop) */}
      <div className="hidden md:block rounded-xl border border-cream-border bg-white overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-cream-border bg-gray-50/80">
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-44">Event</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500 w-36">Store</th>
              <th className="text-left px-4 py-2.5 font-medium text-gray-500">Product</th>
              <th className="text-right px-4 py-2.5 font-medium text-gray-500 w-14">Qty</th>
              <th className="px-4 py-2.5 w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-gray-400 py-12 text-sm">
                  No items
                </td>
              </tr>
            )}
            {rows.map((row) => {
              if (row.type === "event-collapsed") {
                return (
                  <tr key={`${row.event}~collapsed`} className="border-b border-cream-border">
                    <td colSpan={5} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} items</span>
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
                          <CollapseBtn collapsed={false} onClick={() => toggleEvent(row.event)} />
                          <span className="font-medium text-foreground">{row.event}</span>
                        </div>
                      </td>
                    )}
                    <td colSpan={4} className="px-4 py-2.5 bg-gray-50/40">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                        <span className="text-xs text-gray-400">{row.totalItems} items</span>
                      </div>
                    </td>
                  </tr>
                )
              }

              return (
                <tr
                  key={`${row.event}|${row.store}|${row.item.productId}`}
                  className="border-b border-cream-border hover:bg-gray-50/50 transition-colors"
                >
                  {row.showEvent && (
                    <td rowSpan={row.eventRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleEvent(row.event)} />
                        <span className="font-medium text-foreground">{row.event}</span>
                      </div>
                    </td>
                  )}
                  {row.showStore && (
                    <td rowSpan={row.storeRowSpan} className="px-4 py-2.5 align-top border-r border-cream-border">
                      <div className="flex items-center gap-2 pt-0.5">
                        <CollapseBtn collapsed={false} onClick={() => toggleStore(row.event, row.store)} />
                        <span className="text-gray-600">{row.store}</span>
                      </div>
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {row.item.totalUnits > 0 && (
                        <input
                          type="checkbox"
                          checked={selected.has(selKey(row.item))}
                          onChange={() => toggleSelect(row.item)}
                          className="w-4 h-4 shrink-0 accent-brand cursor-pointer"
                          aria-label={`Select ${row.item.productName}`}
                        />
                      )}
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="text-foreground">{row.item.productName}</span>
                        <CustomerBadge
                          orders={row.item.orders.map((o) => ({
                            customer: o.customer,
                            qty: o.pending,
                            paidStatus: o.paidStatus,
                          }))}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="tabular-nums font-bold text-foreground">{row.item.totalUnits}</span>
                    {row.item.totalUnits < row.item.totalOriginal && (
                      <span className="text-xs text-gray-400 font-normal tabular-nums" title="Partially dispatched">
                        {" "}/ {row.item.totalOriginal}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setDispatchingItem(row.item)}
                      title="Mark dispatched"
                      className="text-gray-400 hover:text-green-600 transition-colors"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                      </svg>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Grouped cards (mobile) */}
      <div className="md:hidden flex flex-col gap-2.5">
        {grouped.size === 0 && (
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">No items</div>
        )}
        {[...grouped.entries()].map(([event, storeMap]) => {
          const allItems = [...storeMap.values()].flat()
          const eventCollapsed = collapsedEvents.has(event)
          return (
            <div key={event} className="rounded-xl border border-cream-border bg-white overflow-hidden">
              <button type="button" onClick={() => toggleEvent(event)} className="w-full flex items-center gap-2.5 px-4 py-3 border-l-[3px] border-brand text-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${eventCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                <span className="font-bold text-sm text-foreground">{event}</span>
                <span className="ml-auto text-xs text-gray-400">{allItems.length} items</span>
              </button>
              {!eventCollapsed && [...storeMap.entries()].map(([store, storeItems]) => {
                const storeKey = `${event}|${store}`
                const storeCollapsed = collapsedStores.has(storeKey)
                return (
                  <div key={storeKey}>
                    <button type="button" onClick={() => toggleStore(event, store)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-gray-50/60 border-t border-cream-border text-left">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-gray-400 transition-transform ${storeCollapsed ? "-rotate-90" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                      <span className="text-xs font-bold text-gray-600">{store}</span>
                      <span className="ml-auto text-[11px] text-gray-400">{storeItems.length}</span>
                    </button>
                    {!storeCollapsed && storeItems.map((item) => (
                        <div key={item.productId} className="flex items-center gap-3 px-4 py-2.5 border-t border-cream-border">
                          {/* Checkbox gated on remaining > 0, mirroring desktop. */}
                          {item.totalUnits > 0 && (
                            <input
                              type="checkbox"
                              checked={selected.has(selKey(item))}
                              onChange={() => toggleSelect(item)}
                              className="w-5 h-5 shrink-0 accent-brand"
                              aria-label={`Select ${item.productName}`}
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-foreground">{item.productName}</div>
                            {/* Same badge as desktop — tap to see who ordered. */}
                            <div className="mt-0.5">
                              <CustomerBadge
                                orders={item.orders.map((o) => ({
                                  customer: o.customer,
                                  qty: o.pending,
                                  paidStatus: o.paidStatus,
                                }))}
                              />
                            </div>
                          </div>
                          {/* Match desktop: bold = remaining to dispatch, faded "/ total" only when partially dispatched. */}
                          <div className="text-sm font-bold tabular-nums whitespace-nowrap text-foreground">
                            {item.totalUnits}
                            {item.totalUnits < item.totalOriginal && (
                              <span className="text-xs text-gray-400 font-normal" title="Partially dispatched"> / {item.totalOriginal}</span>
                            )}
                          </div>
                          <button type="button" onClick={() => setDispatchingItem(item)} aria-label="Mark dispatched" className="w-9 h-9 rounded-lg border border-cream-border text-brand flex items-center justify-center shrink-0 active:bg-green-50 active:text-green-700 active:border-green-200"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></svg></button>
                        </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {dispatchingItem && (
        <DispatchItemModal
          item={dispatchingItem}
          onClose={() => setDispatchingItem(null)}
          onSuccess={() => {
            handleDispatchedSuccess()
            setDispatchingItem(null)
          }}
        />
      )}

      {dispatchModalOpen && (
        <DispatchModal
          onClose={() => setDispatchModalOpen(false)}
          onProcessed={handleDispatchedSuccess}
        />
      )}

      {/* Multi-select action bar */}
      {selected.size > 0 && (
        <SelectionActionBar
          reserveFab
          count={selected.size}
          onClear={clearSelection}
          actions={[
            {
              label: "Dispatched",
              color: "green",
              onClick: () => setConfirmOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ),
            },
          ]}
        />
      )}

      {confirmOpen && (
        <ConfirmDispatchPanel
          items={selectedItems}
          onClose={() => setConfirmOpen(false)}
          onSuccess={() => { clearSelection(); setConfirmOpen(false); handleDispatchedSuccess() }}
          onPartial={(succeeded) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const key of prev) {
                const ev = key.slice(0, key.lastIndexOf("|"))
                if (succeeded.includes(ev)) next.delete(key)
              }
              return next
            })
            handleDispatchedSuccess()
          }}
        />
      )}
    </>
  )
}

// ─── Confirm multi-dispatch panel ───────────────────────────────────────────

function ConfirmDispatchPanel({
  items,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: DispatchListItem[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededEvents: string[]) => void
}) {
  // Qty per selected item, defaulting to its pending units. Keyed by selKey.
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalUnits)
    return m
  })
  const [tracking, setTracking] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // /api/sheets/dispatch is per-event, so group the selection by event.
  const byEvent = useMemo(() => {
    const m = new Map<string, DispatchListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const anyQty = items.some((it) => (Number(qtys[selKey(it)]) || 0) > 0)
  // Title counts units to be dispatched (sum of the adjustable qtys), not the
  // number of product lines — "2 products × 5+4 units" reads as "9 items".
  const totalQty = items.reduce((s, it) => s + (Number(qtys[selKey(it)]) || 0), 0)

  async function handleSubmit() {
    if (!anyQty || submitting) return
    setSubmitting(true)
    setErrors([])

    const payloads = [...byEvent.entries()]
      .map(([event, evItems]) => ({
        event,
        items: evItems
          .map((it) => ({ item: it.productName, qty: Number(qtys[selKey(it)]) || 0 }))
          .filter((l) => l.qty > 0),
      }))
      .filter((p) => p.items.length > 0)

    const settled = await Promise.allSettled(
      payloads.map((p) =>
        fetch("/api/sheets/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: p.event, items: p.items, receipt: tracking.trim() }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${p.event}`)
          return p.event
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(payloads[i].event)
      else failed.push(`${payloads[i].event}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
    })

    setSubmitting(false)
    if (failed.length === 0) {
      onSuccess()
    } else {
      setErrors(failed)
      if (succeeded.length > 0) onPartial(succeeded)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">
            Mark {totalQty} item{totalQty === 1 ? "" : "s"} dispatched
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">Adjust quantities if needed, then add one dispatch tracking ref for all of them.</p>
        </div>

        <div className="px-5 py-4 overflow-y-auto min-h-0 flex flex-col gap-4">
          {[...byEvent.entries()].map(([event, evItems]) => (
            <div key={event} className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-gray-500">{event}</div>
              {evItems.map((it) => {
                const k = selKey(it)
                return (
                  <div key={k} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-foreground break-words">{it.productName}</div>
                      {it.store && <div className="text-[11px] text-gray-400">{it.store}</div>}
                    </div>
                    <input
                      type="number"
                      min="1"
                      value={qtys[k] ?? ""}
                      onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                      className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                    />
                    <span className="text-[11px] text-gray-400 w-14 shrink-0">/ {it.totalUnits} left</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-500">Dispatch tracking (optional)</span>
            <input
              type="text"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="e.g. TRK-001"
              className={INPUT_CLASS}
            />
          </label>
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some events failed (others were recorded):</div>
              <ul className="list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !anyQty}
              className="px-4 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Mark dispatched"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Dispatch item modal (single product, per-row action) ──────────────────

function DispatchItemModal({
  item,
  onClose,
  onSuccess,
}: {
  item: DispatchListItem
  onClose: () => void
  onSuccess: () => void
}) {
  const [qty, setQty] = useState(String(item.totalUnits))
  const [tracking, setTracking] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const quantity = Math.max(0, Number(qty) || 0)
  // Fills highest-priority customers first (item.orders is already paid →
  // partial → unpaid). Matches the server-side allocation in /api/sheets/dispatch.
  const preview = computeFill(item.orders, quantity)

  async function handleSubmit() {
    if (quantity < 1) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/sheets/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: item.event,
          items: [{ item: item.productName, qty: quantity }],
          receipt: tracking.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to mark as dispatched")
      onSuccess()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to mark as dispatched")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-5 p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-foreground">{item.productName}</div>
            <div className="text-xs text-gray-400 mt-0.5">
              {item.event}{item.store ? ` · ${item.store}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-brand transition-colors shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Qty + Dispatch tracking inputs */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-500">
              Units to dispatch <span className="text-gray-400">(remaining: {item.totalUnits})</span>
            </label>
            <input
              type="number"
              min="1"
              max={item.totalUnits}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
              autoFocus
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-500">
              Dispatch tracking <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
              placeholder="e.g. TRK-001"
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          </div>
        </div>

        {/* Live preview */}
        {quantity > 0 && (
          <div className="flex flex-col gap-2 text-xs">
            {preview.filled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Will dispatch ({preview.filled.reduce((s, f) => s + f.allocated, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.filled.map((f) => (
                    <div key={f.order.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-green-50">
                      <span className="text-green-800 truncate">{displayIg(f.order.customer)}</span>
                      <span className="text-green-700 font-medium ml-2 shrink-0 tabular-nums">
                        {f.allocated}×
                        {f.allocated < f.order.pending && (
                          <span className="text-green-600/70 font-normal"> of {f.order.pending}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {preview.unfilled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Stays in list ({preview.unfilled.reduce((s, o) => s + o.pending, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.unfilled.map((o) => (
                    <div key={o.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-gray-50">
                      <span className="text-gray-500 truncate">{displayIg(o.customer)}</span>
                      <span className="text-gray-400 font-medium ml-2 shrink-0 tabular-nums">{o.pending}×</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2">
          {saveError && <p className="text-xs text-red-500 mr-auto">{saveError}</p>}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || quantity < 1}
            className="px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors bg-green-600 hover:bg-green-700"
          >
            {saving ? "Saving…" : "Mark dispatched"}
          </button>
        </div>
      </div>
    </div>
  )
}
