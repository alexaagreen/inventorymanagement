// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Order reconcile (v0.9.0): the nightly safety net behind webhooks and the 30-minute backfill.
// Pulls every Woo order modified in the run's window, re-applies it (idempotent — only real
// differences are booked), compares Woo with the ledger, and checks ledger orders Woo no longer
// returns. Everything is written to inv.order_reconcile_run / inv.order_reconcile_issue so the
// UI can show the log, what changed and what needs a human.
import { rpc } from './rpc';
import { wooConfigured, wooGet, wooRequest, WooError } from './woo';
import { applyOrder } from './woo-order';
import { kickPush } from './woo-push';
import { InventoryError } from './errors';

const PER_PAGE = 100;
const MAX_LOG_PER_RUN = 3000; // log lines kept per run (the DB caps at 5000)

const iso = (v) => new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Run one order reconcile.
 *   trigger  'cron' | 'manual'
 *   days     look-back (default inv.settings.order_reconcile_days = 7; widened back to the
 *            last completed run, capped at order_reconcile_max_days = 35)
 *   from/to  explicit window instead of days
 *   budgetMs time budget; a run that runs out ends as 'partial' and the next run covers it
 * Returns the finished run (incl. log, changes, issue counts).
 */
export async function reconcileOrders({ trigger = 'manual', by = null, days, from, to, budgetMs = 240000 } = {}) {
  if (!wooConfigured()) throw new InventoryError('UPSTREAM', 'WooCommerce is not configured', {});
  const run = await rpc('start_order_reconcile', [{
    trigger, by, ...(days != null ? { days: Number(days) } : {}),
    ...(from ? { window_from: from } : {}), ...(to ? { window_to: to } : {}),
  }]);
  const started = Date.now();
  const overBudget = () => Date.now() - started > budgetMs;

  const checked = [];
  const issues = [];
  const changes = [];
  const counts = { orders_checked: 0, orders_changed: 0, movements: 0, missing_checked: 0 };
  let pending = [];
  let logged = 0;
  const log = (level, message) => {
    if (logged >= MAX_LOG_PER_RUN) return;
    logged++;
    pending.push({ at: new Date().toISOString(), level, message });
  };
  const flush = async () => {
    const entries = pending; pending = [];
    await rpc('log_order_reconcile', [run.id, { log: entries, counts }]);
  };

  async function checkOne(o) {
    const label = `#${o.number || o.id}`;
    try {
      const r = await applyOrder(o, 'reconcile');
      const moved = r.movements.length + r.refunds.reduce((s, x) => s + (x.movements?.length || 0), 0);
      if (moved) {
        counts.orders_changed++;
        counts.movements += moved;
        changes.push({ order_id: o.id, number: o.number || String(o.id), status: o.status, action: r.action,
          movements: moved, refunds: r.refunds.filter((x) => x.action === 'applied').length });
        log('info', `${label} (${o.status}): ${r.action} — ${moved} movement(s) booked`);
      }
      const found = await rpc('check_woo_order', [o]);
      for (const f of found || []) { issues.push(f); log('warn', `${label}: ${f.message}`); }
    } catch (err) {
      issues.push({ kind: 'apply_failed', woo_order_id: o.id, order_number: o.number || String(o.id), ref: '',
        message: `Could not apply the order: ${err.message}`,
        details: { code: err.code || null, details: err.details || null, woo_status: o.status } });
      log('error', `${label}: ${err.message}`);
    }
    checked.push(o.id);
    counts.orders_checked++;
  }

  let complete = false;
  let error = null;
  try {
    const seen = [];
    let budgetHit = false;
    for (let page = 1; ; page++) {
      const { data, headers } = await wooRequest('GET', '/orders', {
        params: { per_page: PER_PAGE, page, status: 'any', orderby: 'id', order: 'asc',
          modified_after: iso(run.window_from), modified_before: iso(run.window_to), dates_are_gmt: true },
      });
      const orders = Array.isArray(data) ? data : [];
      for (const o of orders) { seen.push(o.id); await checkOne(o); }
      const totalPages = Number(headers.get('x-wp-totalpages') || 0);
      log('info', `Page ${page}${totalPages ? ` of ${totalPages}` : ''}: ${orders.length} order(s) checked`);
      await flush();
      if (orders.length < PER_PAGE || (totalPages && page >= totalPages)) break;
      if (overBudget()) { budgetHit = true; log('warn', `Time budget used up after page ${page}; the next run covers the rest`); break; }
    }

    // Orders the ledger deducted for, modified inside the window, that Woo did not list: look each up.
    if (!budgetHit) {
      const candidates = await rpc('order_reconcile_missing_candidates', [{
        window_from: run.window_from, window_to: run.window_to, seen, limit: 500 }]);
      if (candidates?.length) log('info', `${candidates.length} ledger order(s) not in Woo's list — looking them up`);
      for (const id of candidates || []) {
        if (overBudget()) { budgetHit = true; log('warn', 'Time budget used up while looking up missing orders'); break; }
        counts.missing_checked++;
        try {
          const o = await wooGet(`/orders/${id}`);
          await checkOne(o); // e.g. moved to the trash → restore_statuses returns the stock
        } catch (err) {
          if (err instanceof WooError && err.status === 404) {
            const issue = await rpc('order_missing_issue', [id]);
            if (issue) { issues.push(issue); log('warn', `#${issue.order_number}: ${issue.message}`); }
            checked.push(id);
            counts.orders_checked++;
          } else {
            log('error', `Order ${id}: lookup failed — ${err.message}`);
          }
        }
      }
      await flush();
    }
    complete = !budgetHit;
  } catch (err) {
    error = err.message || String(err);
    log('error', error);
  }

  const result = await rpc('finish_order_reconcile', [{
    run_id: run.id, complete, error, checked, issues, changes, log: pending, counts }]);
  if (counts.movements) kickPush();
  return result;
}
