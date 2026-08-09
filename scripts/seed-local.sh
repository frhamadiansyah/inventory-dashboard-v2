#!/usr/bin/env bash
# Reseed the LOCAL Supabase dev DB with reference data.
#
# Run after `supabase start` (first time) or `supabase db reset` (which rebuilds
# an empty schema). Loads supabase/seed.local.sql — a gitignored, one-time
# pg_dump of prod reference tables (countries, warehouses, events, products,
# products_indo, jne_rates, message_templates, business_profile,
# product_defaults). The file truncates those tables first, so it is idempotent.
#
# It is NOT wired into `supabase db reset` on purpose: the CLI's batch seed
# loader fails on this dump, but psql loads it cleanly.
#
# Regenerate the dump (rarely — only when prod reference data changes enough to
# matter for dev) with a one-time pg_dump from the prod SESSION pooler (:5432):
#
#   PROD=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"' | sed 's/:6543/:5432/')
#   pg_dump "$PROD" --data-only --no-owner --no-privileges --rows-per-insert=500 \
#     -t public.countries -t public.warehouses -t public.events -t public.products \
#     -t public.products_indo -t public.jne_rates -t public.message_templates \
#     -t public.business_profile -t public.product_defaults \
#     | grep -vE '^\\(restrict|unrestrict)' > /tmp/ref.sql
#   # then wrap /tmp/ref.sql with the BEGIN / SET replica / TRUNCATE / ... / COMMIT
#   # header+footer already in supabase/seed.local.sql.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="$ROOT/supabase/seed.local.sql"
LOCAL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

# Prefer libpq's psql (Homebrew keg-only) if present, else PATH psql.
PSQL="psql"
if [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
  PSQL=/opt/homebrew/opt/libpq/bin/psql
fi

if [ ! -f "$SEED" ]; then
  echo "error: $SEED not found. See header comment to regenerate the dump." >&2
  exit 1
fi

echo "Seeding local DB (127.0.0.1:54322) from supabase/seed.local.sql ..."
"$PSQL" "$LOCAL" -v ON_ERROR_STOP=1 -q -f "$SEED"
echo "Done."
