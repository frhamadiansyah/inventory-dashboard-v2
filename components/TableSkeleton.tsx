export default function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-3">
        <div className="h-8 w-56 rounded-lg bg-gray-100 animate-pulse" />
        <div className="flex-1" />
        <div className="h-4 w-12 rounded bg-gray-100 animate-pulse" />
        <div className="h-8 w-24 rounded-lg bg-gray-100 animate-pulse" />
      </div>

      {/* Table skeleton */}
      <div className="rounded-xl border border-cream-border bg-white overflow-hidden">
        {/* Header */}
        <div className="border-b border-cream-border bg-cream px-4 py-3 flex gap-6">
          {[40, 80, 60, 70, 50, 60].map((w, i) => (
            <div key={i} className={`h-3 rounded bg-gray-200 animate-pulse`} style={{ width: w }} />
          ))}
        </div>

        {/* Rows */}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="border-b border-cream-border/60 px-4 py-3 flex gap-6 items-center">
            {[40, 80, 60, 70, 50, 60].map((w, j) => (
              <div
                key={j}
                className="h-3 rounded bg-gray-100 animate-pulse"
                style={{ width: w, animationDelay: `${(i * 6 + j) * 30}ms` }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Pagination skeleton */}
      <div className="flex items-center justify-between">
        <div className="h-4 w-24 rounded bg-gray-100 animate-pulse" />
        <div className="flex gap-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 w-8 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  )
}
