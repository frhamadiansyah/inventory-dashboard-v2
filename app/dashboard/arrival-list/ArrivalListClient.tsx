"use client"

import { displayIg, fmt } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ArrivalListItem, ArrivalListOrder, ExcessTransitItem } from "@/lib/db"
import type { PaidStatus } from "@/lib/db/shopping-list"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { allocateFifo } from "@/lib/fifo-fill"
import { fetchJson } from "@/lib/api-fetch"
import ArriveBulkModal from "./ArriveBulkModal"
import EventSelect from "@/components/EventSelect"
import SearchableSelect from "@/components/SearchableSelect"
import SearchInput from "@/components/SearchInput"
import SelectionActionBar from "@/components/SelectionActionBar"
import OverbuyTransitList from "@/components/OverbuyTransitList"

function computeFill(orders: ArrivalListOrder[], quantityArrived: number) {
  const { allocations, unallocated, excess } = allocateFifo(orders, (o) => o.pending, quantityArrived)
  return {
    filled: allocations.map(({ item, allocated }) => ({ order: item, allocated })),
    unfilled: unallocated,
    unassignedUnits: excess,
  }
}

// ─── Grouping helpers ───────────────────────────────────────────────────────

function groupItems(items: ArrivalListItem[]) {
  const map = new Map<string, Map<string, ArrivalListItem[]>>()
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
function selKey(item: Pick<ArrivalListItem, "event" | "productId">): string {
  return `${item.event}|${item.productId}`
}

type RowDescriptor =
  | { type: "event-collapsed"; event: string; totalItems: number }
  | { type: "store-collapsed"; event: string; store: string; totalItems: number; showEvent: boolean; eventRowSpan?: number }
  | { type: "item"; item: ArrivalListItem; event: string; store: string; showEvent: boolean; showStore: boolean; eventRowSpan?: number; storeRowSpan?: number }

function buildRows(
  grouped: Map<string, Map<string, ArrivalListItem[]>>,
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

function CustomerBadge({ orders }: { orders: { customer: string; qty: number; paidStatus: PaidStatus }[] }) {
  const [open, setOpen] = useState(false)
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
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

export default function ArrivalListClient() {
  const options = useSheetOptions()
  const [items, setItems] = useState<ArrivalListItem[]>([])
  const [excessPending, setExcessPending] = useState<ExcessTransitItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [selectedEvent, setSelectedEvent] = useState("")
  const [search, setSearch] = useState("")
  const [arrivingItem, setArrivingItem] = useState<ArrivalListItem | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [collapsedEvents, setCollapsedEvents] = useState<Set<string>>(new Set())
  const [collapsedStores, setCollapsedStores] = useState<Set<string>>(new Set())
  // Desktop's own collapse state — separate from the mobile cards' above, which start
  // every store collapsed. Desktop stays fully expanded by default (never seeded), since
  // a spreadsheet-style table reads better open than the phone card list does.
  const [collapsedDesktopEvents, setCollapsedDesktopEvents] = useState<Set<string>>(new Set())
  const [collapsedDesktopStores, setCollapsedDesktopStores] = useState<Set<string>>(new Set())
  // Multi-select for marking several items received.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [notReceivedOpen, setNotReceivedOpen] = useState(false)

  const fetchItems = useCallback((event?: string, silent = false) => {
    if (!silent) setLoading(true)
    setError("")
    const url = event
      ? `/api/sheets/arrival-list?event=${encodeURIComponent(event)}`
      : "/api/sheets/arrival-list"
    fetchJson<{ items: ArrivalListItem[]; excessPending?: ExcessTransitItem[] }>(url)
      .then((data) => {
        const items = data.items ?? []
        setItems(items)
        setExcessPending(data.excessPending ?? [])
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
  function handleArrivedSuccess() {
    fetchItems(selectedEvent || undefined, true)
  }

  // Resolve selected keys back to live items (off `items`, not `filteredItems`,
  // so a search-hidden selection still appears in the document). Drops anything
  // no longer pending after a refresh.
  const selectedItems = useMemo(
    () => items.filter((i) => selected.has(selKey(i))),
    [items, selected],
  )

  function toggleSelect(item: ArrivalListItem) {
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
  // Desktop-only state (see above) — mobile's own render loop reads collapsedEvents/
  // collapsedStores directly, not through `rows`.
  const rows = useMemo(
    () => buildRows(grouped, collapsedDesktopEvents, collapsedDesktopStores),
    [grouped, collapsedDesktopEvents, collapsedDesktopStores],
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
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search receiving list…"
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
          onClick={() => setBulkOpen(true)}
          className="hidden md:inline-flex items-center gap-1.5 h-[38px] px-3 text-sm font-medium rounded-lg bg-brand text-white hover:bg-brand-hover transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Bulk Arrival
        </button>
      </div>

      {/* Mobile add FAB */}
      <button
        type="button"
        onClick={() => setBulkOpen(true)}
        aria-label="Add bulk arrival"
        className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white text-3xl leading-none shadow-lg flex items-center justify-center active:bg-brand/90"
      >
        +
      </button>

      {/* Grouped table (desktop) */}
      <div className="hidden md:block rounded-xl border border-cream-border bg-white overflow-hidden">
        {/* Same title-bar style as OverbuyTransitList's "INVENTORY AWAITING ARRIVAL"
            below, so the two sections read as one matched pair. */}
        <div className="px-4 py-2.5 border-b border-cream-border border-l-[3px] border-brand bg-gray-50/80">
          <div className="font-bold text-sm text-foreground">CUSTOMER ORDER</div>
        </div>
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
                  No items pending arrival
                </td>
              </tr>
            )}
            {rows.map((row) => {
              if (row.type === "event-collapsed") {
                return (
                  <tr key={`${row.event}~collapsed`} className="border-b border-cream-border">
                    <td colSpan={5} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopEvent(row.event)} />
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
                          <CollapseBtn collapsed={false} onClick={() => toggleDesktopEvent(row.event)} />
                          <span className="font-medium text-foreground">{row.event}</span>
                        </div>
                      </td>
                    )}
                    <td colSpan={4} className="px-4 py-2.5 bg-gray-50/40">
                      <div className="flex items-center gap-2">
                        <CollapseBtn collapsed onClick={() => toggleDesktopStore(row.event, row.store)} />
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
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {row.item.totalPending > 0 && (
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
                          orders={row.item.orders.map((o) => ({ customer: o.customer, qty: o.pending, paidStatus: o.paidStatus }))}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <span className="tabular-nums font-bold text-foreground">{row.item.totalPending}</span>
                    {row.item.totalPending < row.item.totalBought && (
                      <span className="text-gray-400 font-normal tabular-nums" title="Partially arrived">
                        {" "}/ {row.item.totalBought}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => setArrivingItem(row.item)}
                      title="Mark as arrived"
                      className="text-gray-400 hover:text-blue-600 transition-colors"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                        <line x1="12" y1="22.08" x2="12" y2="12" />
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
          <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-sm text-gray-400">No items pending arrival</div>
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
                        {item.totalPending > 0 && (
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
                          <div className="mt-0.5">
                            <CustomerBadge
                              orders={item.orders.map((o) => ({ customer: o.customer, qty: o.pending, paidStatus: o.paidStatus }))}
                            />
                          </div>
                        </div>
                        <div className="text-sm font-bold tabular-nums whitespace-nowrap text-foreground">
                          {item.totalPending}
                          {item.totalPending < item.totalBought && (
                            <span className="text-gray-400 font-normal" title="Partially arrived"> / {item.totalBought}</span>
                          )}
                        </div>
                        <button type="button" onClick={() => setArrivingItem(item)} aria-label="Mark as arrived" className="w-9 h-9 rounded-lg border border-cream-border text-brand flex items-center justify-center shrink-0 active:bg-blue-50 active:text-blue-700 active:border-blue-200">
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                            <line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <OverbuyTransitList
        items={excessPending}
        stage="arrive"
        onMarked={() => fetchItems(selectedEvent || undefined, true)}
      />

      {arrivingItem && (
        <ArriveModal
          item={arrivingItem}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
          onClose={() => setArrivingItem(null)}
          onSuccess={() => {
            handleArrivedSuccess()
            setArrivingItem(null)
          }}
        />
      )}

      {bulkOpen && (
        <ArriveBulkModal
          onClose={() => setBulkOpen(false)}
          onProcessed={handleArrivedSuccess}
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
              label: "Received",
              color: "blue",
              onClick: () => setReceiveOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                  <path d="m3.3 7 8.7 5 8.7-5" />
                  <path d="M12 22V12" />
                </svg>
              ),
            },
            {
              label: "Not Received",
              color: "amber",
              onClick: () => setNotReceivedOpen(true),
              icon: (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              ),
            },
          ]}
        />
      )}

      {receiveOpen && (
        <ConfirmReceivePanel
          items={selectedItems}
          onClose={() => setReceiveOpen(false)}
          onSuccess={() => { clearSelection(); setReceiveOpen(false); handleArrivedSuccess() }}
          onPartial={(succeededKeys) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const k of succeededKeys) next.delete(k)
              return next
            })
            handleArrivedSuccess()
          }}
        />
      )}

      {notReceivedOpen && (
        <NotReceivedPanel
          items={selectedItems}
          itemOptions={(options?.items ?? []).map((it) => ({ value: it.name, label: it.name, meta: `Rp ${fmt(it.price)}` }))}
          onClose={() => setNotReceivedOpen(false)}
          onSuccess={() => { clearSelection(); setNotReceivedOpen(false); handleArrivedSuccess() }}
          onPartial={(succeededKeys) => {
            setSelected((prev) => {
              const next = new Set(prev)
              for (const k of succeededKeys) next.delete(k)
              return next
            })
            handleArrivedSuccess()
          }}
        />
      )}
    </>
  )
}

// ─── Confirm multi-receive panel ─────────────────────────────────────────────

function ConfirmReceivePanel({
  items,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: ArrivalListItem[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededKeys: string[]) => void
}) {
  // Qty per selected item, defaulting to its pending units. Keyed by selKey.
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  // Group by event for display, mirroring the shopping list's purchase panel.
  const byEvent = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const totalQty = items.reduce((s, it) => s + (Number(qtys[selKey(it)]) || 0), 0)
  const anyQty = totalQty > 0

  async function handleSubmit() {
    if (!anyQty || submitting) return
    setSubmitting(true)
    setErrors([])

    // The arrival API is per-product, so fire one request per selected item.
    const targets = items
      .map((it) => ({
        key: selKey(it),
        event: it.event,
        productId: it.productId,
        name: it.productName,
        qty: Number(qtys[selKey(it)]) || 0,
      }))
      .filter((t) => t.qty > 0)

    const settled = await Promise.allSettled(
      targets.map((t) =>
        fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: t.event, productId: t.productId, quantityArrived: t.qty }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${t.name}`)
          return t.key
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(targets[i].key)
      else failed.push(`${targets[i].name}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
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
            Mark {totalQty} item{totalQty === 1 ? "" : "s"} received
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">Adjust quantities if needed. Units are assigned to waiting customers, highest-priority first.</p>
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
                    <span className="text-[11px] text-gray-400 w-16 shrink-0">/ {it.totalPending} pending</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some items failed (others were recorded):</div>
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
              className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Mark received"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Arrive Modal ──────────────────────────────────────────────────────────

function ArriveModal({
  item,
  itemOptions,
  onClose,
  onSuccess,
}: {
  item: ArrivalListItem
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [qty, setQty] = useState(String(item.totalPending))
  // "arrive" = normal receipt; "wrong" = different SKU sent; "broken" = arrived
  // damaged/unsellable; "cancelled" = customer backed out after we already
  // bought it (correct item, no delivery problem). Wrong, broken & cancelled
  // all cancel + refund the picked orders; wrong and cancelled additionally
  // log ready stock (the received SKU, or the already-bought units).
  const [mode, setMode] = useState<"arrive" | "wrong" | "broken" | "missing" | "cancelled">("arrive")
  const [receivedItem, setReceivedItem] = useState("")
  // Which waiting customer orders to cancel on a wrong/broken delivery —
  // default all of them (the expected item won't be fulfilled).
  const [cancelIds, setCancelIds] = useState<Set<number>>(() => new Set(item.orders.map((o) => o.id)))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Receipt tagging the returned-to-inventory stock on a customer cancellation.
  // Defaults to the checked orders' customer usernames (tracks the checkboxes
  // until the operator edits it).
  const [receipt, setReceipt] = useState("")
  const [receiptTouched, setReceiptTouched] = useState(false)

  const quantityArrived = Math.max(0, Number(qty) || 0)
  const preview = computeFill(item.orders, quantityArrived)

  // Distinct usernames of the currently-checked orders, joined — the default
  // receipt for the customer-cancelled path.
  const cancelledCustomers = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const o of item.orders) {
      if (cancelIds.has(o.id) && !seen.has(o.customer)) { seen.add(o.customer); names.push(o.customer) }
    }
    return names.join(", ")
  }, [item.orders, cancelIds])
  const receiptValue = receiptTouched ? receipt : cancelledCustomers
  // Wrong-product needs a received SKU that differs from the expected one.
  const wrongValid = receivedItem.trim() !== "" && receivedItem !== item.productName

  async function handleSubmit() {
    setSaving(true)
    setSaveError(null)
    try {
      if (mode === "wrong") {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived."); return }
        if (!wrongValid) {
          setSaveError(
            receivedItem === item.productName
              ? "Received item must differ from the expected one."
              : "Pick the item the supplier actually sent.",
          )
          return
        }
        // Log the received SKU to ready stock and cancel the chosen customer
        // orders. Their invoices drop, so overpayment refunds auto-materialize
        // for anyone who already paid (overseas — the expected item can't be
        // re-ordered).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "wrong_product",
            event: item.event,
            expectedItem: item.productName,
            receivedItem,
            qty: quantityArrived,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to log wrong product")
      } else if (mode === "broken") {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived broken."); return }
        // Broken on arrival: log the broken units to Inventory (flagged broken,
        // never assignable to orders) and cancel the chosen customer orders
        // (refunds auto-materialize if paid).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "broken",
            event: item.event,
            productName: item.productName,
            qty: quantityArrived,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record broken units")
      } else if (mode === "missing") {
        if (cancelIds.size === 0) { setSaveError("Pick at least one order to cancel."); return }
        // Item never arrived: cancel the chosen orders, log nothing to Inventory.
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "missing",
            event: item.event,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record missing units")
      } else if (mode === "cancelled") {
        if (cancelIds.size === 0) { setSaveError("Pick at least one order to cancel."); return }
        // Customer backed out after we already bought their item — it's
        // correct, sellable stock, not broken or missing. Log the
        // already-bought units to Inventory as ready stock and cancel the
        // chosen orders (refunds auto-materialize if paid).
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "customer_cancelled",
            event: item.event,
            productName: item.productName,
            receipt: receiptValue,
            cancelOrderIds: [...cancelIds],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to record cancellation")
      } else {
        if (quantityArrived < 1) { setSaveError("Enter how many units arrived."); return }
        const res = await fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: item.event,
            productId: item.productId,
            quantityArrived,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to mark as arrived")
      }
      onSuccess()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed")
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
        className="bg-white rounded-xl border border-cream-border shadow-xl w-full max-w-sm flex flex-col gap-4 p-6 h-[min(37rem,90vh)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 shrink-0">
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

        {/* Fixed-height dialog: this is the only scrollable region, so the
            modal itself is always the same height no matter which tab (and
            its content length) is active. */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-5 -mr-2 pr-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-500">What happened?</span>
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {([
              ["arrive", "Arrived"],
              ["wrong", "Wrong"],
              ["broken", "Broken"],
              ["missing", "Missing"],
              ["cancelled", "Cancelled"],
            ] as const).map(([m, label]) => {
              const active = mode === m
              const activeCls = m === "arrive" ? "bg-blue-600 text-white" : "bg-yellow-500 text-white"
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m)
                    setSaveError(null)
                    // "Cancelled" is almost always a single customer, not the
                    // whole waiting list — start empty instead of defaulting
                    // to the all-selected behavior the delivery-problem modes use.
                    setCancelIds(m === "cancelled" ? new Set() : new Set(item.orders.map((o) => o.id)))
                  }}
                  className={`flex-1 px-2 py-1.5 whitespace-nowrap transition-colors ${active ? `${activeCls} font-medium` : "bg-white text-gray-600 hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Missing and Cancelled derive their qty from the checked orders below
            (pending / unit_buy) instead of a typed count — shown here read-only
            so the row layout matches Wrong/Broken/Arrived OK. */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-500">
            {mode === "wrong" ? "Units received (wrong product)" : mode === "broken" ? "Units broken" : mode === "missing" ? "Units missing" : mode === "cancelled" ? "Units cancelled" : "Units arrived"}{" "}
            <span className="text-gray-400">(pending: {item.totalPending})</span>
          </label>
          {mode === "missing" || mode === "cancelled" ? (
            <div className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-cream/50 text-gray-500 tabular-nums">
              {mode === "missing"
                ? item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.pending, 0)
                : item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.unitBuy, 0)}{" "}
              <span className="text-gray-400">(from checked orders below)</span>
            </div>
          ) : (
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); if (e.key === "Escape") onClose() }}
              autoFocus
              className="border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
            />
          )}
        </div>

        {mode !== "arrive" && (
          <>
            {/* Reserved even outside "wrong" mode (just hidden) so switching
                tabs doesn't change the modal's height. */}
            <div className={`flex flex-col gap-1.5 ${mode === "wrong" ? "" : "invisible"}`} aria-hidden={mode !== "wrong"}>
              <label className="text-xs font-medium text-yellow-700">Received item (what supplier sent)</label>
              <SearchableSelect
                value={receivedItem}
                onChange={(v) => { setReceivedItem(v); setSaveError(null) }}
                options={itemOptions}
                placeholder="Search item…"
              />
              <p className="text-[11px] text-gray-400">Logged to Inventory as ready stock.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-yellow-700">Affected orders</label>
              <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto pr-0.5">
                {item.orders.map((o) => (
                  <label key={o.id} className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-gray-50 cursor-pointer">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={cancelIds.has(o.id)}
                        onChange={(e) => setCancelIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(o.id)
                          else next.delete(o.id)
                          return next
                        })}
                        className="accent-yellow-600"
                      />
                      <span className="truncate text-gray-600">{displayIg(o.customer)}</span>
                    </span>
                    <span className="text-gray-400 tabular-nums shrink-0">
                      {mode === "cancelled" ? o.unitBuy : o.pending}×
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-gray-400">
                {mode === "broken"
                  ? "Broken units are logged to Inventory (flagged “broken”, not sellable). "
                  : mode === "missing"
                  ? "The item never arrived, so nothing is logged to Inventory. "
                  : mode === "cancelled"
                  ? `The units already bought for checked orders (${item.orders.filter((o) => cancelIds.has(o.id)).reduce((s, o) => s + o.unitBuy, 0)} total) are logged to Inventory as ready stock, assignable to the next customer who wants this item. `
                  : ""}
                Checked orders are removed from the invoice and refunded if paid; unchecked orders stay pending.
              </p>
              {mode === "cancelled" && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-yellow-700">
                    Inventory receipt <span className="text-gray-400 font-normal">(tags the returned stock)</span>
                  </label>
                  <input
                    type="text"
                    value={receiptValue}
                    onChange={(e) => { setReceipt(e.target.value); setReceiptTouched(true) }}
                    disabled={saving}
                    placeholder="e.g. customer username"
                    className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
                  />
                </div>
              )}
            </div>
          </>
        )}

        {mode === "arrive" && quantityArrived > 0 && (
          <div className="flex flex-col gap-2 text-xs">
            {preview.filled.length > 0 && (
              <div>
                <div className="font-medium text-gray-500 mb-1">Will mark as arrived ({preview.filled.reduce((s, f) => s + f.allocated, 0)} units):</div>
                <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5">
                  {preview.filled.map((f) => (
                    <div key={f.order.id} className="flex items-center justify-between px-2 py-1 rounded-md bg-blue-50">
                      <span className="text-blue-800 truncate">{displayIg(f.order.customer)}</span>
                      <span className="text-blue-700 font-medium ml-2 shrink-0 tabular-nums">
                        {f.allocated}×
                        {f.allocated < f.order.pending && (
                          <span className="text-blue-600/70 font-normal"> of {f.order.pending}</span>
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

            {preview.unassignedUnits > 0 && (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 shrink-0">
                  <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
                <span className="text-amber-700 font-medium">{preview.unassignedUnits} extra units → not assigned (more arrived than expected)</span>
              </div>
            )}
          </div>
        )}
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0 pt-3 border-t border-cream-border">
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
            disabled={
              saving ||
              (mode !== "missing" && mode !== "cancelled" && quantityArrived < 1) ||
              (mode === "wrong" && !wrongValid) ||
              ((mode === "missing" || mode === "cancelled") && cancelIds.size === 0)
            }
            className={`px-4 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-50 transition-colors ${mode === "arrive" ? "bg-blue-600 hover:bg-blue-700" : "bg-yellow-600 hover:bg-yellow-700"}`}
          >
            {saving
              ? "Saving…"
              : mode === "wrong"
                ? "Log wrong & cancel"
                : mode === "broken"
                  ? "Log broken & cancel"
                  : mode === "missing"
                    ? "Mark missing & cancel"
                    : mode === "cancelled"
                      ? "Log to inventory & cancel"
                      : "Mark arrived"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Not Received panel (bulk delivery problems) ─────────────────────────────

type NotReceivedMode = "wrong" | "broken" | "missing" | "cancelled"

function NotReceivedPanel({
  items,
  itemOptions,
  onClose,
  onSuccess,
  onPartial,
}: {
  items: ArrivalListItem[]
  itemOptions: { value: string; label: string; meta?: string }[]
  onClose: () => void
  onSuccess: () => void
  onPartial: (succeededKeys: string[]) => void
}) {
  const [mode, setMode] = useState<NotReceivedMode>("broken")
  // qty per item (default = pending). received SKU per item (Wrong tab only).
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const it of items) m[selKey(it)] = String(it.totalPending)
    return m
  })
  const [received, setReceived] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const byEvent = useMemo(() => {
    const m = new Map<string, ArrivalListItem[]>()
    for (const it of items) {
      const arr = m.get(it.event) ?? []
      arr.push(it)
      m.set(it.event, arr)
    }
    return m
  }, [items])

  const qtyOf = (it: ArrivalListItem) => Math.min(Number(qtys[selKey(it)]) || 0, it.totalPending)
  const activeItems = items.filter((it) => qtyOf(it) > 0)
  const totalQty = activeItems.reduce((s, it) => s + qtyOf(it), 0)
  // Wrong needs a valid received SKU (present, differs from expected) on every active row.
  const wrongMissingSku =
    mode === "wrong" &&
    activeItems.some((it) => {
      const sku = received[selKey(it)]
      return !sku || sku === it.productName
    })
  const canSubmit = totalQty > 0 && !wrongMissingSku

  async function handleSubmit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setErrors([])

    const targets = activeItems.map((it) => ({
      key: selKey(it),
      event: it.event,
      productId: it.productId,
      productName: it.productName,
      qty: qtyOf(it),
      receivedItem: received[selKey(it)],
    }))

    const settled = await Promise.allSettled(
      targets.map((t) =>
        fetch("/api/sheets/arrival-list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "not_received",
            mode,
            event: t.event,
            productId: t.productId,
            productName: t.productName,
            qty: t.qty,
            ...(mode === "wrong" ? { receivedItem: t.receivedItem } : {}),
          }),
        }).then(async (res) => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? `Failed for ${t.productName}`)
          return t.key
        }),
      ),
    )

    const succeeded: string[] = []
    const failed: string[] = []
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(targets[i].key)
      else failed.push(`${targets[i].productName}: ${r.reason instanceof Error ? r.reason.message : "failed"}`)
    })

    setSubmitting(false)
    if (failed.length === 0) onSuccess()
    else { setErrors(failed); if (succeeded.length > 0) onPartial(succeeded) }
  }

  const TABS: [NotReceivedMode, string][] = [
    ["wrong", "Wrong"],
    ["broken", "Broken"],
    ["missing", "Missing"],
    ["cancelled", "Cancelled"],
  ]

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
            Not received — {items.length} item{items.length === 1 ? "" : "s"}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Records the chosen quantity as not received, refunding the highest-priority orders first. Leftover units stay pending.
          </p>
        </div>

        <div className="px-5 pt-4 shrink-0">
          <div className="flex rounded-lg border border-cream-border overflow-hidden text-xs">
            {TABS.map(([m, label]) => {
              const active = mode === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`flex-1 px-2 py-1.5 font-medium transition-colors ${active ? "bg-amber-500 text-white" : "text-gray-500 hover:bg-cream"}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto min-h-0 flex flex-col gap-4">
          {[...byEvent.entries()].map(([event, evItems]) => (
            <div key={event} className="flex flex-col gap-2">
              <div className="text-xs font-semibold text-gray-500">{event}</div>
              {evItems.map((it) => {
                const k = selKey(it)
                const sku = received[k]
                const skuInvalid = mode === "wrong" && qtyOf(it) > 0 && (!sku || sku === it.productName)
                return (
                  <div key={k} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground break-words">{it.productName}</div>
                        {it.store && <div className="text-[11px] text-gray-400">{it.store}</div>}
                      </div>
                      <input
                        type="number"
                        min="0"
                        max={it.totalPending}
                        value={qtys[k] ?? ""}
                        onChange={(e) => setQtys((p) => ({ ...p, [k]: e.target.value }))}
                        className="w-20 shrink-0 border border-cream-border rounded-lg px-2 py-1.5 text-sm text-right bg-white focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-500 transition-colors"
                      />
                      <span className="text-[11px] text-gray-400 w-16 shrink-0">/ {it.totalPending} pending</span>
                    </div>
                    {mode === "wrong" && (
                      <div className="flex flex-col gap-1">
                        <SearchableSelect
                          value={sku ?? ""}
                          onChange={(v) => setReceived((p) => ({ ...p, [k]: v }))}
                          options={itemOptions}
                          placeholder="Received item (what supplier sent)…"
                        />
                        {skuInvalid && <span className="text-[11px] text-red-600">Pick a received item different from the expected one.</span>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-cream-border shrink-0 flex flex-col gap-3">
          {errors.length > 0 && (
            <div className="text-xs text-red-600">
              <div className="font-medium">Some items failed (others were recorded):</div>
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
              disabled={submitting || !canSubmit}
              className="px-4 py-1.5 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
