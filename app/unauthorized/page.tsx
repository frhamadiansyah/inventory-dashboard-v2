import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { signOutAction } from "@/lib/auth-actions"

export default async function UnauthorizedPage() {
  const session = await auth()
  // Not signed in → there's nothing to be unauthorized about; go to login.
  if (!session) redirect("/login")
  // Signed in with a recognized role → they belong in the dashboard.
  if (session.user?.role) redirect("/dashboard")

  return (
    <main className="min-h-screen flex items-center justify-center bg-cream px-4">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-cream-border w-full max-w-sm text-center">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-brand flex items-center justify-center">
            <span className="text-white text-sm font-bold">Y</span>
          </div>
          <div className="text-left">
            <p className="font-bold text-foreground leading-tight">Yubisayu</p>
            <p className="text-xs text-gray-500">Inventory Dashboard</p>
          </div>
        </div>

        {/* Lock icon */}
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-brand-light flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1 className="text-lg font-semibold text-foreground mb-2">Account not authorized</h1>
        {session.user?.email ? (
          <p className="text-sm text-gray-500 mb-1">
            You&apos;re signed in as{" "}
            <span className="font-medium text-foreground break-all">{session.user.email}</span>,
            but this account doesn&apos;t have access to the dashboard.
          </p>
        ) : (
          <p className="text-sm text-gray-500 mb-1">
            This account doesn&apos;t have access to the dashboard.
          </p>
        )}
        <p className="text-sm text-gray-500 mb-6">
          Ask an administrator to grant access, or sign in with a different account.
        </p>

        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors shadow-sm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign in with a different account
          </button>
        </form>
      </div>
    </main>
  )
}
