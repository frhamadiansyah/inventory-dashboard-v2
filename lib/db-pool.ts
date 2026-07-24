import postgres from "postgres"

const connectionString = process.env.DATABASE_URL!

// The local Supabase dev DB (127.0.0.1:54322) speaks plaintext — forcing SSL
// there makes the TLS handshake reset ("socket disconnected before secure TLS
// connection"). Require SSL only for remote hosts (the prod pooler).
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)

// Reuse one pool across dev HMR reloads. Without this, every recompile that
// touches a module importing lib/db* re-runs this file and stacks a fresh
// pool on top of the old one's lingering sockets — eventually pressuring the
// Supabase pooler's client limit, whose dropped/killed connections surface as
// nonsense intermittent errors (result rows missing columns) until the dev
// server is restarted. Production runs this once, so the guard is a no-op.
const globalForDb = globalThis as unknown as { __dbPool?: ReturnType<typeof postgres> }

const sql = globalForDb.__dbPool ?? postgres(connectionString, {
  // Bumped from 5 → 10 because pages like the dashboard fan out 6 queries
  // in parallel via Promise.all and could starve the pool with multiple tabs.
  max: 10,
  // Keep pooled client connections warm for 5 min between bursts. At the old
  // 20s, quiet gaps closed connections constantly, and every reopen re-ran the
  // pooler auth (pgbouncer.get_auth) plus a driver type-introspection query —
  // which showed up in pg_stat_statements as tens of thousands of
  // connection-churn calls and real egress. Longer idle = far fewer
  // reopen→reauth→reintrospect cycles.
  idle_timeout: 300,
  max_lifetime: 60 * 30,
  connect_timeout: 10,
  ssl: isLocalDb ? false : "require",
  // Supabase's transaction-mode pooler (port 6543) reuses connections across
  // requests and doesn't support prepared statements. Disabling prepares
  // avoids "prepared statement does not exist" (SQLSTATE 26000) errors.
  prepare: false,
  // Hard 15s ceiling on individual queries. A poorly-indexed query no longer
  // holds a connection forever — it fails fast and the pool stays healthy.
  connection: {
    statement_timeout: 15000,
  },
})

if (process.env.NODE_ENV !== "production") globalForDb.__dbPool = sql

export default sql
