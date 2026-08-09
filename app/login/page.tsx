import { auth, signIn } from "@/auth"
import { redirect } from "next/navigation"

export default async function LoginPage() {
  const session = await auth()
  if (session?.user?.role) redirect("/dashboard")
  // Signed in but no recognized role → dedicated unauthorized page.
  if (session) redirect("/unauthorized")

  return (
    <main className="min-h-screen flex items-center justify-center bg-cream">
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

        <h1 className="text-lg font-semibold text-foreground mb-1">Welcome back</h1>
        <p className="text-sm text-gray-500 mb-6">Sign in with your Google account to continue</p>

        <form
          action={async () => {
            "use server"
            await signIn("google", { redirectTo: "/dashboard" })
          }}
        >
          <button
            type="submit"
            className="w-full flex items-center justify-center gap-3 bg-brand hover:bg-brand-dark text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors shadow-sm"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
                fill="#ffffff"
                fillOpacity="0.9"
              />
              <path
                d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                fill="#ffffff"
                fillOpacity="0.9"
              />
              <path
                d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
                fill="#ffffff"
                fillOpacity="0.9"
              />
              <path
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
                fill="#ffffff"
                fillOpacity="0.9"
              />
            </svg>
            Sign in with Google
          </button>
        </form>
      </div>
    </main>
  )
}
