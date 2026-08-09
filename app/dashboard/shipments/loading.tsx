import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Shipments" subtitle="Track all outgoing shipments and update tracking numbers" />
      <TableSkeleton />
    </PageShell>
  )
}
