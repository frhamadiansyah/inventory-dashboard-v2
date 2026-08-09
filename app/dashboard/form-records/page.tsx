import PageShell from "@/components/PageShell"
import PageHeader from "@/components/PageHeader"
import { auth } from "@/auth"
import FormRecordsTable from "./FormRecordsTable"

export default async function FormRecordsPage() {
  const session = await auth()
  const role = session?.user?.role ?? null
  return (
    <PageShell>
      <PageHeader
        title="Form Records"
        subtitle="Full view of all orders in the Duplicate_Form sheet"
      />
      <FormRecordsTable role={role} />
    </PageShell>
  )
}
