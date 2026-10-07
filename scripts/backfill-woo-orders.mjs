#!/usr/bin/env node
// Backfill Woo-ordrer inn i ledgeren via API-et (idempotent — trygt å kjøre flere ganger).
//   INVENTORY_BASE_URL=https://internalweb-alpha.vercel.app INVENTORY_API_KEY=… \
//     node scripts/backfill-woo-orders.mjs --from 2026-10-01T00:00:00Z [--to …]
// Kaller POST /api/inventory/sync/import-orders og følger next_page til ferdig.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
  return acc;
}, []));
const base = (process.env.INVENTORY_BASE_URL || '').replace(/\/$/, '');
const key = process.env.INVENTORY_API_KEY || '';
if (!base || !key || !args.from) {
  console.error('Usage: INVENTORY_BASE_URL=… INVENTORY_API_KEY=… node scripts/backfill-woo-orders.mjs --from <iso> [--to <iso>]');
  process.exit(1);
}
let page = 1; let totals = { processed: 0, movements: 0, errors: 0 };
while (page) {
  const u = new URL(`${base}/api/inventory/sync/import-orders`);
  u.searchParams.set('from', args.from);
  if (args.to) u.searchParams.set('to', args.to);
  u.searchParams.set('page', String(page));
  const res = await fetch(u, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'x-inventory-by': 'backfill-script' } });
  const body = await res.json();
  if (!res.ok) { console.error(res.status, body); process.exit(1); }
  totals.processed += body.processed; totals.movements += body.movements; totals.errors += body.errors.length;
  for (const e of body.errors) console.warn('order', e.order_id, e.message);
  console.log(`page ${page}: processed ${body.processed}, movements ${body.movements}`);
  page = body.next_page;
}
console.log('done', totals);
