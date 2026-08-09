"use client"

// Draft/typed values stay plain dot-decimal numeric strings — callers pass them straight to
// Number() for math and validation — these two only convert at the input's edge, for a live
// id-ID thousand-separator display ("." groups, "," is the decimal point). A value may be
// fractional, so the split is on the decimal point, not just digits.
export function formatMoney(raw: string): string {
  if (raw === "") return ""
  const [intPart, decPart] = raw.split(".")
  const digits = intPart.replace(/\D/g, "")
  const grouped = digits === "" ? "" : Number(digits).toLocaleString("id-ID")
  return decPart !== undefined ? `${grouped},${decPart}` : grouped
}

export function parseMoney(formatted: string): string {
  const commaIdx = formatted.indexOf(",")
  if (commaIdx === -1) return formatted.replace(/\D/g, "")
  const intDigits = formatted.slice(0, commaIdx).replace(/\D/g, "")
  const decDigits = formatted.slice(commaIdx + 1).replace(/\D/g, "")
  return `${intDigits}.${decDigits}`
}

const inputCls =
  "border border-cream-border rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"

/** A currency/percent amount: unit label (any currency code or "Rp" ahead of the number,
 *  "%" after it, like the values they annotate are normally written), live
 *  thousand-separator formatting. */
export default function MoneyInput({
  value,
  onChange,
  placeholder,
  wrapClassName,
  unit = "Rp",
  name,
}: {
  value: string
  onChange: (raw: string) => void
  placeholder?: string
  wrapClassName?: string
  /** "%" renders as a suffix (15%); anything else — "Rp", a country's currency code —
   *  renders as a prefix. */
  unit?: string
  /** autoComplete="off" alone doesn't reliably stop Chrome's autofill on a field with no
   *  name/id — it can key off page structure instead, which is why a stray value can
   *  change across unrelated edits to a page. A distinct name gives it something stable
   *  to (not) match against instead. */
  name?: string
}) {
  const isSuffix = unit === "%"
  return (
    <div className={`relative ${wrapClassName ?? ""}`}>
      <span
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs text-gray-400 ${isSuffix ? "right-2" : "left-2"}`}
      >
        {unit}
      </span>
      <input
        value={formatMoney(value)}
        onChange={(e) => onChange(parseMoney(e.target.value))}
        inputMode="decimal"
        autoComplete="off"
        name={name}
        placeholder={placeholder}
        className={`${inputCls} w-full ${isSuffix ? "pr-6" : "pl-9"}`}
      />
    </div>
  )
}
