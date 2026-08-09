This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Local development database

Dev runs against a **local Supabase Postgres** stack instead of the production
pooler, so day-to-day development doesn't burn billed Supabase egress.

### How the env wiring works

- `.env.local` holds **production** credentials (Google, auth, prod `DATABASE_URL`, …).
- `.env.development.local` (gitignored) overrides **only** the two DB URLs with
  the local database. Next.js loads env in the order
  `.env.development.local` → `.env.local` → `.env.development` → `.env`
  (first match wins), and `next dev` sets `NODE_ENV=development`, so in dev the
  local URLs win while every other variable still resolves from `.env.local`.
  Production builds never load `.env.development.local`.

`.env.development.local`:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
INVOICE_READER_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

### One-time setup

Requires Docker Desktop, the Supabase CLI, and `libpq` (for `pg_dump`/`psql`):

```bash
brew install libpq          # pg_dump / psql (keg-only: /opt/homebrew/opt/libpq/bin)
supabase start              # boots the local stack, applies migrations 000 → latest
./scripts/seed-local.sh     # loads reference data (see "Seeding" below)
```

Then create `.env.development.local` with the two URLs above and start the app:

```bash
npm run dev
```

Confirm which database dev is pointed at:

```bash
node -e 'require("@next/env").loadEnvConfig(process.cwd(),true); console.log(process.env.DATABASE_URL.match(/@([^/]+)\//)[1])'
# 127.0.0.1:54322 = local · *.pooler.supabase.com:6543 = prod
```

### Daily use

```bash
supabase start          # start the stack
supabase stop           # stop it
supabase db reset       # rebuild schema from migrations (WIPES data)
./scripts/seed-local.sh # reseed reference data after a reset
```

`supabase db reset` does **not** auto-seed — the CLI's batch seed loader can't
parse the reference dump — so reseed with the script afterwards.

### Seeding

`./scripts/seed-local.sh` loads `supabase/seed.local.sql`: a one-time `pg_dump`
of production **reference** tables (countries, warehouses, events, products,
products_indo, jne_rates, message_templates, business_profile, product_defaults).
Transactional tables (orders, customers, payments, …) start empty — create that
data through the app.

`supabase/seed.local.sql` is **gitignored** (it contains `business_profile` bank
details). To regenerate it, see the header comment in
[`scripts/seed-local.sh`](scripts/seed-local.sh) — dump from the production
**session** pooler (port `5432`, not the `6543` transaction pooler, which
`pg_dump` can't use).

### Temporarily point dev at production

Disable the override (falls back to `.env.local` = prod), then restart the dev server:

```bash
mv .env.development.local .env.development.local.disabled   # → prod
mv .env.development.local.disabled .env.development.local   # → back to local
```

Restart `npm run dev` after switching — env is read once at process start.
**Prod mode uses billed egress and touches live data; use sparingly.** (The
public invoice-reader routes won't work in prod mode — `INVOICE_READER_DATABASE_URL`
isn't in `.env.local`.)

## Database migrations

Migration files live in [`supabase/migrations/`](supabase/migrations/), named
sequentially (`046_<name>.sql`, …).

**Apply to local:**

```bash
supabase migration up          # applies pending migrations, keeps data
supabase migration list --local
```

Use `supabase db reset` + `./scripts/seed-local.sh` instead if you edited an
already-applied migration and need a clean rebuild.

**Apply to production** (the linked project):

```bash
supabase db push --dry-run     # preview what would apply — review first
supabase db push               # apply (prompts for the prod DB password)
```

`db push` runs DDL on production and is irreversible — always `--dry-run` first.
Don't pass `--include-seed` (would push seed data to prod) or `--include-all`
(forces migrations prod may already have, causing "already exists" errors if the
remote history is out of sync).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
