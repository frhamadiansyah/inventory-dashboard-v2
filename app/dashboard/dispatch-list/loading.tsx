import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Dispatch List" subtitle="Bought orders not yet dispatched" />
      <TableSkeleton />
    </PageShell>
  )
}
