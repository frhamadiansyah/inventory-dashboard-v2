import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import DataTable from "./DataTable"

export default async function ListOrderPage() {
  const session = await auth()
  const isOwner = session?.user?.role === "owner"
  return (
    <PageShell>
      <PageHeader
        title="Order"
        subtitle="View, edit, and delete orders"
      />
      <DataTable isOwner={isOwner} />
    </PageShell>
  )
}
