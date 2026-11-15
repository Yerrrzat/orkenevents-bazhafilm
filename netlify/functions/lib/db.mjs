// Tiny database layer: query() and tx() (several statements, all-or-nothing).
// Production: Neon Postgres over HTTPS. Tests plug in an in-memory Postgres with useDb().
let impl = null;
export function useDb(i) { impl = i; }
export const dbConfigured = () => !!impl || !!process.env.DATABASE_URL;

async function get() {
  if (impl) return impl;
  if (!process.env.DATABASE_URL) throw Object.assign(new Error('База данных не подключена'), { status: 503, code: 'NO_DB' });
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  impl = {
    query: (text, params = []) => sql.query(text, params),
    tx: (stmts) => sql.transaction(stmts.map(([text, params = []]) => sql.query(text, params))),
  };
  return impl;
}
export async function q(text, params = []) { return (await get()).query(text, params); }
/** stmts: [[sql, params], ...] run in one transaction; any error rolls everything back. */
export async function tx(stmts) { return (await get()).tx(stmts); }

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders(
     id text PRIMARY KEY, token text UNIQUE NOT NULL, number text UNIQUE NOT NULL, idem text UNIQUE NOT NULL,
     scr_id text NOT NULL, status text NOT NULL, name text NOT NULL, phone text NOT NULL, email text,
     total int NOT NULL, items jsonb NOT NULL, hold_exp double precision NOT NULL, created double precision NOT NULL,
     paid_at double precision, cancel_reason text, ip text, attempts int NOT NULL DEFAULT 0, review boolean NOT NULL DEFAULT false)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, hold_exp)`,
  `CREATE INDEX IF NOT EXISTS orders_phone_idx ON orders(phone)`,
  // One row per taken seat. The primary key is what makes double booking impossible.
  `CREATE TABLE IF NOT EXISTS seat_locks(
     scr_id text NOT NULL, seat_id text NOT NULL, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
     status text NOT NULL, exp double precision, PRIMARY KEY(scr_id, seat_id))`,
  `CREATE INDEX IF NOT EXISTS seat_locks_order_idx ON seat_locks(order_id)`,
  `CREATE TABLE IF NOT EXISTS receipts(
     id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE, number text, amount int,
     paid_at double precision, sender text, status text NOT NULL, reason text, ocr_text text, image text,
     created double precision NOT NULL)`,
  // The same receipt number can be accepted (or wait for review) only once.
  `CREATE UNIQUE INDEX IF NOT EXISTS receipts_number_once ON receipts(number) WHERE status IN ('ACCEPTED','REVIEW')`,
  `CREATE INDEX IF NOT EXISTS receipts_order_idx ON receipts(order_id, created)`,
  `CREATE TABLE IF NOT EXISTS tickets(
     id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE, item_id text UNIQUE NOT NULL,
     scr_id text NOT NULL, seat_id text NOT NULL, r int NOT NULL, n int NOT NULL, price int NOT NULL,
     number text UNIQUE NOT NULL, token text UNIQUE NOT NULL, status text NOT NULL,
     checked_at double precision, checked_by text, created double precision NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit(id bigserial PRIMARY KEY, at double precision NOT NULL, actor text, action text NOT NULL, entity text, detail text)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS mail_at double precision`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS mail_err text`,
];
let migrated = null;
export function migrate() { if (!migrated) migrated = (async () => { for (const s of SCHEMA) await q(s); })().catch((e) => { migrated = null; throw e; }); return migrated; }
