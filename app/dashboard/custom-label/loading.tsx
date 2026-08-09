import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Custom Label" subtitle="Generate a custom shipping label with any recipient and shipping ID" />
      <TableSkeleton />
    </PageShell>
  )
}
