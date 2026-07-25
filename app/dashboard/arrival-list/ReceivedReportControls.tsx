"use client"

import { useState } from "react"
import { fetchJson } from "@/lib/api-fetch"
import { generateReceivedReport } from "@/lib/receiving-report-pdf"
import { useSheetOptions } from "@/hooks/useSheetOptions"
import EventSelect from "@/components/EventSelect"
import type { ReceivedReportItem } from "@/lib/db"

const INPUT_CLASS =
  "border border-cream-border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

// Today in Asia/Jakarta as YYYY-MM-DD (matches the server-side default), so the
// picker caps on the business day regardless of the browser's timezone.
function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date())
}

type Report = {
  event: string
  from: string | null
  to: string | null
  items: ReceivedReportItem[]
  totalUnits: number
}

export default function ReceivedReportControls() {
  const today = jakartaToday()
  const options = useSheetOptions()
  const [event, setEvent] = useState("")
  // Dates are optional: empty means every date for the selected event.
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Order the range so a reversed selection still works (mirrors the API).
  const start = from && to ? (from <= to ? from : to) : from
  const end = from && to ? (from <= to ? to : from) : to

  async function download() {
    if (!event) return
    setLoading(true)
    setMessage(null)
    try {
      const query = new URLSearchParams({ event })
      if (start) query.set("from", start)
      if (end) query.set("to", end)
      const report = await fetchJson<Report>(`/api/sheets/receiving-report?${query.toString()}`)
      if (report.items.length === 0) {
        const span =
          report.from && report.to
            ? report.from === report.to
              ? ` on ${report.from}`
              : ` between ${report.from} and ${report.to}`
            : ""
        setMessage(`No items were received for ${report.event}${span}.`)
        return
      }
      const blob = await generateReceivedReport(report)
      const url = URL.createObjectURL(blob)
      try {
        const datePart =
          report.from && report.to
            ? report.from === report.to
              ? `-${report.from}`
              : `-${report.from}_to_${report.to}`
            : ""
        const a = document.createElement("a")
        a.href = url
        a.download = `received-${report.event}${datePart}.pdf`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to generate report")
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
        type="date"
        value={from}
        max={today}
        onChange={(e) => setFrom(e.target.value)}
        aria-label="From date (optional)"
        className={`${INPUT_CLASS} h-[38px] appearance-none flex-1 min-w-0 sm:min-w-[140px]`}
      />
      <span className="shrink-0 self-center text-gray-400">–</span>
      <input
        type="date"
        value={to}
        max={today}
        onChange={(e) => setTo(e.target.value)}
        aria-label="To date (optional)"
        className={`${INPUT_CLASS} h-[38px] appearance-none flex-1 min-w-0 sm:min-w-[140px]`}
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
