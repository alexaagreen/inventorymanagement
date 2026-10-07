// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Egen pg-pool mot databasen der schema `inv` bor.
//   INVENTORY_DATABASE_URL — foretrukket (Skarpekniver: v3-Supabase, transaction pooler 6543)
//   DATABASE_URL           — fallback (Bark: internal-web snakker allerede med riktig Supabase)
// SSL: Supabase krever TLS. Lokale/CI-URLer (localhost, unix-socket) kjøres uten.
import { Pool } from 'pg';

function connectionString() {
  return process.env.INVENTORY_DATABASE_URL || process.env.DATABASE_URL || '';
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
  if (!url) throw new Error('INVENTORY_DATABASE_URL (or DATABASE_URL) is not set');
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
