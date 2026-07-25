"use client"

import { useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { generateCargoDocument, type CargoDocLine } from "@/lib/cargo-document-pdf"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Today in Asia/Jakarta as YYYY-MM-DD, so the document is dated by business day
// regardless of the browser's timezone.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

type DocResponse = { event: string; receipt: string | null; lines: CargoDocLine[] }

export default function DispatchDocControls() {
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  const [receipt, setReceipt] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function download() {
    if (!event) return
    setLoading(true)
    setMessage(null)
    try {
      const query = new URLSearchParams({ event })
      const trimmedReceipt = receipt.trim()
      if (trimmedReceipt) query.set("receipt", trimmedReceipt)
      const doc = await fetchJson<DocResponse>(`/api/sheets/dispatch-report?${query.toString()}`)
      if (doc.lines.length === 0) {
        setMessage(`No dispatched items for ${event}${trimmedReceipt ? ` matching "${trimmedReceipt}"` : ""}.`)
        return
      }
      const title = `${event}${trimmedReceipt ? ` · ${trimmedReceipt}` : ""}`
      const blob = await generateCargoDocument({ name: title, date: jakartaToday(), lines: doc.lines })
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement("a")
        a.href = url
        a.download = `dispatch-${event}${trimmedReceipt ? `-${trimmedReceipt}` : ""}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to generate document")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-cream-border bg-white p-4 flex items-end gap-2 sm:gap-3 flex-wrap">
      <div className="w-full sm:w-auto sm:flex-1 min-w-0 sm:min-w-[200px]">
        <EventSelect
          value={event}
          onChange={(v) => { setEvent(v); setMessage(null) }}
          events={options?.events ?? []}
          placeholder="Select event…"
        />
      </div>
      <input
        type="text"
        value={receipt}
        onChange={(e) => setReceipt(e.target.value)}
        aria-label="Dispatch receipt (optional)"
        placeholder="Receipt (optional)"
        className={`${INPUT_CLASS} h-[38px] flex-1 min-w-0 sm:min-w-[160px]`}
      />
      <button
        type="button"
        onClick={download}
        disabled={loading || !event}
        aria-label="Download PDF"
        title={event ? "Download PDF" : "Select an event first"}
        className="h-[38px] w-[38px] sm:w-auto shrink-0 rounded-lg border border-cream-border bg-white sm:px-4 text-sm font-medium text-gray-600 transition-colors hover:border-brand hover:text-brand disabled:opacity-50 flex items-center justify-center"
      >
        <svg className="sm:hidden" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span className="hidden sm:inline">{loading ? "Preparing…" : "Download PDF"}</span>
      </button>
      {message && <span className="text-sm text-gray-500 basis-full">{message}</span>}
    </div>
  )
}
