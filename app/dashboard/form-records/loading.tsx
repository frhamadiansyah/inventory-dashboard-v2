import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import TableSkeleton from "@/components/TableSkeleton"

export default function Loading() {
  return (
    <PageShell>
      <PageHeader title="Form Records" subtitle="Full view of all orders in the Duplicate_Form sheet" />
      <TableSkeleton />
    </PageShell>
  )
}
