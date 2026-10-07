// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// route({ GET, POST, … }) — felles wrapper for alle /api/inventory/*-ruter:
//   * metode-dispatch (405 med Allow-header)
//   * auth (Bearer INVENTORY_API_KEY eller session) → ctx.by
//   * Idempotency-Key på skrivende kall (24 t, lagret i inv.idempotency_key)
//   * feilmapping: InventoryError / pg-feil → { error: { code, message, details } }
// Handler returnerer body (200 for GET, 201 for POST) eller withStatus(code, body).
import { authenticate } from './auth';
import { InventoryError, fromPgError } from './errors';
import { sql } from './rpc';
import { kickPush } from './woo-push';

const WRITE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function withStatus(status, body) {
  return { __status: status, body };
}

function parseBody(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { throw new InventoryError('VALIDATION', 'Body must be valid JSON'); }
  }
  return b;
}

export function route(methods, { auth = true, noPush = false } = {}) {
  return async function handler(req, res) {
    const fn = methods[req.method];
    if (!fn) {
      res.setHeader('Allow', Object.keys(methods).join(', '));
      return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} not allowed`, details: {} } });
    }
    const idemKey = WRITE.has(req.method) ? (req.headers?.['idempotency-key'] || null) : null;
    try {
      const body = parseBody(req);
      req.body = body;
      const ctx = auth ? await authenticate(req, res) : { by: null, via: 'none' };
      ctx.body = body;
      ctx.query = req.query || {};

      if (idemKey) {
        const hit = await sql('select status, response from inv.idempotency_key where key = $1', [String(idemKey)]);
        if (hit[0]?.response != null) {
          res.setHeader('Idempotent-Replay', 'true');
          return res.status(hit[0].status).json(hit[0].response);
        }
      }

      const out = await fn(req, res, ctx);
      if (res.headersSent || res.writableEnded) return;
      const status = out && out.__status ? out.__status : (req.method === 'POST' ? 201 : 200);
      const payload = out && out.__status ? out.body : out;

      if (idemKey && status < 500) {
        await sql(
          `insert into inv.idempotency_key (key, method, path, status, response)
           values ($1, $2, $3, $4, $5::jsonb) on conflict (key) do nothing`,
          [String(idemKey), req.method, String(req.url || ''), status, JSON.stringify(payload ?? null)],
        ).catch(() => {});
      }
      res.status(status).json(payload ?? null);
      // Skriv ferdig → be push-workeren oppdatere Woo nå (cron er garantien).
      if (WRITE.has(req.method) && status < 300 && !noPush) kickPush();
      return undefined;
    } catch (e) {
      const err = fromPgError(e);
      if (err.status >= 500) console.error('[inventory]', req.method, req.url, e);
      if (res.headersSent) return;
      return res.status(err.status).json(err.toJSON());
    }
  };
}

// ── Query-hjelpere ─────────────────────────────────────────────────────────

export function qList(v) {
  if (v == null || v === '') return null;
  const arr = (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
  return arr.length ? arr : null;
}

export function qBool(v) {
  if (v == null || v === '') return null;
  return ['1', 'true', 'yes', 'ja'].includes(String(v).toLowerCase());
}

export function qLimit(v, def = 100, max = 500) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

export function qDate(v, name) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new InventoryError('VALIDATION', `${name} must be a date`, { field: name, value: v });
  return String(v);
}

export function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function decodeCursor(v) {
  if (!v) return null;
  try { return JSON.parse(Buffer.from(String(v), 'base64url').toString('utf8')); }
  catch { throw new InventoryError('VALIDATION', 'invalid cursor'); }
}

export function isCsv(query) {
  return String(query?.format || '').toLowerCase() === 'csv';
}

export function requireParam(v, name) {
  if (v == null || v === '') throw new InventoryError('VALIDATION', `${name} is required`, { field: name });
  return Array.isArray(v) ? v[0] : v;
}

export function requireUuid(v, name = 'id') {
  const s = requireParam(v, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new InventoryError('NOT_FOUND', `${name} not found`, { [name]: s });
  }
  return s;
}

export function requireLines(body) {
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
    throw new InventoryError('VALIDATION', 'lines must be a non-empty array', { field: 'lines' });
  }
  for (const [i, l] of body.lines.entries()) {
    if (!l || typeof l !== 'object') throw new InventoryError('VALIDATION', `line ${i + 1} must be an object`);
  }
}
