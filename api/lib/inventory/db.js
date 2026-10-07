// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Egen pg-pool mot databasen der schema `inv` bor.
//   INVENTORY_DATABASE_URL — PÅKREVD. Peker alltid på butikkens (storefrontens) Supabase,
//   transaction pooler 6543. Ingen fallback til DATABASE_URL: i internal-web peker den
//   typisk på en annen database, og en stille fallback ville skrevet lageret til feil sted.
// SSL: Supabase krever TLS. Lokale/CI-URLer (localhost, unix-socket) kjøres uten.
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
