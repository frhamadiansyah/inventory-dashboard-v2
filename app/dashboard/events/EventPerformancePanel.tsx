import type { EventPerformance } from "@/lib/db"
import { fmt } from "@/lib/format"

const rp = (n: number) => `Rp ${fmt(n)}`

/** Read-only mini-dashboard for a single event. Rendered inside the expandable
 *  row (desktop) and expandable card (mobile) on the Events page. Pure
 *  presentation — data comes from getEventPerformance() upstream. */
export default function EventPerformancePanel({ perf }: { perf: EventPerformance | undefined }) {
  if (!perf || !perf.hasActivity) {
    return (
      <div className="px-4 py-6 text-center text-sm text-gray-400">No activity yet</div>
    )
  }

  const { totalUnits } = perf
  const pct = (n: number) => (totalUnits > 0 ? Math.round((n / totalUnits) * 100) : 0)
  const profitPositive = perf.netProfit >= 0

  return (
    <div className="flex flex-col gap-4 pt-4 pr-4 pb-4 pl-[38px] md:pl-12">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Fulfillment */}
        <StatGroup title="Fulfillment" accent="sm:border-l-brand">
          <Bar label="Bought" value={perf.totalBought} pct={pct(perf.totalBought)} />
          <Bar label="Arrived" value={perf.totalArrived} pct={pct(perf.totalArrived)} />
          <Bar label="Shipped" value={perf.totalShipped} pct={pct(perf.totalShipped)} />
        </StatGroup>

        {/* Sales */}
        <StatGroup title="Sales" accent="sm:border-l-amber-500">
          <Stat label="Customers" value={fmt(perf.customerCount)} />
          <Stat label="Items" value={fmt(perf.totalUnits)} />
          <Stat label="Unpaid invoices" value={fmt(perf.unpaidCount)} />
          <Stat label="Overpaid invoices" value={fmt(perf.overpaidCount)} />
          <Stat label="Average rate" value={perf.kurs > 0 ? fmt(perf.kurs) : "—"} />
        </StatGroup>

        {/* Finance */}
        <StatGroup title="Finance" accent="sm:border-l-rose-500">
          <Stat label="Paid" value={rp(perf.totalPaid)} />
          <Stat label="Outstanding" value={rp(perf.outstanding)} className={perf.outstanding > 0 ? "text-red-600" : undefined} />
          <Stat label="Overpayment" value={rp(perf.dueRefund)} className={perf.dueRefund > 0 ? "text-blue-600" : undefined} />
          <Stat label="Operational expenses" value={rp(perf.opsExpenses)} />
          <Stat
            label="Profit estimation"
            value={rp(perf.netProfit)}
            strong
            className={profitPositive ? "text-emerald-600" : "text-red-600"}
          />
        </StatGroup>
      </div>
    </div>
  )
}

function StatGroup({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div className={`flex h-full flex-col gap-2 sm:rounded-xl sm:border sm:border-cream-border sm:border-l-4 ${accent} sm:bg-white sm:px-5 sm:py-4`}>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{title}</div>
      <div className="flex flex-1 flex-col justify-between gap-1.5">{children}</div>
    </div>
  )
}

function Stat({ label, value, strong, className }: { label: string; value: string; strong?: boolean; className?: string }) {
  // className (when given) carries its own text color — omit the default
  // text-foreground so it can't lose a same-specificity cascade fight against
  // an override color like text-blue-600/text-red-600 (Tailwind utility order
  // isn't guaranteed to favor the one written last in the class string).
  const colorCls = className ?? "text-foreground"
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`tabular-nums ${strong ? "text-sm font-semibold" : "text-sm"} ${colorCls}`}>
        {value}
      </span>
    </div>
  )
}

function Bar({ label, value, pct }: { label: string; value: number; pct: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-gray-500">{label}</span>
        <span className="text-xs tabular-nums text-gray-500">{fmt(value)} · {pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-cream">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}
