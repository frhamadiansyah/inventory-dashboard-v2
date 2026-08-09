import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import ArrivalListClient from "./ArrivalListClient"
import ReceivedReportControls from "./ReceivedReportControls"

export default function ArrivalListPage() {
  return (
    <PageShell>
      <PageHeader
        title="Receiving List"
        subtitle="Track which purchased items haven't arrived yet"
      />
      <ReceivedReportControls />
      <ArrivalListClient />
    </PageShell>
  )
}
