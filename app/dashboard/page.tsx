import { Suspense } from "react"
import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DashboardClient from "./DashboardClient"
import { getDashboardSummary } from "@/lib/db"

// Render per-request so the summary is always fresh and the query never runs
// at build time (matches the old client fetch's `no-store` semantics).
export const dynamic = "force-dynamic"

export default function DashboardPage() {
  // Kick off the query during server render (don't await). The shell, header,
  // and sidebar stream out immediately; the summary HTML streams in when the
  // promise resolves. This replaces the old client-side fetch waterfall, which
  // booted a second serverless function and re-ran auth before any query began.
  const summaryPromise = getDashboardSummary()

  return (
    <PageShell>
      <PageHeader title="Dashboard" subtitle="What needs your attention" />
      <Suspense fallback={<DashboardLoading />}>
        <DashboardClient summaryPromise={summaryPromise} />
      </Suspense>
    </PageShell>
  )
}

function DashboardLoading() {
  return (
    <div className="rounded-xl border border-cream-border bg-white p-12 text-center text-sm text-gray-400">
      Loading…
    </div>
  )
}
