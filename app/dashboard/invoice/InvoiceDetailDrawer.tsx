"use client"

import { useEffect, useState } from "react"
import { displayIg } from "@/lib/format"
import type { InvoiceResult } from "@/lib/db"
import { useModalDismiss } from "@/hooks/useModalDismiss"
import { EventCard } from "./EventCard"

// ─── Invoice Detail Drawer ───────────────────────────────────────────────────

export function InvoiceDetailDrawer({
  customer,
  onClose,
}: {
  customer: string
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InvoiceResult | null>(null)
  // Bumped to re-run the fetch effect when a child component (e.g. Add
  // Adjustment modal) reports a server-side mutation we need to reflect.
  const [reloadKey, setReloadKey] = useState(0)

  useModalDismiss(onClose)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    fetch(`/api/sheets/invoice?customer=${encodeURIComponent(customer)}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Failed to load")
        return data as InvoiceResult
      })
      .then((data) => { if (!cancelled) setResult(data) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [customer, reloadKey])

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 transition-opacity" />
      <div
        className="relative w-full max-w-3xl h-full bg-cream shadow-2xl border-l border-cream-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-cream-border bg-white shrink-0 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground truncate">
              {displayIg(result?.customer || customer)}
            </div>
            {result && (
              <div className="text-xs text-gray-400 mt-0.5">
                {result.events.length} event{result.events.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-foreground transition-colors p-1 rounded shrink-0"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
              Loading invoice…
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && result && result.events.length === 0 && (
            <div className="rounded-xl border border-cream-border bg-white p-8 text-center text-gray-400 text-sm">
              No orders found for &quot;{customer}&quot;.
            </div>
          )}

          {result && result.events.length > 0 && (
            <div className="flex flex-col gap-4">
              {result.events.map((ev) => (
                <EventCard
                  key={ev.eventId}
                  event={ev}
                  customer={result.customer}
                  customerDetail={result.customerDetail}
                  onMutated={() => setReloadKey((k) => k + 1)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
