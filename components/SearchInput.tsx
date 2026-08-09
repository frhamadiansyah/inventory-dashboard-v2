"use client"

/** Shared search box: magnifier icon left, clear (×) button right when non-empty. */
export default function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
  /** Tighter vertical padding to match toolbar buttons (e.g. inside DataGrid). */
  dense = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  dense?: boolean
}) {
  return (
    <div className={`relative ${className}`}>
      <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full border border-cream-border rounded-lg pl-8 pr-8 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors ${dense ? "h-[34px] py-0 text-xs" : "py-2 text-sm"}`}
      />
      {Boolean(value) && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-brand transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  )
}
