// inventory-ledger v0.9.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Norges Bank exchange rates as a REFERENCE for the UI (shown next to the fx field on
// purchase orders and receipts). Never applied automatically: the rate used for cost is
// always the one a person enters (customs papers / bank), so the ledger stays in NOK
// with a rate someone chose.
//
// Source: Norges Bank open data, series EXR/B.<CUR>.NOK.SP (business-day spot, published
// ~16:00 CET). Some currencies are quoted per 100 units (UNIT_MULT=2, e.g. JPY, SEK, DKK);
// the rate returned here is always NOK per ONE unit.
import { InventoryError } from './errors';

const BASE = 'https://data.norges-bank.no/api/data/EXR';
const TIMEOUT_MS = Number(process.env.INVENTORY_FX_TIMEOUT_MS || 5000);
const cache = globalThis.__inventoryFxCache || (globalThis.__inventoryFxCache = new Map());

/** Parse Norges Bank CSV (format=csv, locale=en, ';'-separated) → latest observation. */
export function parseNorgesBankCsv(text, currency) {
  const lines = String(text || '').replace(/^﻿/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const head = lines[0].split(';');
  const col = (name) => head.indexOf(name);
  const iCur = col('BASE_CUR'), iMult = col('UNIT_MULT'), iDate = col('TIME_PERIOD'), iVal = col('OBS_VALUE');
  if ([iCur, iMult, iDate, iVal].some((i) => i < 0)) return null;
  const rows = lines.slice(1).map((l) => l.split(';')).filter((r) => r[iCur] === currency && r[iVal] !== '');
  if (!rows.length) return null;
  rows.sort((a, b) => (a[iDate] < b[iDate] ? -1 : 1));
  const r = rows[rows.length - 1];
  const quoted = Number(r[iVal]);
  const mult = Number(r[iMult] || 0);
  if (!Number.isFinite(quoted) || quoted <= 0) return null;
  const rate = Number((quoted / 10 ** mult).toFixed(8));
  return { currency, rate, quoted, per_units: 10 ** mult, date: r[iDate] };
}

/**
 * NOK per 1 unit of `currency` on `date` (YYYY-MM-DD), or the last business day before it.
 * Returns { currency, rate, quoted, per_units, date, requested_date, source } or throws.
 */
export async function getNorgesBankRate(currency, date) {
  const cur = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new InventoryError('VALIDATION', 'currency must be a 3-letter ISO code', { field: 'currency' });
  const day = date ? String(date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InventoryError('VALIDATION', 'date must be YYYY-MM-DD', { field: 'date' });
  const source = 'Norges Bank';
  if (cur === 'NOK') return { currency: cur, rate: 1, quoted: 1, per_units: 1, date: day, requested_date: day, source };

  const key = `${cur}:${day}`;
  if (cache.has(key)) return cache.get(key);

  const url = `${BASE}/B.${cur}.NOK.SP?format=csv&locale=en&bom=exclude&lastNObservations=1&endPeriod=${day}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/csv' } });
    if (res.status === 404) throw new InventoryError('NOT_FOUND', `Norges Bank has no NOK rate for ${cur}`, { currency: cur });
    if (!res.ok) throw new InventoryError('UPSTREAM', `Norges Bank responded ${res.status}`, { status: res.status });
    text = await res.text();
  } catch (err) {
    if (err instanceof InventoryError) throw err;
    throw new InventoryError('UPSTREAM', `Norges Bank unreachable: ${err?.name === 'AbortError' ? 'timeout' : err?.message || err}`);
  } finally {
    clearTimeout(t);
  }
  const parsed = parseNorgesBankCsv(text, cur);
  if (!parsed) throw new InventoryError('NOT_FOUND', `Norges Bank has no NOK rate for ${cur} on or before ${day}`, { currency: cur, date: day });
  const out = { ...parsed, requested_date: day, source };
  // Past dates never change; today's may not be published yet, so cache those briefly only.
  cache.set(key, out);
  if (day >= new Date().toISOString().slice(0, 10)) setTimeout(() => cache.delete(key), 15 * 60 * 1000).unref?.();
  return out;
}
