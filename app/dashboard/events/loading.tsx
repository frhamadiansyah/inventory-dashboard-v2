import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Events" subtitle="Manage buying events" />
      <TableSkeleton />
    </PageShell>
  )
}
