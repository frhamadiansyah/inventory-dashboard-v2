interface Props {
  title: string
  subtitle: string
}

export default function PageHeader({ title, subtitle }: Props) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-foreground">{title}</h1>
      <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
    </div>
  )
}
