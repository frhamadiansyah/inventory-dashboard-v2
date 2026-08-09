"use client"

import { use } from "react"
import Link from "next/link"
import type { DashboardSummary, DashboardEvent, DashboardTotals } from "@/lib/db"

function formatRp(n: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`
}

// Compact magnitude for small screens: K (thousands), M (millions), B (billions).
function abbreviate(n: number): string {
  const abs = Math.abs(n)
  const one = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 1 })
  if (abs >= 1e9) return `${one(n / 1e9)}B`
  if (abs >= 1e6) return `${one(n / 1e6)}M`
  if (abs >= 1e3) return `${one(n / 1e3)}K`
  return `${n}`
}

function formatRpShort(n: number): string {
  return `Rp ${abbreviate(n)}`
}

function pct(num: number, denom: number): number {
  if (denom <= 0) return 0
  return Math.min(100, Math.round((num / denom) * 100))
}

type ActionItem = {
  count: number
  label: string
  href: string
  tone: "yellow" | "blue" | "orange" | "green" | "red" | "purple"
}

const TONE_CLASSES: Record<ActionItem["tone"], string> = {
  yellow: "bg-yellow-50 border-yellow-200 text-yellow-800 hover:bg-yellow-100",
  blue: "bg-blue-50 border-blue-200 text-blue-800 hover:bg-blue-100",
  orange: "bg-orange-50 border-orange-200 text-orange-800 hover:bg-orange-100",
  green: "bg-green-50 border-green-200 text-green-800 hover:bg-green-100",
  red: "bg-red-50 border-red-200 text-red-800 hover:bg-red-100",
  purple: "bg-purple-50 border-purple-200 text-purple-800 hover:bg-purple-100",
}

export default function DashboardClient({
  summaryPromise,
}: {
  summaryPromise: Promise<DashboardSummary>
}) {
  // Resolves the promise streamed from the server component. While it's
  // pending the parent <Suspense> shows the loading card; on rejection it
  // throws to the route's error boundary (error.tsx), which offers a retry.
  const summary = use(summaryPromise)

  const items: ActionItem[] = ([
    { count: summary.actionQueue.overpaymentCandidates, label: "overpayments to refund", href: "/dashboard/refunds", tone: "yellow" },
    { count: summary.actionQueue.refundsReadyToTransfer, label: "refunds ready to transfer", href: "/dashboard/refunds", tone: "orange" },
    { count: summary.actionQueue.itemsPendingPurchase, label: "items pending purchase", href: "/dashboard/shopping-list", tone: "green" },
    { count: summary.actionQueue.paymentsUnverified, label: "payment deposits unverified", href: "/dashboard/payments", tone: "blue" },
    { count: summary.actionQueue.customersReadyToShip, label: "invoices ready to ship", href: "/dashboard/ship", tone: "purple" },
  ] satisfies ActionItem[]).filter((item) => item.count > 0)

  return (
    <div className="flex flex-col gap-6">
      {/* At-a-glance totals */}
      <StatCards totals={summary.totals} />

      {/* Action queue */}
      {items.length === 0 ? (
        <div className="rounded-xl border border-cream-border bg-white p-8 text-center">
          <div className="text-2xl mb-2">🎉</div>
          <p className="text-sm font-medium text-foreground">All caught up</p>
          <p className="text-xs text-gray-500 mt-1">No pending actions across the pipeline.</p>
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">Action queue</h2>
            <span className="text-xs text-gray-400">{items.reduce((s, i) => s + i.count, 0)} pending</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {items.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border transition-colors ${TONE_CLASSES[item.tone]}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-2xl font-bold tabular-nums shrink-0">{item.count}</span>
                  <span className="text-sm truncate">{item.label}</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Active events */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">Active events</h2>
          <span className="text-xs text-gray-400">
            {summary.events.length} {summary.events.length === 1 ? "event" : "events"} in pipeline
          </span>
        </div>
        {summary.events.length === 0 ? (
          <div className="rounded-xl border border-cream-border bg-white p-6 text-center text-sm text-gray-400">
            No active events.
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summary.events.map((ev) => <EventCard key={ev.name} event={ev} />)}
          </div>
        )}
      </section>
    </div>
  )
}

function StatCards({ totals }: { totals: DashboardTotals }) {
  const invoiceSub = (n: number) => `from ${n} ${n === 1 ? "invoice" : "invoices"}`
  const cards = [
    {
      label: "Items sold",
      amount: totals.itemsSold,
      money: false,
      sub: `across ${totals.eventCount} ${totals.eventCount === 1 ? "event" : "events"}`,
      tone: "bg-blue-100 text-blue-600",
      icon: (
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8 M8 9h2" />
      ),
    },
    {
      label: "Omzet",
      amount: totals.omzet,
      money: true,
      sub: invoiceSub(totals.invoiceCount),
      tone: "bg-green-100 text-green-600",
      icon: (
        <path d="M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      ),
    },
    {
      label: "Outstanding",
      amount: totals.outstanding,
      money: true,
      sub: invoiceSub(totals.outstandingCount),
      tone: "bg-orange-100 text-orange-600",
      icon: (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </>
      ),
    },
    {
      label: "Overpayment",
      amount: totals.refundNeeded,
      money: true,
      sub: invoiceSub(totals.refundCount),
      tone: "bg-rose-100 text-rose-600",
      icon: (
        <>
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </>
      ),
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => {
        const full = c.money ? formatRp(c.amount) : new Intl.NumberFormat("id-ID").format(c.amount)
        // Only money cards abbreviate on small screens; item counts are small
        // enough to always show in full.
        const short = c.money ? formatRpShort(c.amount) : full
        return (
          <div key={c.label} className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${c.tone}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {c.icon}
                </svg>
              </span>
              <span className="text-sm font-bold text-foreground truncate">{c.label}</span>
            </div>
            <span className="text-2xl font-bold text-foreground tabular-nums leading-tight truncate">
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{full}</span>
            </span>
            {"sub" in c && c.sub && (
              <span className="text-xs text-gray-400 tabular-nums truncate">{c.sub}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EventCard({ event }: { event: DashboardEvent }) {
  const stages = [
    { label: "Bought", num: event.totalBought, denom: event.totalUnits, color: "bg-green-500" },
    { label: "Arrived", num: event.totalArrived, denom: event.totalUnits, color: "bg-blue-500" },
    { label: "Shipped", num: event.totalShipped, denom: event.totalUnits, color: "bg-purple-500" },
  ]

  return (
    <div className="rounded-xl border border-cream-border bg-white p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-foreground truncate">{event.name}</span>
        {event.eta && <span className="text-xs text-gray-400 shrink-0">{event.eta}</span>}
      </div>

      <div className="flex flex-nowrap items-baseline gap-x-2 text-[11px] text-gray-500">
        <span className="whitespace-nowrap"><span className="font-medium text-foreground">{event.customerCount}</span> customers</span>
        <span className="whitespace-nowrap"><span className="font-medium text-foreground">{event.totalUnits}</span> units</span>
        <span className="ml-auto whitespace-nowrap tabular-nums">
          <span className="text-foreground font-medium">{formatRp(event.totalPaid)}</span>
          <span className="text-gray-400"> / {formatRp(event.totalSubtotal)}</span>
        </span>
      </div>

      <div className="grid grid-cols-[auto_1fr_6.5rem] items-center gap-x-2 gap-y-1.5 text-xs">
        {stages.map((s) => {
          const p = pct(s.num, s.denom)
          return (
            <div key={s.label} className="contents">
              <span className="text-gray-500">{s.label}</span>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full ${s.color} transition-all`} style={{ width: `${p}%` }} />
              </div>
              <span className="whitespace-nowrap text-right tabular-nums text-gray-600">
                {s.num}<span className="text-gray-400">/{s.denom}</span>
                <span className="text-gray-400 ml-1">({p}%)</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
