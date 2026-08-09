import postgres from "postgres"
import sql from "../db-pool"

/**
 * A query executor: either the global pool (`sql`) or a transaction handle
 * (`tx`). Write functions take one of these (defaulting to the pool) so a
 * caller can run them inside a `withActor` transaction to attribute the change.
 */
export type DBExecutor = postgres.ISql

/**
 * Run `fn` inside a single transaction that first stamps the acting user into
 * the `app.actor` GUC, so the audit triggers firing in the SAME transaction
 * record who did it.
 *
 * Must be one transaction: `set_config(..., true)` is transaction-local, so the
 * value is visible to the triggers and discarded at COMMIT — it can never leak
 * to another request's transaction on a pooled connection (we're on Supabase's
 * transaction-mode pooler). Pass the supplied `tx` to the write(s) inside `fn`.
 */
export async function withActor<T>(
  actor: string | null | undefined,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor', ${actor ?? ""}, true)`
    return fn(tx)
  }) as Promise<T>
}
