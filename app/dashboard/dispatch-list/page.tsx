import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import DispatchListClient from "./DispatchListClient"
import DispatchDocControls from "./DispatchDocControls"

export default function DispatchListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Dispatch List"
        subtitle="Bought orders not yet dispatched"
      />
      <DispatchDocControls />
      <DispatchListClient />
    </PageShell>
  )
}
