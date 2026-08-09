"use client"

import PageHeader from "@/components/PageHeader"

// Catches a rejected dashboard-summary query. This is a Client Component (error
// boundaries must be), so it must NOT render PageShell: PageShell pulls in the
// async Server Components Sidebar/MobileNav, which call auth()/headers(). Those
// can't run under a client boundary ("headers was called outside a request
// scope") — doing so crashes the error page itself and hides the real error.
//
// There's no app/dashboard/layout.tsx, so the nav normally comes from each
// page's own PageShell. When the page throws, that shell is gone too, so the
// error state renders standalone (no sidebar) — acceptable for an error screen.
// reset() re-runs the segment (and its query), the equivalent of a Retry.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main className="min-h-screen bg-cream px-4 py-6 md:px-6 md:py-10">
      <PageHeader title="Dashboard" subtitle="What needs your attention" />
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>{error.message || "Failed to load"}</span>
        <button
          onClick={reset}
          className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-100 transition-colors shrink-0"
        >
          Retry
        </button>
      </div>
    </main>
  )
}
