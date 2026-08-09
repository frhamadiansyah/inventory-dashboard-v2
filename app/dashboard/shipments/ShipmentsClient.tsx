"use client"

import { displayIg } from "@/lib/format"
import TableSkeleton from "@/components/TableSkeleton"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ShippingRecord } from "@/lib/db"
import { generateShippingLabel, generateMultipleShippingLabels } from "@/lib/shipping-label"
import type { ShippingLabelParams } from "@/lib/shipping-label"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { copyToClipboard } from "@/lib/clipboard"
import { buildShipmentConfirmMessage } from "@/lib/shipment-message"
import { useMessageTemplates } from "@/hooks/useMessageTemplates"
import { useBusinessProfile } from "@/hooks/useBusinessProfile"
import DataGrid, {
  numericFilter,
  textContainsFilter,
  booleanFilter,
  type ColumnDef,
  type RowSelectionState,
} from "@/components/DataGrid"
import { InvoiceDetailDrawer } from "@/app/dashboard/invoice/InvoiceDetailDrawer"
import SearchableSelect from "@/components/SearchableSelect"

const fmt = (n: number) => n.toLocaleString("id-ID")

// Time-window options for the shipments filter (click-only dropdown).
const WINDOW_OPTIONS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last week" },
  { value: "30", label: "Last month" },
  { value: "all", label: "All shipments" },
]

// A grid row may represent several DB shipment rows that were shipped together
// (same merge_group). It carries the underlying rowNumbers so actions (resi
// edit, label) apply to the whole group.
interface DisplayShipment extends ShippingRecord {
  rowNumbers: number[]
  mergedCount: number
}

/** Collapse rows sharing a merge_group into one combined entry. */
function collapseMerged(rows: ShippingRecord[]): DisplayShipment[] {
  const groups = new Map<string, ShippingRecord[]>()
  const result: DisplayShipment[] = []
  for (const r of rows) {
    if (!r.mergeGroup) {
      result.push({ ...r, rowNumbers: [r.rowNumber], mergedCount: 1 })
    } else {
      const arr = groups.get(r.mergeGroup)
      if (arr) arr.push(r)
      else groups.set(r.mergeGroup, [r])
    }
  }
  for (const arr of groups.values()) {
    const sorted = [...arr].sort((a, b) => Number(a.shippingId) - Number(b.shippingId))
    const primary = sorted[0]
    const lines = sorted.flatMap((s) =>
      s.invoicing.split("\n").filter(Boolean).map((l) => `[${s.event}] ${l}`),
    )
    result.push({
      ...primary,
      event: sorted.map((s) => s.event).join(" + "),
      // All rows of a merge share one shipping_id, so show it once.
      shippingId: primary.shippingId,
      invoicing: lines.join("\n"),
      weightEstimation: sorted.reduce((s, x) => s + x.weightEstimation, 0),
      ongkirTotal: sorted.reduce((s, x) => s + x.ongkirTotal, 0),
      trackingNumber: sorted.find((s) => s.trackingNumber)?.trackingNumber ?? "",
      // temp_address is replicated across every row in a merge group so
      // reading from any one works — but defensively pick the first non-null
      // in case partial writes ever land.
      tempAddress: sorted.find((s) => s.tempAddress)?.tempAddress ?? null,
      rowNumbers: sorted.map((s) => s.rowNumber),
      mergedCount: sorted.length,
    })
  }
  return result
}

// ─── Shipment confirmation message ────────────────────────────────────────

type CopyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "copied" }
  | { status: "error"; message: string }

function CopyShipmentMessageButton({ record }: { record: DisplayShipment }) {
  const [state, setState] = useState<CopyState>({ status: "idle" })
  const templates = useMessageTemplates()
  const businessProfile = useBusinessProfile()

  useEffect(() => {
    if (state.status === "idle") return
    const delay = state.status === "error" ? 3000 : 1500
    const timer = setTimeout(() => setState({ status: "idle" }), delay)
    return () => clearTimeout(timer)
  }, [state.status])

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    setState({ status: "loading" })
    try {
      // Skip the customer fetch when the shipment carries its own temp address —
      // we already have the address we need on the row.
      const detail = record.tempAddress
        ? null
        : await fetch(`/api/sheets/customer?id=${encodeURIComponent(record.customer)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
      const message = buildShipmentConfirmMessage({
        event: record.event,
        customer: record.customer,
        // Prefer the one-time temp address if this shipment was sent to it,
        // so a re-copy months later still shows where the box actually went.
        dataDiri: record.tempAddress ?? detail?.dataDiri ?? "",
        // The `invoicing` field already prefixes merged-event lines with
        // "[event]" so the customer can tell which event each item came from.
        items: record.invoicing.split("\n").filter(Boolean),
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
      className={`p-1 transition-colors rounded disabled:opacity-50 ${
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

// ─── LabelModal ───────────────────────────────────────────────────────────

function LabelModal({
  record,
  onClose,
}: {
  record: ShippingRecord
  onClose: () => void
}) {
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false

    async function generate() {
      try {
        // Skip the customer fetch when the shipment already carries a temp
        // address — we don't need the customer profile in that case.
        const detail = record.tempAddress
          ? null
          : await fetch(`/api/sheets/customer?id=${encodeURIComponent(record.customer)}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
        const blob = await generateShippingLabel({
          event: record.event,
          customer: record.customer,
          shippingId: record.shippingId,
          // The temp address is what was actually printed at ship time, so
          // reprints render it verbatim — even if the customer's permanent
          // address has changed since.
          dataDiri: record.tempAddress ?? detail?.dataDiri ?? "",
          packingLines: record.invoicing.split("\n").filter(Boolean),
        })
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setPdfUrl(url)
      } catch {
        if (!cancelled) setError("Gagal membuat label")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    generate()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [record])

  useModalDismiss(onClose)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border shrink-0">
          <div className="text-sm font-semibold text-foreground">Label Pengiriman</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(record.customer).toUpperCase()} · {record.event}
            <span className="ml-2 font-mono">#{record.shippingId}</span>
          </div>
        </div>

        {loading && (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-gray-400">
            Membuat label…
          </div>
        )}
        {error && (
          <div className="flex-1 flex items-center justify-center py-16 text-sm text-red-500">
            {error}
          </div>
        )}
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            title="Label Pengiriman"
            className="flex-1 w-full border-0 min-h-0"
            style={{ minHeight: "400px" }}
          />
        )}

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2 shrink-0">
          {pdfUrl && (
            <a
              href={pdfUrl}
              download={`label-${record.shippingId}.pdf`}
              className="px-3 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand transition-colors"
            >
              Download PDF
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 transition-colors"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EditResiModal ────────────────────────────────────────────────────────

function EditResiModal({
  record,
  onClose,
  onSaved,
}: {
  record: ShippingRecord
  onClose: () => void
  onSaved: (trackingNumber: string) => void
}) {
  const [value, setValue] = useState(record.trackingNumber)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useModalDismiss(onClose)

  async function handleSave() {
    if (value === record.trackingNumber) { onClose(); return }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, trackingNumber: value }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved(value)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan")
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave()
    if (e.key === "Escape") onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border">
          <div className="text-sm font-semibold text-foreground">Edit Nomor Resi</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(record.customer).toUpperCase()} · <span className="font-mono">#{record.shippingId}</span>
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-2">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            placeholder="Masukkan nomor resi"
            className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors disabled:opacity-50"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EditTempAddressModal ─────────────────────────────────────────────────

function EditTempAddressModal({
  record,
  onClose,
  onSaved,
}: {
  record: ShippingRecord
  onClose: () => void
  onSaved: (tempAddress: string | null) => void
}) {
  const [value, setValue] = useState(record.tempAddress ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textareaRef.current?.focus() }, [])
  useModalDismiss(onClose)

  async function persist(next: string | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/sheets/shipments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: record.rowNumber, tempAddress: next }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed")
      onSaved(next)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan")
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    const trimmed = value.trim()
    const next = trimmed === "" ? null : trimmed
    if (next === (record.tempAddress ?? null)) { onClose(); return }
    await persist(next)
  }

  async function handleClear() {
    if (!record.tempAddress) { onClose(); return }
    if (!confirm("Hapus alamat sementara? Label berikutnya akan pakai alamat utama customer.")) return
    await persist(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl border border-cream-border w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="px-5 py-4 border-b border-cream-border">
          <div className="text-sm font-semibold text-foreground">
            {record.tempAddress ? "Edit Alamat Sementara" : "Set Alamat Sementara"}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {displayIg(record.customer).toUpperCase()} · <span className="font-mono">#{record.shippingId}</span>
          </div>
        </div>

        <div className="px-5 py-4 flex flex-col gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            rows={6}
            placeholder={"Nama Penerima\nAlamat lengkap\nNo. telepon"}
            className="w-full border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-500 transition-colors disabled:opacity-50 resize-none"
          />
          <p className="text-[11px] text-gray-400">
            Alamat utama customer tidak berubah. Kosongkan untuk pakai alamat utama lagi.
          </p>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-cream-border flex justify-end gap-2">
          {record.tempAddress && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="mr-auto px-3 py-1.5 rounded-lg border border-cream-border text-red-500 text-xs font-medium hover:border-red-400 hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              Hapus
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg border border-cream-border text-gray-600 text-xs font-medium hover:border-brand hover:text-brand disabled:opacity-50 transition-colors"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Menyimpan…" : "Simpan"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────

export default function ShipmentsClient() {
  const [data, setData] = useState<ShippingRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [printingPdf, setPrintingPdf] = useState(false)
  const [labelRecord, setLabelRecord] = useState<DisplayShipment | null>(null)
  const [editResiRecord, setEditResiRecord] = useState<DisplayShipment | null>(null)
  const [invoiceCustomer, setInvoiceCustomer] = useState<string | null>(null)
  const [editTempRecord, setEditTempRecord] = useState<DisplayShipment | null>(null)
  // Bound the default fetch to recent shipments so the payload stays small as
  // history grows; "all" loads everything on demand.
  const [windowDays, setWindowDays] = useState<string>("1")
  const [windowFilterOpen, setWindowFilterOpen] = useState(false)
  const windowFilterRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!windowFilterOpen) return
    const h = (e: MouseEvent) => { if (!windowFilterRef.current?.contains(e.target as Node)) setWindowFilterOpen(false) }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [windowFilterOpen])

  async function load(days: string = windowDays) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/sheets/shipments?days=${encodeURIComponent(days)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Failed to load")
      setData(json as ShippingRecord[])
      setRowSelection({})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setLoading(false)
    }
  }

  // Refetch whenever the window changes (and on mount).
  useEffect(() => { load(windowDays) }, [windowDays])

  // Merged ("Ship together") rows are collapsed into one combined grid entry.
  const displayData = useMemo(() => (data ? collapseMerged(data) : []), [data])

  const selectedCount = Object.keys(rowSelection).filter((k) => rowSelection[k]).length

  async function handlePrintPdf() {
    if (selectedCount === 0) return
    const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k])
    const selected = displayData.filter((r) => selectedIds.includes(String(r.rowNumber)))
    if (selected.length === 0) return
    setPrintingPdf(true)
    try {
      // Only customers whose selected shipments have no temp address need a
      // profile lookup — for the rest, the row already carries the address
      // that was printed at ship time.
      const customersNeedingProfile = [
        ...new Set(selected.filter((r) => !r.tempAddress).map((r) => r.customer)),
      ]
      const detailEntries = await Promise.all(
        customersNeedingProfile.map(async (id) => {
          try {
            const res = await fetch(`/api/sheets/customer?id=${encodeURIComponent(id)}`)
            return [id, res.ok ? await res.json() : null] as const
          } catch {
            return [id, null] as const
          }
        })
      )
      const detailMap = Object.fromEntries(detailEntries)
      const labels: ShippingLabelParams[] = selected.map((r) => ({
        event: r.event,
        customer: r.customer,
        shippingId: r.shippingId,
        dataDiri: r.tempAddress ?? detailMap[r.customer]?.dataDiri ?? "",
        packingLines: r.invoicing.split("\n").filter(Boolean),
      }))
      const blob = await generateMultipleShippingLabels(labels)
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download = `labels-${new Date().toISOString().slice(0, 10)}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to generate PDF")
    } finally {
      setPrintingPdf(false)
    }
  }

  const columns = useMemo<ColumnDef<DisplayShipment, unknown>[]>(
    () => [
      {
        accessorKey: "shippingId",
        header: "ID",
        filterFn: "textContains",
        size: 80,
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-gray-500">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "event",
        header: "Event",
        filterFn: "textContains",
        size: 120,
        cell: ({ row, getValue }) => (
          <span className="flex items-center gap-1.5 flex-wrap">
            <span>{getValue<string>()}</span>
            {row.original.mergedCount > 1 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">
                Gabung
              </span>
            )}
          </span>
        ),
      },
      {
        accessorKey: "customer",
        header: "Customer",
        filterFn: "textContains",
        size: 180,
        cell: ({ row }) => {
          const r = row.original
          return (
            <span className="inline-flex items-center gap-1.5">
              <span className="line-clamp-2">{displayIg(r.customer)}</span>
              {r.tempAddress ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setEditTempRecord(r) }}
                  title={`Alamat sementara:\n${r.tempAddress}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-700 hover:bg-purple-200 transition-colors"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  Alamat sementara
                </button>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setEditTempRecord(r) }}
                  title="Set alamat sementara untuk shipment ini"
                  className="p-0.5 rounded text-gray-300 hover:text-purple-600 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                </button>
              )}
            </span>
          )
        },
      },
      {
        accessorKey: "customerName",
        header: "Name",
        filterFn: "textContains",
        size: 160,
        cell: ({ getValue }) => {
          const v = getValue<string>()
          return <span className={`line-clamp-2 ${v ? "" : "text-gray-400"}`}>{v || "—"}</span>
        },
      },
      {
        accessorKey: "invoicing",
        header: "Items",
        filterFn: "textContains",
        size: 220,
        enableSorting: false,
        cell: ({ getValue }) => (
          <span className="whitespace-pre-wrap font-sans text-xs text-gray-600 leading-relaxed max-w-[200px] line-clamp-2">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: "weightEstimation",
        header: "Berat",
        filterFn: "numeric",
        size: 90,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">{fmt(getValue<number>())} kg</span>
        ),
      },
      {
        accessorKey: "ongkirTotal",
        header: "Ongkir",
        filterFn: "numeric",
        size: 120,
        meta: { align: "right" },
        cell: ({ getValue }) => (
          <span className="whitespace-nowrap">Rp {fmt(getValue<number>())}</span>
        ),
      },
      {
        accessorKey: "isLastShipment",
        header: "Terakhir",
        filterFn: "boolean",
        size: 90,
        cell: ({ getValue }) =>
          getValue<boolean>() ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              Ya
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
              Tidak
            </span>
          ),
      },
      {
        accessorKey: "trackingNumber",
        header: "Resi",
        filterFn: "textContains",
        size: 200,
        cell: ({ row }) => {
          const record = row.original
          return (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setEditResiRecord(record) }}
              className="group flex items-center gap-1.5 text-left"
            >
              <span
                className={`text-xs ${record.trackingNumber ? "text-foreground font-mono" : "text-gray-400 italic"}`}
              >
                {record.trackingNumber || "Belum diisi"}
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-400 group-hover:text-brand transition-colors shrink-0"
              >
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
              </svg>
            </button>
          )
        },
      },
      {
        accessorKey: "createdAt",
        header: "Tanggal",
        filterFn: "dateRange",
        // Display shows the localized DD/MM/YYYY string; the dateRange filter
        // normalizes it, and sort uses the real epoch (the localized string
        // doesn't sort chronologically as text).
        sortingFn: (a, b) => a.original.createdAtTs - b.original.createdAtTs,
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-gray-400 whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: "Diperbarui",
        enableHiding: true,
        sortingFn: (a, b) => a.original.updatedAtTs - b.original.updatedAtTs,
        size: 160,
        cell: ({ getValue }) => (
          <span className="text-xs text-gray-400 whitespace-nowrap">{getValue<string>()}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        size: 72,
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <CopyShipmentMessageButton record={row.original} />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setLabelRecord(row.original) }}
              title="Lihat label pengiriman"
              className="p-1 text-gray-400 hover:text-brand transition-colors rounded"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        ),
      },
    ],
    []
  )

  const renderMobileCard = useCallback((r: DisplayShipment) => (
    <div className="rounded-xl border border-cream-border bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{r.event}</span>
            <span className="text-xs text-gray-400 uppercase truncate">{displayIg(r.customer)}</span>
            {r.mergedCount > 1 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">Gabung</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <CopyShipmentMessageButton record={r} />
          <button type="button" onClick={(e) => { e.stopPropagation(); setLabelRecord(r) }} title="Lihat label pengiriman" className="p-1 text-gray-400 hover:text-brand transition-colors rounded">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>
      <div className="text-xs text-gray-500 tabular-nums">
        {fmt(r.weightEstimation)} KG · Rp {fmt(r.ongkirTotal)}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setEditResiRecord(r) }}
        className="group flex items-center justify-between gap-1.5 text-left pt-2.5 border-t border-cream-border"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`text-xs truncate ${r.trackingNumber ? "text-foreground font-mono" : "text-gray-400 italic"}`}>
            {r.trackingNumber || "Resi belum diisi"}
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 group-hover:text-brand transition-colors shrink-0">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
          </svg>
        </span>
        <span className="text-xs text-gray-400 font-mono shrink-0">{r.shippingId}</span>
      </button>
    </div>
  ), [])

  const toolbarExtra = (
    <>
      {/* Desktop: full dropdown. */}
      <div className="hidden md:block w-40 shrink-0" title="Rentang waktu shipment yang dimuat">
        <SearchableSelect
          value={windowDays}
          onChange={setWindowDays}
          options={WINDOW_OPTIONS}
          disabled={loading}
          searchable={false}
        />
      </div>
      {/* Mobile: icon-only trigger + options popover, so the row stays compact. */}
      <div className="md:hidden relative shrink-0" ref={windowFilterRef}>
        <button
          type="button"
          onClick={() => setWindowFilterOpen((o) => !o)}
          disabled={loading}
          aria-label="Filter time window"
          className="inline-flex items-center h-[38px] px-3 rounded-lg border border-cream-border bg-white text-sm text-gray-600 active:border-brand active:text-brand disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
        </button>
        {windowFilterOpen && (
          <div className="absolute right-0 top-full mt-1 z-30 w-40 rounded-lg border border-cream-border bg-white shadow-lg p-1.5 flex flex-col">
            {WINDOW_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => { setWindowDays(value); setWindowFilterOpen(false) }}
                className={`text-left px-2.5 py-1.5 rounded-md text-sm transition-colors ${windowDays === value ? "bg-brand-light text-brand font-medium" : "text-gray-600 hover:bg-cream"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )

  const printButton = (
    <button
      type="button"
      onClick={handlePrintPdf}
      disabled={printingPdf || selectedCount === 0}
      className="shrink-0 inline-flex items-center gap-1.5 h-[38px] text-sm font-medium text-white bg-brand hover:bg-brand/90 disabled:opacity-50 transition-colors px-3 rounded-lg whitespace-nowrap"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
      >
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
      <span className="hidden sm:inline">
        {printingPdf ? "Generating…" : `Print ${selectedCount} Label${selectedCount === 1 ? "" : "s"}`}
      </span>
      <span className="sm:hidden inline-block min-w-[1.5rem] text-center tabular-nums">{printingPdf ? "…" : selectedCount}</span>
    </button>
  )

  return (
    <div className="flex flex-col gap-4">
      {loading && <TableSkeleton />}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {!loading && !error && data && (
        <DataGrid<DisplayShipment>
          data={displayData}
          columns={columns}
          getRowId={(row) => String(row.rowNumber)}
          searchPlaceholder="Cari shipment…"
          fullWidthSearch
          tightToolbar
          boldUppercaseHeader
          hideRowCount
          toolbarExtra={toolbarExtra}
          toolbarExtraEnd={printButton}
          enableRowSelection
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onRowClick={(row) => setInvoiceCustomer(row.customer)}
          initialVisibility={{ updatedAt: false, isLastShipment: false, createdAt: false }}
          initialSorting={[{ id: "createdAt", desc: true }]}
          renderMobileCard={renderMobileCard}
          paginationVariant="simple"
        />
      )}
      {!loading && !error && data && data.length === 0 && windowDays !== "all" && (
        <div className="text-center text-sm text-gray-400 -mt-1">
          Tidak ada shipment dalam rentang ini.{" "}
          <button
            type="button"
            onClick={() => setWindowDays("all")}
            className="font-medium text-brand hover:underline"
          >
            Muat semua shipment
          </button>
        </div>
      )}

      {invoiceCustomer && (
        <InvoiceDetailDrawer
          customer={invoiceCustomer}
          onClose={() => setInvoiceCustomer(null)}
        />
      )}
      {labelRecord && (
        <LabelModal record={labelRecord} onClose={() => setLabelRecord(null)} />
      )}
      {editResiRecord && (
        <EditResiModal
          record={editResiRecord}
          onClose={() => setEditResiRecord(null)}
          onSaved={(trackingNumber) =>
            setData((prev) =>
              prev?.map((r) =>
                editResiRecord.rowNumbers.includes(r.rowNumber) ? { ...r, trackingNumber } : r
              ) ?? null
            )
          }
        />
      )}
      {editTempRecord && (
        <EditTempAddressModal
          record={editTempRecord}
          onClose={() => setEditTempRecord(null)}
          onSaved={(tempAddress) =>
            setData((prev) =>
              prev?.map((r) =>
                editTempRecord.rowNumbers.includes(r.rowNumber) ? { ...r, tempAddress } : r
              ) ?? null
            )
          }
        />
      )}
    </div>
  )
}
