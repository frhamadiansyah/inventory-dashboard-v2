import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Packing List" subtitle="Orders with arrived units that haven't been shipped yet" />
      <TableSkeleton />
    </PageShell>
  )
}
