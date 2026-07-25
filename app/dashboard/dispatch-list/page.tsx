import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DispatchListClient from "./DispatchListClient"

export default function DispatchListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Dispatch List"
        subtitle="Bought orders not yet dispatched"
      />
      <DispatchListClient />
    </PageShell>
  )
}
