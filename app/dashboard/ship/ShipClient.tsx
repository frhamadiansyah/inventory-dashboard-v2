"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import SelectionActionBar from "@/components/SelectionActionBar"
import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import type { ShipCustomer, ShipOrdersParams, ShipSegment, ShipStatus, ShipOrdersFiltered, PaymentStatus } from "@/lib/db"
import { normalizeId } from "@/lib/db/helpers"
import { generateShippingLabel } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { useResizableColumns } from "@/hooks/useResizableColumns"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { useBusinessProfile } from "@/hooks/useBusinessProfile"
import EventSelect from "@/components/EventSelect"
import SearchInput from "@/components/SearchInput"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import { copyToClipboard } from "@/lib/clipboard"
import { buildShipmentConfirmMessage } from "@/lib/shipment-message"

type Segment = ShipSegment

const SEGMENTS: { id: Segment; label: string }[] = [
  { id: "all", label: "Semua" },
  { id: "not_arrived", label: "Belum Tiba" },
  { id: "partial", label: "Tiba Sebagian" },
  { id: "ready_unpaid", label: "Belum Bayar" },
  { id: "ready", label: "Siap Dikirim" },
  { id: "hold", label: "Hold" },
  { id: "shipped", label: "Sudah Dikirim" },
]

// Card badge styling per arrival/ship status (mirrors SEGMENTS labels).
const STATUS_BADGE: Record<ShipStatus, { label: string; cls: string }> = {
  not_arrived: { label: "Belum Tiba", cls: "bg-gray-100 text-gray-500" },
  partial: { label: "Tiba Sebagian", cls: "bg-amber-100 text-amber-700" },
  ready: { label: "Siap Dikirim", cls: "bg-brand/10 text-brand" },
  ready_unpaid: { label: "Belum Bayar", cls: "bg-orange-100 text-orange-700" },
  hold: { label: "Hold", cls: "bg-purple-100 text-purple-700" },
  shipped: { label: "Sudah Dikirim", cls: "bg-green-100 text-green-700" },
}

// Payment-status chip rendered on every ship card so the new "paid/overpaid"
// criterion is visible at a glance.
const PAYMENT_BADGE: Record<PaymentStatus, { label: string; cls: string }> = {
  paid:     { label: "Lunas",    cls: "bg-green-100 text-green-700" },
  overpaid: { label: "Lebih",    cls: "bg-blue-100 text-blue-700" },
  partial:  { label: "Sebagian", cls: "bg-amber-100 text-amber-700" },
  unpaid:   { label: "Belum",    cls: "bg-rose-100 text-rose-700" },
  void:     { label: "Void",     cls: "bg-gray-100 text-gray-500" },
}

export default function ShipClient() {
  const router = useRouter()
  const sheetOptions = useSheetOptions()
  const [groups, setGroups] = useState<ShipCustomer[]>([])
  const [counts, setCounts] = useState<Record<Segment, number>>({ all: 0, not_arrived: 0, partial: 0, ready: 0, ready_unpaid: 0, hold: 0, shipped: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [segment, setSegment] = useState<Segment>("ready")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [eventFilter, setEventFilter] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkShipping, setBulkShipping] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  // Gate the bulk-ship action behind a confirmation, mirroring the single-card
  // ShipConfirmModal.
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const fetchData = useCallback(async (seg: Segment, srch: string, ev: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set("segment", seg)
      if (srch) params.set("search", srch)
      if (ev) params.set("event", ev)

      const res = await fetch(`/api/sheets/ship?${params}`, { signal: ac.signal })
      const json: ShipOrdersFiltered = await res.json()
      if (!res.ok) throw new Error((json as unknown as { error: string }).error ?? "Failed to load")
      setGroups(json.groups)
      setCounts(json.counts)
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(segment, debouncedSearch, eventFilter)
  }, [segment, debouncedSearch, eventFilter, fetchData])

  // Client-side simple pagination for the browsing tabs (not the selection tabs).
  const SHIP_PAGE_SIZE = 25
  const PAGINATED_SEGMENTS: Segment[] = ["all", "not_arrived", "partial", "shipped"]
  const paginated = PAGINATED_SEGMENTS.includes(segment)
  const pageCount = paginated ? Math.max(1, Math.ceil(groups.length / SHIP_PAGE_SIZE)) : 1
  const pageGroups = paginated ? groups.slice(page * SHIP_PAGE_SIZE, page * SHIP_PAGE_SIZE + SHIP_PAGE_SIZE) : groups
  useEffect(() => { setPage(0) }, [segment, debouncedSearch, eventFilter, groups.length])

  function refresh() {
    fetchData(segment, debouncedSearch, eventFilter)
  }

  const readyFiltered = groups.filter((c) => c.totalToShip > 0)
  const allSelected = readyFiltered.length > 0 && readyFiltered.every((c) => selected.has(`${c.customer}|${c.event}`))

  // "Ship together" is offered whenever the selected cards are all one customer;
  // the modal then fetches that customer's other shippable events to combine.
  const selectedGroups = readyFiltered.filter((c) => selected.has(`${c.customer}|${c.event}`))
  const mergeCustomers = new Set(selectedGroups.map((c) => normalizeId(c.customer)))
  const mergeEligible = selectedGroups.length >= 1 && mergeCustomers.size === 1

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(readyFiltered.map((c) => `${c.customer}|${c.event}`)))
    }
  }

  async function handleBulkShip() {
    const toShip = readyFiltered.filter((c) => selected.has(`${c.customer}|${c.event}`))
    if (toShip.length === 0) return
    setBulkShipping(true)
    setBulkError(null)
    setBulkProgress({ done: 0, total: toShip.length })
    try {
      for (const c of toShip) {
        const params: ShipOrdersParams = {
          customer: c.customer,
          event: c.event,
          orders: c.orders.map((o) => ({
            rowNumber: o.rowNumber,
            productId: o.productId,
            productName: o.productName,
            toShip: o.toShip,
            unitShip: o.unitShip,
          })),
          weightKg: c.weightKg,
          ongkirPerKg: c.ongkirPerKg,
        }
        const res = await fetch("/api/sheets/ship", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error ?? `Failed for ${c.customer}`)
        }
        setBulkProgress((prev) => prev ? { ...prev, done: prev.done + 1 } : null)
      }
      router.push("/dashboard/shipments")
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Terjadi kesalahan")
      setBulkShipping(false)
      setBulkProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Segment control */}
      <div className="flex items-center gap-1 w-full rounded-xl border border-cream-border bg-white p-1 overflow-x-auto">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { setSegment(s.id); setSelected(new Set()) }}
            className={`flex-1 shrink-0 flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              segment === s.id
                ? "bg-brand text-white"
                : "text-gray-500 hover:text-foreground"
            }`}
          >
            {s.label}
            <span
              className={`hidden sm:inline text-xs rounded-full px-1.5 py-0.5 tabular-nums ${
                segment === s.id
                  ? "bg-white/20 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {counts[s.id]}
            </span>
          </button>
        ))}
      </div>

      {/* Search + event filter */}
      <div className="flex gap-2 md:flex-wrap">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Cari customer…"
          className="flex-1 min-w-0 md:min-w-[160px]"
        />
        <div className="w-36 md:w-48 shrink-0">
          <EventSelect
            value={eventFilter}
            onChange={setEventFilter}
            events={sheetOptions?.events ?? []}
            placeholder="Semua Event"
            clearable
          />
        </div>
        {/* Desktop select-all toggle (mobile uses the round FAB). Shown on the
            "Siap Dikirim" tab even when empty. */}
        {!loading && !error && segment === "ready" && (
          <button
            type="button"
            onClick={toggleSelectAll}
            disabled={bulkShipping}
            aria-label={allSelected ? "Deselect all" : "Select all"}
            title={allSelected ? "Deselect all" : "Select all"}
            className="hidden md:inline-flex items-center gap-1.5 shrink-0 rounded-lg border border-cream-border h-[38px] px-3 text-sm text-gray-600 bg-white hover:border-brand transition-colors disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {allSelected && <span className="w-1.5 h-1.5 rounded-full bg-brand" />}
          </button>
        )}
      </div>

      {/* States */}
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-gray-400 text-sm">
          Tidak ada pesanan.
        </div>
      )}

      {/* Results */}
      {!loading && !error && groups.length > 0 && (
        <>
          {/* Mobile select-all FAB — round icon button like the Events "+" FAB.
              Only on the "Siap Dikirim" tab, matching desktop. */}
          {segment === "ready" && readyFiltered.length > 0 && (
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={bulkShipping}
              aria-label={allSelected ? "Deselect all" : "Select all"}
              className="md:hidden fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 w-14 h-14 rounded-full bg-brand text-white shadow-lg flex items-center justify-center active:bg-brand/90 disabled:opacity-50"
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
          )}
          {bulkError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {bulkError}
            </div>
          )}
          {/* Floating action bar (like shopping/receiving) for the selection
              actions — Combine + Ship. Shown on desktop and mobile. */}
          {selected.size > 0 && (
            <div className="contents">
              <SelectionActionBar
                reserveFab={segment === "ready"}
                count={selected.size}
                onClear={() => setSelected(new Set())}
                actions={[
                  ...(mergeEligible
                    ? [{
                        label: "Combine",
                        color: "blue" as const,
                        onClick: () => setMerging(true),
                        disabled: bulkShipping,
                        icon: (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M18 6a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" />
                          </svg>
                        ),
                      }]
                    : []),
                  {
                    label: bulkShipping && bulkProgress ? `${bulkProgress.done}/${bulkProgress.total}` : "Ship",
                    color: "brand" as const,
                    onClick: () => setBulkConfirmOpen(true),
                    disabled: bulkShipping,
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
                      </svg>
                    ),
                  },
                ]}
              />
            </div>
          )}
          {pageGroups.map((c) => {
            const key = `${c.customer}|${c.event}`
            return (
              <CustomerCard
                key={key}
                customer={c}
                segment={segment}
                isSelected={selected.has(key)}
                onToggleSelect={c.totalToShip > 0 ? () => toggleSelect(key) : undefined}
                onShipped={() => { setSegment("all"); refresh() }}
                onOpenInvoice={() => setInvoiceCustomer(c.customer)}
              />
            )
          })}
          {paginated && pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Prev</button>
              <span className="text-xs text-gray-400">Page {page + 1} of {pageCount}</span>
              <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="px-3 py-1.5 rounded-lg border border-cream-border text-sm text-gray-600 disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}

      {bulkConfirmOpen && selectedGroups.length > 0 && (
        <BulkShipConfirmModal
          groups={selectedGroups}
          busy={bulkShipping}
          onClose={() => setBulkConfirmOpen(false)}
          onConfirm={() => { setBulkConfirmOpen(false); handleBulkShip() }}
        />
      )}
      {merging && mergeEligible && (
        <MergeShipConfirmModal
          customer={selectedGroups[0].customer}
          preselectedEvents={selectedGroups.map((g) => g.event)}
          onClose={() => setMerging(false)}
          onSuccess={() => { setMerging(false); setSelected(new Set()); setSegment("all"); refresh() }}
        />
      )}
      {invoiceCustomer && (
        <InvoiceDetailDrawer
          customer={invoiceCustomer}
          onClose={() => setInvoiceCustomer(null)}
        />
      )}
    </div>
  )
}

// Build a WhatsApp deep link with the message prefilled. Indonesian numbers are
// normalized to international (0… → 62…, 8… → 62…). Without a number we fall
// back to the send picker so the user can choose a chat. (Same helper as the
// invoice message modal.)
function waLink(whatsapp: string | null | undefined, message: string): string {
  const text = encodeURIComponent(message)
  let num = (whatsapp ?? "").replace(/\D/g, "")
  if (num.startsWith("0")) num = "62" + num.slice(1)
  else if (num.startsWith("8")) num = "62" + num
  return num ? `https://wa.me/${num}?text=${text}` : `https://api.whatsapp.com/send?text=${text}`
}

// One "Product x N x Rp price" line per shipped row — matches the format the
// copy-confirm button and downstream messaging use.
function confirmMessageItems(c: ShipCustomer): string[] {
  return c.orders
    .filter((o) => o.toShip > 0)
    .map((o) => `${o.productName} x ${o.toShip} x Rp ${o.unitPrice.toLocaleString("id-ID")}`)
}

type CopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

function CopyConfirmMessageButton({ customer: c, className }: { customer: ShipCustomer; className?: string }) {
  const [state, setState] = useState<CopyState>({ status: "idle" })
  const templates = useMessageTemplates()
  const businessProfile = useBusinessProfile()

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick() {
    setState({ status: "loading" })
    try {
      // Only the rows being shipped this round (toShip > 0). Format mirrors
      // shipments.invoicing: one "Product x N" line per row, not consolidated,
      // so a repeated product reads as two lines (matches downstream messaging).
      const message = buildShipmentConfirmMessage({
        event: c.event,
        customer: c.customer,
        dataDiri: c.customerDetail?.dataDiri ?? "",
        items: confirmMessageItems(c),
      }, templates?.shipment, businessProfile?.publicSiteUrl)
      await copyToClipboard(message)
      setState({ status: "copied" })
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Failed" })
    }
  }

  const { status } = state
  const label =
    status === "loading" ? "…"
    : status === "copied" ? "✓"
    : status === "error" ? "!"
    : undefined

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === "loading" || !templates || !businessProfile}
      title={status === "error" ? state.message : "Copy pesan konfirmasi pengiriman"}
      className={`${className ?? "p-1 rounded"} inline-flex items-center justify-center transition-colors disabled:opacity-50 ${
        status === "copied" ? "text-green-600"
        : status === "error" ? "text-red-500"
        : "text-gray-400 hover:text-brand"
      }`}
    >
      {label ? (
        <span className="text-xs font-medium w-3.5 inline-block text-center">{label}</span>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )}
    </button>
  )
}

function CustomerCard({
  customer: c,
  segment,
  isSelected,
  onToggleSelect,
  onShipped,
  onOpenInvoice,
}: {
  customer: ShipCustomer
  segment: Segment
  isSelected?: boolean
  onToggleSelect?: () => void
  onShipped: () => void
  onOpenInvoice: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [holdBusy, setHoldBusy] = useState(false)
  const [holdError, setHoldError] = useState<string | null>(null)
  const { customerDetail } = c
  const { widths, startResize } = useResizableColumns({ items: 200, unit: 80, unitArrive: 80, unitShip: 80, toShip: 80 })
  const totalHold = c.orders.reduce((s, o) => s + o.unitHold, 0)

  async function postHoldAction(path: "hold" | "release", confirmMessage: string) {
    if (!confirm(confirmMessage)) return
    setHoldBusy(true)
    setHoldError(null)
    try {
      const res = await fetch(`/api/sheets/ship/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer: c.customer, event: c.event }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? "Failed")
      }
      onShipped()
    } catch (err) {
      setHoldError(err instanceof Error ? err.message : "Failed")
      setHoldBusy(false)
    }
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden transition-colors ${isSelected ? "border-brand" : "border-cream-border"}`}>
      <div className={`px-5 py-4 bg-gray-50 border-b border-cream-border flex justify-between gap-4 ${segment === "hold" ? "items-center md:items-start" : "items-start"}`}>
        <div className="flex items-start gap-3 min-w-0">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected ?? false}
              onChange={onToggleSelect}
              className="mt-1 rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer shrink-0"
            />
          )}
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex flex-col md:flex-row md:items-center gap-0.5 md:gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-foreground">{c.event}</span>
              <button
                type="button"
                onClick={onOpenInvoice}
                className="text-xs text-gray-500 font-medium hover:text-brand hover:underline cursor-pointer text-left truncate min-w-0"
                title="Lihat invoice"
              >
                {displayIg(c.customer).toUpperCase()}
              </button>
            </span>
            <span className={`hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[c.status].cls}`}>
              {STATUS_BADGE[c.status].label}
            </span>
            <span className={`hidden md:inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_BADGE[c.paymentStatus].cls}`}>
              {PAYMENT_BADGE[c.paymentStatus].label}
            </span>
            {/* Surfaces a hold on a card whose status badge is something else
                (e.g. "Tiba Sebagian") — the "hold" status only wins once every
                line has arrived, so without this a held unit on a partial event
                would show no sign it's being held back. */}
            {totalHold > 0 && c.status !== "hold" && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                Hold
              </span>
            )}
          </div>
        </div>
        </div>
        {/* Ship and hold are independent: a partially-arrived card can have some
            ready units AND some held units at once, so each sub-block renders on
            its own condition. Release is keyed on totalHold (not status === "hold")
            so a hold on a "Tiba Sebagian" card is still releasable — otherwise a
            held unit whose siblings haven't arrived would be stranded with no
            checkbox, Ship, or Release control. */}
        {(c.totalToShip > 0 || totalHold > 0) && (
          <div className="shrink-0 flex items-start gap-3">
            {c.totalToShip > 0 && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  <CopyConfirmMessageButton customer={c} className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50" />
                  <button
                    type="button"
                    onClick={() => postHoldAction("hold", `Hold this packing list for ${displayIg(c.customer).toUpperCase()} · ${c.event}?`)}
                    disabled={holdBusy}
                    className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
                  >
                    {holdBusy ? "…" : "Hold"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={holdBusy}
                    className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
                  >
                    Ship
                  </button>
                </div>
                <div className="hidden md:block mt-1 text-lg font-bold text-foreground leading-none">{c.totalToShip}</div>
                <div className="hidden md:block text-xs text-gray-500">to ship</div>
              </div>
            )}
            {totalHold > 0 && (
              <div className="flex flex-col items-end gap-1">
                <div className={`flex-col items-end gap-1 ${segment === "hold" ? "hidden md:flex" : "flex"}`}>
                  <div className="text-lg font-bold text-foreground leading-none">{totalHold}</div>
                  <div className="text-xs text-gray-500">on hold</div>
                </div>
                <button
                  type="button"
                  onClick={() => postHoldAction("release", `Release this packing list for ${displayIg(c.customer).toUpperCase()} · ${c.event} back to ready?`)}
                  disabled={holdBusy}
                  className="mt-1 px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
                >
                  {holdBusy ? "…" : "Release"}
                </button>
              </div>
            )}
          </div>
        )}
        {confirming && (
          <ShipConfirmModal
            customer={c}
            onClose={() => setConfirming(false)}
            onSuccess={() => { setConfirming(false); onShipped() }}
          />
        )}
      </div>
      {holdError && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-cream-border">{holdError}</div>
      )}

      {/* Orders table (desktop) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-cream-border">
              <th className="px-4 py-2 font-medium relative select-none" style={{ width: widths.items }}>
                Item
                <div onMouseDown={(e) => startResize("items", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unit }}>
                Ordered
                <div onMouseDown={(e) => startResize("unit", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unitArrive }}>
                Arrive
                <div onMouseDown={(e) => startResize("unitArrive", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.unitShip }}>
                Shipped
                <div onMouseDown={(e) => startResize("unitShip", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
              <th className="px-4 py-2 font-medium text-right relative select-none" style={{ width: widths.toShip }}>
                To Ship
                <div onMouseDown={(e) => startResize("toShip", e)} className="absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/60" />
              </th>
            </tr>
          </thead>
          <tbody>
            {c.orders.map((o) => (
              <tr key={o.rowNumber} className="border-b border-cream-border/60">
                <td className="px-4 py-2">
                  {o.productName}
                  {o.unitHold > 0 && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700 align-middle">
                      Hold
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">{o.unit}</td>
                <td className="px-4 py-2 text-right">{o.unitArrive}</td>
                <td className="px-4 py-2 text-right">{o.unitShip}</td>
                <td className={`px-4 py-2 text-right font-semibold ${o.toShip > 0 ? "text-brand" : "text-gray-400"}`}>
                  {o.toShip}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Orders list (mobile) */}
      <div className="md:hidden flex flex-col divide-y divide-cream-border/60">
        {c.orders.map((o) => (
          <div key={o.rowNumber} className="px-5 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-foreground truncate">
                {o.productName}
                {o.unitHold > 0 && (
                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700 align-middle">
                    Hold
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-400 tabular-nums mt-0.5">
                Order {o.unit} · Tiba {o.unitArrive} · Kirim {o.unitShip}
              </div>
            </div>
            <div className={`shrink-0 text-xs font-semibold tabular-nums ${o.toShip > 0 ? "text-brand" : "text-gray-400"}`}>
              {o.toShip}
            </div>
          </div>
        ))}
      </div>

      {/* Collapsible address */}
      {customerDetail?.dataDiri && (
        <div className="border-t border-cream-border">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-xs text-gray-500 hover:text-brand transition-colors"
          >
            <span className="font-medium">Alamat pengiriman</span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {expanded && (
            <div className="px-5 pb-4">
              <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                {customerDetail.dataDiri}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Confirmation gate for bulk shipping — lists the selected packages and asks
// before firing handleBulkShip (mirrors the single-card ShipConfirmModal's
// "confirm first" behaviour, minus the per-package label preview).
function BulkShipConfirmModal({
  groups,
  busy,
  onConfirm,
  onClose,
}: {
  groups: ShipCustomer[]
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  useModalDismiss(onClose)
  const total = groups.length
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-t-2xl md:rounded-xl border-x border-t border-cream-border md:border shadow-xl w-full max-w-md flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <h3 className="text-base md:text-sm font-semibold text-foreground">Konfirmasi Pengiriman</h3>
          <p className="text-xs text-gray-500 mt-0.5">Kirim {total} paket sekaligus?</p>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex flex-col gap-1.5">
          {groups.map((c) => (
            <div key={`${c.customer}|${c.event}`} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground uppercase">{displayIg(c.customer)}</span>
                <span className="text-gray-400"> · {c.event}</span>
              </span>
              <span className="tabular-nums text-gray-500 shrink-0">{c.totalToShip}</span>
            </div>
          ))}
        </div>
        <div className="px-5 pt-3 pb-8 md:py-3 border-t border-cream-border shrink-0 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-cream-border text-gray-600 text-sm hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Mengirim…" : `Kirim ${total} Paket`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShipConfirmModal({
  customer: c,
  onClose,
  onSuccess,
}: {
  customer: ShipCustomer
  onClose: () => void
  onSuccess: () => void
}) {
  const [shipping, setShipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ pdfUrl: string; shippingId: string } | null>(null)
  // Optional one-time address override. Toggle off (the default) ships to the
  // customer's profile data_diri. Toggle on reveals an editable textarea pre-
  // filled with that same address so admin can tweak just the parts that
  // differ (receiver name, street) without retyping the whole block.
  const profileAddress = c.customerDetail?.dataDiri ?? ""
  const [useTempAddress, setUseTempAddress] = useState(false)
  const [tempAddress, setTempAddress] = useState(profileAddress)
  const [msgCopied, setMsgCopied] = useState(false)
  const toShipRows = c.orders.filter((o) => o.toShip > 0)
  const templates = useMessageTemplates()
  const businessProfile = useBusinessProfile()

  // Confirmation message uses whichever address is active (temp override or the
  // customer's profile), so Copy / WhatsApp always match what's shown above.
  const confirmMessage = buildShipmentConfirmMessage({
    event: c.event,
    customer: c.customer,
    dataDiri: useTempAddress ? tempAddress : profileAddress,
    items: confirmMessageItems(c),
  }, templates?.shipment, businessProfile?.publicSiteUrl)

  async function handleCopyMessage() {
    try {
      await copyToClipboard(confirmMessage)
      setMsgCopied(true)
      setTimeout(() => setMsgCopied(false), 1500)
    } catch {
      /* clipboard blocked — no-op, WhatsApp button still works */
    }
  }

  const dismissRef = useRef<() => void>(onClose)
  dismissRef.current = result ? onSuccess : onClose
  useModalDismiss(() => dismissRef.current())

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleConfirm() {
    setShipping(true)
    setError(null)
    const effectiveAddress = useTempAddress ? tempAddress : profileAddress
    const params: ShipOrdersParams = {
      customer: c.customer,
      event: c.event,
      orders: c.orders.map((o) => ({
        rowNumber: o.rowNumber,
        productId: o.productId,
        productName: o.productName,
        toShip: o.toShip,
        unitShip: o.unitShip,
      })),
      weightKg: c.weightKg,
      ongkirPerKg: c.ongkirPerKg,
      tempAddress: useTempAddress ? tempAddress : null,
    }
    try {
      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const blob = await generateShippingLabel({
        event: c.event,
        customer: c.customer,
        shippingId: data.shippingId,
        dataDiri: effectiveAddress,
        packingLines: toShipRows.map((o) => `${o.productName} x ${o.toShip}`),
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setResult({ pdfUrl: url, shippingId: data.shippingId })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ship")
      setShipping(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={() => dismissRef.current()}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {result ? "Label Pengiriman" : "Konfirmasi Pengiriman"}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(c.customer).toUpperCase()} · {c.event}
            {result && <span className="ml-2 font-mono">#{result.shippingId}</span>}
          </div>
        </div>

        {result ? (
          <iframe
            src={result.pdfUrl}
            title="Label Pengiriman"
            className="flex-1 w-full border-0 min-h-0"
          />
        ) : (
          <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
            <div>
              <div className="text-xs font-medium text-gray-500 mb-2">Item yang dikirim</div>
              <div className="flex flex-col gap-1">
                {toShipRows.map((o) => (
                  <div key={o.rowNumber} className="text-sm text-foreground">{o.items}</div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-medium text-gray-500">
                  Alamat pengiriman
                  {useTempAddress && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700">
                      Sementara
                    </span>
                  )}
                </div>
                <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useTempAddress}
                    onChange={(e) => setUseTempAddress(e.target.checked)}
                    className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
                  />
                  Kirim ke alamat berbeda
                </label>
              </div>
              {useTempAddress ? (
                <>
                  <textarea
                    value={tempAddress}
                    onChange={(e) => setTempAddress(e.target.value)}
                    rows={5}
                    placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
                    className="w-full border border-purple-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors resize-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Alamat ini hanya untuk pengiriman ini. Alamat utama customer tidak berubah.
                  </p>
                </>
              ) : (
                profileAddress ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                    {profileAddress}
                  </pre>
                ) : (
                  <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                    Customer belum punya alamat di profil. Aktifkan toggle untuk isi alamat manual.
                  </p>
                )
              )}
            </div>

            <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Estimasi berat</span>
                <span className="font-medium">{c.weightKg} kg</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Ongkir/kg</span>
                <span className="font-medium">Rp {c.ongkirPerKg.toLocaleString("id-ID")}</span>
              </div>
              <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                <span className="text-gray-500">Total ongkir</span>
                <span className="font-semibold">Rp {(c.weightKg * c.ongkirPerKg).toLocaleString("id-ID")}</span>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {result ? (
            <>
              <a
                href={result.pdfUrl}
                download={`label-${result.shippingId}.pdf`}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
              >
                Tutup
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleCopyMessage}
                disabled={!templates || !businessProfile}
                title="Salin pesan konfirmasi pengiriman"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                {msgCopied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                )}
                {msgCopied ? "Tersalin" : "Salin pesan"}
              </button>
              <a
                href={waLink(c.customerDetail?.whatsapp, confirmMessage)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { if (!templates || !businessProfile) e.preventDefault() }}
                title="Kirim pesan via WhatsApp"
                className={`mr-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-green-500 text-green-700 text-xs font-medium hover:bg-green-500 hover:text-white transition-colors ${templates && businessProfile ? "" : "opacity-50 pointer-events-none"}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.8.37-.27.3-1.05 1.02-1.05 2.5s1.07 2.9 1.22 3.1c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35zM12.05 21.5h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-3.57.94.95-3.48-.22-.36a9.42 9.42 0 0 1-1.44-5.02c0-5.2 4.24-9.44 9.45-9.44 2.52 0 4.89.98 6.67 2.77a9.38 9.38 0 0 1 2.76 6.68c0 5.2-4.24 9.44-9.45 9.44zm8.04-17.49A11.36 11.36 0 0 0 12.05.5C5.8.5.72 5.58.72 11.83c0 2 .52 3.95 1.51 5.67L.63 23.5l6.14-1.61a11.33 11.33 0 0 0 5.28 1.34h.01c6.25 0 11.33-5.08 11.33-11.33 0-3.03-1.18-5.87-3.32-8.01z" />
                </svg>
                WhatsApp
              </a>
              <button
                type="button"
                onClick={onClose}
                disabled={shipping}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={shipping}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {shipping ? "Mengirim…" : "Konfirmasi Kirim"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// "Ship together": merge one customer's ready orders across several events into
// a single package — combined weight, ongkir billed once, one label. The modal
// fetches every shippable event for the customer (across all tabs) so you can
// pick which ones to combine without hunting for cards.
function MergeShipConfirmModal({
  customer,
  preselectedEvents,
  onClose,
  onSuccess,
}: {
  customer: string
  preselectedEvents: string[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [allGroups, setAllGroups] = useState<ShipCustomer[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set(preselectedEvents))
  const [shipping, setShipping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ pdfUrl: string; shippingId: string; discount: number } | null>(null)
  // One-time address override for the combined package. Pre-fills with the
  // customer's profile address once it loads so admin can tweak just the
  // parts that differ. One address per box — merged shipments share it.
  const [useTempAddress, setUseTempAddress] = useState(false)
  const [tempAddress, setTempAddress] = useState("")

  // Pull every shippable event for this customer, regardless of which tab the
  // cards live on, so partial + ready events can be combined freely.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/sheets/ship?segment=all&search=${encodeURIComponent(customer)}`)
        const json: ShipOrdersFiltered = await res.json()
        if (!res.ok) throw new Error((json as unknown as { error: string }).error ?? "Failed to load")
        if (cancelled) return
        const mine = json.groups
          .filter((g) => normalizeId(g.customer) === normalizeId(customer) && g.totalToShip > 0)
          .sort((a, b) => a.event.localeCompare(b.event))
        setAllGroups(mine)
        setChecked((prev) => {
          const valid = new Set([...prev].filter((e) => mine.some((g) => g.event === e)))
          return valid.size > 0 ? valid : new Set(mine.map((g) => g.event))
        })
      } catch (err) {
        if (!cancelled) setLoadErr(err instanceof Error ? err.message : "Failed to load")
      }
    })()
    return () => { cancelled = true }
  }, [customer])

  const checkedGroups = (allGroups ?? []).filter((g) => checked.has(g.event))
  const customerDetail = allGroups?.[0]?.customerDetail ?? null
  const ongkirPerKg = allGroups?.[0]?.ongkirPerKg ?? 0
  const profileAddress = customerDetail?.dataDiri ?? ""

  // Seed the temp-address textarea with the customer's profile address once
  // the fetch completes. Only seeds when empty so admin's typing isn't blown
  // away by a re-render.
  useEffect(() => {
    if (profileAddress && !tempAddress) setTempAddress(profileAddress)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileAddress])
  const totalGram = checkedGroups.reduce((s, g) => s + g.orders.reduce((a, o) => a + o.gram * o.toShip, 0), 0)
  const combinedKg = Math.ceil(totalGram / 1000)
  const combinedOngkir = ongkirPerKg * combinedKg
  const canConfirm = checkedGroups.length >= 2

  function toggle(ev: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(ev)) next.delete(ev)
      else next.add(ev)
      return next
    })
  }

  const dismissRef = useRef<() => void>(onClose)
  dismissRef.current = result ? onSuccess : onClose
  useModalDismiss(() => dismissRef.current())

  const urlRef = useRef<string | null>(null)
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])

  async function handleConfirm() {
    if (!canConfirm) return
    setShipping(true)
    setError(null)
    const effectiveAddress = useTempAddress ? tempAddress : profileAddress
    try {
      const res = await fetch("/api/sheets/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          ongkirPerKg,
          groups: checkedGroups.map((g) => ({
            event: g.event,
            orders: g.orders
              .filter((o) => o.toShip > 0)
              .map((o) => ({ rowNumber: o.rowNumber, productName: o.productName, toShip: o.toShip, gram: o.gram })),
          })),
          tempAddress: useTempAddress ? tempAddress : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed")

      const packingLines: string[] = []
      for (const g of checkedGroups) {
        for (const o of g.orders.filter((o) => o.toShip > 0)) {
          packingLines.push(`[${g.event}] ${o.productName} x ${o.toShip}`)
        }
      }
      const blob = await generateShippingLabel({
        event: checkedGroups.map((g) => g.event).join(" + "),
        customer,
        shippingId: data.shippingId,
        dataDiri: effectiveAddress,
        packingLines,
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setResult({ pdfUrl: url, shippingId: data.shippingId, discount: data.discount ?? 0 })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to ship")
      setShipping(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={() => dismissRef.current()}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">
            {result ? "Label Pengiriman" : "Gabung Pengiriman"}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(customer).toUpperCase()}
            {result
              ? <> · {checkedGroups.map((g) => g.event).join(" + ")}<span className="ml-2 font-mono">#{result.shippingId}</span></>
              : <> · pilih event yang digabung</>}
          </div>
        </div>

        {result ? (
          <iframe src={result.pdfUrl} title="Label Pengiriman" className="flex-1 w-full border-0 min-h-0" />
        ) : (
          <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
            {loadErr ? (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{loadErr}</div>
            ) : !allGroups ? (
              <div className="py-8 text-center text-sm text-gray-400">Memuat event…</div>
            ) : allGroups.length < 2 ? (
              <div className="rounded-lg bg-cream/50 px-4 py-3 text-sm text-gray-500">
                Customer ini hanya punya satu event siap kirim — tidak ada yang bisa digabung.
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {allGroups.map((g) => {
                    const isOn = checked.has(g.event)
                    return (
                      <label
                        key={g.event}
                        className={`flex gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${isOn ? "border-brand bg-brand/5" : "border-cream-border"}`}
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          onChange={() => toggle(g.event)}
                          className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-gray-500 mb-1">{g.event}</div>
                          <div className="flex flex-col gap-0.5">
                            {g.orders.filter((o) => o.toShip > 0).map((o) => (
                              <div key={o.rowNumber} className="text-sm text-foreground">{o.productName} x {o.toShip}</div>
                            ))}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs font-medium text-gray-500">
                      Alamat pengiriman
                      {useTempAddress && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700">
                          Sementara
                        </span>
                      )}
                    </div>
                    <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useTempAddress}
                        onChange={(e) => setUseTempAddress(e.target.checked)}
                        className="rounded border-gray-300 text-brand focus:ring-brand/30 cursor-pointer"
                      />
                      Kirim ke alamat berbeda
                    </label>
                  </div>
                  {useTempAddress ? (
                    <>
                      <textarea
                        value={tempAddress}
                        onChange={(e) => setTempAddress(e.target.value)}
                        rows={5}
                        placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
                        className="w-full border border-purple-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors resize-none"
                      />
                      <p className="text-[11px] text-gray-400 mt-1">
                        Seluruh paket gabungan akan dikirim ke alamat ini. Alamat utama customer tidak berubah.
                      </p>
                    </>
                  ) : (
                    profileAddress ? (
                      <pre className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed">
                        {profileAddress}
                      </pre>
                    ) : (
                      <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        Customer belum punya alamat di profil. Aktifkan toggle untuk isi alamat manual.
                      </p>
                    )
                  )}
                </div>

                <div className="rounded-lg bg-cream/50 px-4 py-3 flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Estimasi berat (gabungan)</span>
                    <span className="font-medium">{combinedKg} kg</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Ongkir/kg</span>
                    <span className="font-medium">Rp {ongkirPerKg.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="flex justify-between border-t border-cream-border mt-1 pt-1">
                    <span className="text-gray-500">Total ongkir (sekali)</span>
                    <span className="font-semibold">Rp {combinedOngkir.toLocaleString("id-ID")}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    Ongkir ditagih sekali untuk paket gabungan. Diskon ongkir gabungan otomatis diterapkan ke invoice.
                  </div>
                </div>

                {!canConfirm && (
                  <div className="text-xs text-amber-600">Pilih minimal 2 event untuk digabung.</div>
                )}
                {error && (
                  <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {result ? (
            <>
              {result.discount > 0 && (
                <span className="mr-auto text-xs text-green-700 self-center">
                  Diskon ongkir gabungan: Rp {result.discount.toLocaleString("id-ID")}
                </span>
              )}
              <a
                href={result.pdfUrl}
                download={`label-${result.shippingId}.pdf`}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
              >
                Download PDF
              </a>
              <button
                type="button"
                onClick={onSuccess}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
              >
                Tutup
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={shipping}
                className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={shipping || !canConfirm}
                className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors disabled:opacity-50"
              >
                {shipping ? "Mengirim…" : "Konfirmasi Gabung & Kirim"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
