"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, type ReactNode } from "react"
import type { Role } from "@/lib/roles"
import SidebarClient from "./SidebarClient"

type Tab = { href: string; label: string; roles: Role[]; icon: ReactNode }
type User = { name?: string | null; email?: string | null; role: Role | null }

const TABS: Tab[] = [
  {
    href: "/dashboard/products",
    label: "Products",
    roles: ["owner"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>
    ),
  },
  {
    href: "/dashboard/list-order",
    label: "Order",
    roles: ["admin", "owner"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3" /><path d="M9 12h6" /><path d="M9 16h6" /></svg>
    ),
  },
  {
    href: "/dashboard/payments",
    label: "Payments",
    roles: ["admin", "owner"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2" /><line x1="1" y1="10" x2="23" y2="10" /></svg>
    ),
  },
  {
    href: "/dashboard/shopping-list",
    label: "Shopping",
    roles: ["admin", "owner"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></svg>
    ),
  },
]

export default function MobileNavClient({ user }: { user: User }) {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)

  // Close the drawer whenever navigation happens.
  useEffect(() => {
    setMoreOpen(false)
  }, [pathname])

  const role = user.role
  if (role === null) return null
  const tabs = TABS.filter((t) => t.roles.includes(role))

  return (
    <>
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-30 flex border-t border-cream-border bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + "/")
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${active ? "text-brand" : "text-gray-400"}`}
            >
              {t.icon}
              {t.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${moreOpen ? "text-brand" : "text-gray-400"}`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
          More
        </button>
      </nav>

      {/* Full nav drawer — all other pages (render desktop layout, scrollable) */}
      {moreOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <SidebarClient user={user} />
          </div>
        </div>
      )}
    </>
  )
}
