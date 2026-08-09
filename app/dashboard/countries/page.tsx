import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import CountriesClient from "./CountriesClient"

export default function CountriesPage() {
  return (
    <PageShell>
      <PageHeader
        title="Currencies"
        subtitle="Manage currency exchange rates and cargo costs"
      />
      <CountriesClient />
    </PageShell>
  )
}
