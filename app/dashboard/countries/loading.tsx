import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Currencies" subtitle="Manage currency exchange rates and cargo costs" />
      <TableSkeleton />
    </PageShell>
  )
}
