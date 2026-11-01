import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { call, db, item } from './helpers';
import { rpc } from '../lib/inventory/rpc';
import { buildDoc, cols, exportFormat } from '../lib/inventory/export';
import valuationRoute from '../pages/api/inventory/valuation';
import stockRoute from '../pages/api/inventory/stock/index';
import movementsRoute from '../pages/api/inventory/movements/index';
import itemMovementsRoute from '../pages/api/inventory/items/[sku]/movements';
import cogsRoute from '../pages/api/inventory/reports/cogs';
import asOfRoute from '../pages/api/inventory/reports/stock-as-of';
import monthCloseRoute from '../pages/api/inventory/month-close/index';
import periodRoute from '../pages/api/inventory/month-close/[period]';
import supplierItemsRoute from '../pages/api/inventory/suppliers/[id]/items';
import supplierMovementsRoute from '../pages/api/inventory/suppliers/[id]/movements';

/** Reads the files of a zip (xlsx) — enough to check what we wrote. */
function unzip(buf) {
  const files = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const start = p + 30 + nameLen + extra;
    files[name] = zlib.inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    p = start + size;
  }
  return files;
}
/** Text drawn in a PDF (all content streams inflated). */
function pdfText(buf) {
  const s = buf.toString('latin1');
  let out = '';
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try { out += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* not a content stream */ }
  }
  return out;
}

describe('downloads: one standard for csv | xlsx | pdf (v0.11.0)', () => {
  beforeAll(async () => {
    process.env.INVENTORY_KICK_PUSH = 'off';
    await item('EXP-1'); await item('EXP-2');
    const po = await rpc('create_purchase_order', { supplier_name: 'Export Test AS', lines: [{ sku: 'EXP-1', qty: 4, unit_cost: 125.5 }, { sku: 'EXP-2', qty: 2, unit_cost: 10 }] });
    await rpc('set_purchase_order_status', [po.id, 'sent', 'test']);
    await rpc('receive_purchase_order', [po.id, { by: 'test', received_at: '2018-05-10T10:00:00+02:00', lines: [{ sku: 'EXP-1', qty: 4 }, { sku: 'EXP-2', qty: 2 }] }]);
    await rpc('close_month', { period: '2018-05', by: 'test' });
  });

  it('format: csv | xlsx | pdf (excel = xlsx), anything else is a 400', async () => {
    expect(exportFormat({})).toBe(null);
    expect(exportFormat({ format: 'Excel' })).toBe('xlsx');
    expect(exportFormat({ format: 'pdf' })).toBe('pdf');
    expect(() => exportFormat({ format: 'docx' })).toThrow(/format must be/);
    expect((await call(valuationRoute, { query: { format: 'docx' } })).status).toBe(400);
  });

  it('xlsx: labels, real numbers, frozen header with autofilter and a totals row', async () => {
    const r = await call(periodRoute, { query: { period: '2018-05', format: 'xlsx', q: 'EXP-' }, headers: { 'x-inventory-by': 'alex' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    expect(r.headers['content-disposition']).toContain('lager-maanedsslutt-2018-05.xlsx');
    const f = unzip(r.body);
    const sheet = f['xl/worksheets/sheet1.xml'];
    expect(f['xl/workbook.xml']).toContain('name="2018-05"');
    expect(sheet).toContain('Lager ved månedsslutt – mai 2018');
    expect(sheet).toContain('Verdi (NOK)');
    expect(sheet).toContain('Generert');
    expect(sheet).toContain('av alex');
    expect(sheet).toMatch(/<v>502<\/v>/);          // EXP-1 value 4 × 125.50 as a number
    expect(sheet).toContain('Sum (2 linjer)');
    expect(sheet).toMatch(/<v>522<\/v>/);          // total value
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toMatch(/<autoFilter ref="A8:E10"\/>/);
  });

  it('pdf: title, filters, rows, totals and page numbers; ?lang=en switches labels', async () => {
    const r = await call(periodRoute, { query: { period: '2018-05', format: 'pdf', q: 'EXP-' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.body.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    const t = pdfText(r.body);
    expect(t).toContain('(Lager ved m\xe5nedsslutt \x96 mai 2018)');
    expect(t).toContain('(S\xf8k: EXP-)');
    expect(t).toContain('(EXP-1)');
    expect(t).toContain('(502,00)');
    expect(t).toContain('(Side 1 av 1)');
    const en = pdfText((await call(periodRoute, { query: { period: '2018-05', format: 'pdf', q: 'EXP-', lang: 'en' } })).body);
    expect(en).toContain('(Stock at month end \x96 May 2018)');
    expect(en).toContain('(Page 1 of 1)');
  });

  it('csv stays machine-readable: keys as header, raw values', async () => {
    const r = await call(valuationRoute, { query: { format: 'csv' } });
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.body).toContain('sku;name;on_hand;avg_cost;value');
  });

  it('every downloadable endpoint serves all three formats', async () => {
    const cases = [
      [valuationRoute, {}], [stockRoute, {}], [stockRoute, { location: 'MAIN' }], [movementsRoute, { sku: 'EXP-1' }],
      [itemMovementsRoute, { sku: 'EXP-1', from: '2018-01-01' }], [cogsRoute, { group_by: 'day' }],
      [asOfRoute, { at: '2018-05-31' }], [periodRoute, { period: '2018-05', by: 'location' }],
      [supplierItemsRoute, { id: 'Export Test AS' }], [supplierMovementsRoute, { id: 'Export Test AS' }],
    ];
    expect(await db(`select id from inv.supplier where name = 'Export Test AS'`)).toHaveLength(1);
    for (const [route, q] of cases) {
      for (const format of ['csv', 'xlsx', 'pdf']) {
        const r = await call(route, { query: { ...q, format } });
        expect([route.name, q, format, r.status, r.body?.error]).toEqual([route.name, q, format, 200, undefined]);
        expect(r.headers['content-disposition']).toMatch(new RegExp(`\\.${format}"$`));
      }
    }
    expect((await call(monthCloseRoute)).status).toBe(200);
  });

  it('standard columns: same key → same label and type everywhere; codes get labels in xlsx/pdf only', () => {
    const [a] = cols(['value']);
    expect(a).toMatchObject({ key: 'value', type: 'nok', nb: 'Verdi (NOK)', total: true });
    const d = buildDoc({ title: 'x', columns: cols(['type', 'qty']), rows: [{ type: 'purchase_receipt', qty: '1.500' }] }, { lang: 'nb' });
    expect(d.rows[0][0].text).toBe('Varemottak');
    expect(d.rows[0][1]).toMatchObject({ v: 1.5, kind: 'num', text: '1,5' });
  });

  it('no route writes its own CSV/Excel/PDF — everything goes through lib/inventory/export.js', () => {
    const root = path.resolve(__dirname, '../pages/api/inventory');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(root)) {
      const src = fs.readFileSync(f, 'utf8');
      expect([path.relative(root, f), /lib\/inventory\/csv'|sendCsv|isCsv|text\/csv|application\/pdf/.test(src)]).toEqual([path.relative(root, f), false]);
    }
  });
});
