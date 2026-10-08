// inventory-ledger v0.6.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Dedicated pg pool for the database where schema `inv` lives.
//   INVENTORY_DATABASE_URL — REQUIRED. Always points at the shop's (storefront) Supabase,
//   transaction pooler port 6543. No fallback to DATABASE_URL: in internal-web that usually
//   points at a different database, and a silent fallback would write stock to the wrong place.
// SSL: Supabase requires TLS. Local/CI URLs (localhost, unix socket) run without it.
import { Pool } from 'pg';

function connectionString() {
  return process.env.INVENTORY_DATABASE_URL || '';
}

function isLocal(url) {
  if (/sslmode=disable/.test(url) || /[?&]host=\//.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

let _pool = globalThis.__inventoryPool || null;

export function getPool() {
  if (_pool) return _pool;
  const url = connectionString();
  if (!url) throw new Error('INVENTORY_DATABASE_URL is not set (must point at the storefront Supabase where schema inv lives)');
  _pool = new Pool({
    connectionString: url,
    ssl: isLocal(url) ? false : { rejectUnauthorized: false },
    max: Number(process.env.INVENTORY_DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  _pool.on('error', (err) => console.error('[inventory/db] idle client error:', err.message));
  globalThis.__inventoryPool = _pool;
  return _pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function closePool() {
  if (_pool) { await _pool.end(); _pool = null; globalThis.__inventoryPool = null; }
}
