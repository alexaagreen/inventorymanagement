// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// THE standard for downloads (spec §6.0.1). Every list/report endpoint that can be downloaded
// uses this file — never its own CSV/Excel/PDF code:
//
//   const fmt = exportFormat(query);                       // 'csv' | 'xlsx' | 'pdf' | null (= JSON)
//   const out = await listSomething({ …, all: Boolean(fmt) });
//   if (fmt) return sendExport(res, fmt, {
//     name: 'lagerverdi',                                  // file name without extension
//     title: { nb: 'Lagerverdi', en: 'Stock value' },
//     meta: [[{ nb: 'Lokasjon', en: 'Location' }, loc]],   // filters/context lines (empty values are skipped)
//     columns: cols(['sku', 'name', 'on_hand', 'avg_cost', 'value']),   // standard columns, see STD below
//     rows: out.rows,
//   }, ctx);
//
// Formats:
//   csv   machine-readable: header = column keys, raw values, ';' + decimal comma + BOM (unchanged since v0.3)
//   xlsx  for people: labels, real numbers/dates with number formats, autofilter, frozen header, totals row
//   pdf   for people/archive: A4 (landscape when wide), title + filters, header on every page, totals, page n/N
// Language of labels: ?lang=nb|en, else inventoryConfig.exportLanguage, else 'nb'.
// Totals: columns marked total (qty/value/cost amounts) are summed in xlsx/pdf; report.totals=false turns it off.
import { InventoryError } from './errors';
import { toCsv } from './csv';
import { toXlsx } from './xlsx';
import { toPdf } from './pdf';
import { inventoryConfig } from './config';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'];
const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** format query param → 'csv' | 'xlsx' | 'pdf' | null (JSON). 'excel' is an alias for xlsx. */
export function exportFormat(query) {
  const f = String(query?.format || '').toLowerCase();
  if (!f || f === 'json') return null;
  if (f === 'excel' || f === 'xls') return 'xlsx';
  if (!EXPORT_FORMATS.includes(f)) {
    throw new InventoryError('VALIDATION', `format must be one of ${EXPORT_FORMATS.join(', ')}`, { field: 'format', value: f });
  }
  return f;
}

// ── Column types and the standard columns ───────────────────────────────────
// type: text | code | int | qty | nok | cost | date | datetime | bool | json
// total: summed in the totals row. grow: gets spare width in PDF (names, notes).
// values: display labels for codes in xlsx/pdf ({ code: { nb, en } }); csv keeps the raw code.
const NUMERIC = new Set(['int', 'qty', 'nok', 'cost']);
const STD = {
  id: { type: 'int', nb: 'ID', en: 'ID' },
  key: { type: 'text', nb: 'Nøkkel', en: 'Key' },
  sku: { type: 'code', nb: 'SKU', en: 'SKU' },
  name: { type: 'text', nb: 'Navn', en: 'Name', grow: true },
  item_name: { type: 'text', nb: 'Navn', en: 'Name', grow: true },
  location: { type: 'code', nb: 'Lokasjon', en: 'Location' },
  location_code: { type: 'code', nb: 'Lokasjon', en: 'Location' },
  qty: { type: 'qty', nb: 'Antall', en: 'Qty', total: true },
  on_hand: { type: 'qty', nb: 'Beholdning', en: 'On hand', total: true },
  available: { type: 'qty', nb: 'Disponibel', en: 'Available', total: true },
  on_order: { type: 'qty', nb: 'I bestilling', en: 'On order', total: true },
  value: { type: 'nok', nb: 'Verdi (NOK)', en: 'Value (NOK)', total: true },
  stock_value: { type: 'nok', nb: 'Lagerverdi (NOK)', en: 'Stock value (NOK)', total: true },
  unit_cost: { type: 'cost', nb: 'Enhetskost', en: 'Unit cost' },
  avg_cost: { type: 'cost', nb: 'Snittkost', en: 'Avg. cost' },
  total_cost: { type: 'nok', nb: 'Total kost (NOK)', en: 'Total cost (NOK)', total: true },
  prev_qty: { type: 'qty', nb: 'Antall forrige', en: 'Prev. qty', total: true },
  prev_value: { type: 'nok', nb: 'Verdi forrige', en: 'Prev. value', total: true },
  delta_qty: { type: 'qty', nb: 'Endring antall', en: 'Change qty', total: true },
  delta_value: { type: 'nok', nb: 'Endring verdi', en: 'Change value', total: true },
  occurred_at: { type: 'datetime', nb: 'Tidspunkt', en: 'When' },
  last_movement_at: { type: 'datetime', nb: 'Siste bevegelse', en: 'Last movement' },
  next_delivery: { type: 'date', nb: 'Neste levering', en: 'Next delivery' },
  type: {
    type: 'code', nb: 'Type', en: 'Type',
    values: {
      opening_balance: { nb: 'Åpningsbalanse', en: 'Opening balance' }, purchase_receipt: { nb: 'Varemottak', en: 'Purchase receipt' },
      sale: { nb: 'Salg', en: 'Sale' }, sale_return: { nb: 'Retur', en: 'Sale return' },
      adjustment_in: { nb: 'Justering +', en: 'Adjustment +' }, adjustment_out: { nb: 'Justering −', en: 'Adjustment −' },
      write_off: { nb: 'Svinn', en: 'Write-off' }, transfer_out: { nb: 'Flytting ut', en: 'Transfer out' },
      transfer_in: { nb: 'Flytting inn', en: 'Transfer in' }, reversal: { nb: 'Reversering', en: 'Reversal' },
    },
  },
  kind: { type: 'code', nb: 'Art', en: 'Kind' },
  cost_estimated: { type: 'bool', nb: 'Estimert', en: 'Estimated' },
  on_hand_after: { type: 'qty', nb: 'Etter', en: 'After' },
  reference: { type: 'text', nb: 'Referanse', en: 'Reference' },
  ref_type: { type: 'code', nb: 'Ref.type', en: 'Ref. type' },
  ref_id: { type: 'code', nb: 'Ref.id', en: 'Ref. id' },
  note: { type: 'text', nb: 'Notat', en: 'Note', grow: true },
  created_by: { type: 'text', nb: 'Av', en: 'By' },
  qty_sold: { type: 'qty', nb: 'Solgt', en: 'Sold', total: true },
  qty_returned: { type: 'qty', nb: 'Returnert', en: 'Returned', total: true },
  cogs: { type: 'nok', nb: 'Varekost (NOK)', en: 'COGS (NOK)', total: true },
  has_estimates: { type: 'bool', nb: 'Har estimat', en: 'Has estimates' },
  reorder_point: { type: 'qty', nb: 'Bestillingspunkt', en: 'Reorder point' },
  last_purchase_cost: { type: 'cost', nb: 'Siste innkjøpskost', en: 'Last purchase cost' },
  preferred_supplier: { type: 'text', nb: 'Foretrukket leverandør', en: 'Preferred supplier' },
  supplier_count: { type: 'int', nb: 'Ant. leverandører', en: 'Suppliers' },
  last_supplier: { type: 'text', nb: 'Siste leverandør', en: 'Last supplier' },
  last_unit_cost: { type: 'cost', nb: 'Siste pris', en: 'Last price' },
  last_currency: { type: 'code', nb: 'Valuta', en: 'Currency' },
  last_unit_cost_nok: { type: 'cost', nb: 'Siste pris (NOK)', en: 'Last price (NOK)' },
  supplier_sku: { type: 'code', nb: 'Lev. art.nr.', en: 'Supplier SKU' },
  pack_qty: { type: 'qty', nb: 'Pakning', en: 'Pack qty' },
  last_purchase_at: { type: 'date', nb: 'Sist kjøpt', en: 'Last purchased' },
  preferred: { type: 'bool', nb: 'Foretrukket', en: 'Preferred' },
};

/** Column list from standard keys ('sku') and/or overrides ({ key, nb, en, type, total }). */
export function cols(list) {
  return list.filter(Boolean).map((c) => {
    const o = typeof c === 'string' ? { key: c } : c;
    const base = STD[o.key] || { type: 'text', nb: o.key, en: o.key };
    return { ...base, ...o };
  });
}

const L = (x, lang) => (x == null ? '' : typeof x === 'object' ? (x[lang] ?? x.nb ?? x.en ?? '') : String(x));

// ── Value formatting (nb style: 1 234,56; dates in Europe/Oslo) ─────────────
function numText(v, min, max, lang) {
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(max);
  let [int, dec = ''] = fixed.split('.');
  dec = dec.replace(/0+$/, '');
  while (dec.length < min) dec += '0';
  const sep = lang === 'en' ? ',' : ' ';
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const s = dec ? `${int}${lang === 'en' ? '.' : ','}${dec}` : int;
  return (neg && Number(fixed) !== 0 ? '-' : '') + s;
}

function zoned(v, tz) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const pad = (x) => String(x).padStart(2, '0');

function cell(v, type, lang, tz) {
  if (v == null || v === '') return { v: null, kind: 'str', text: '' };
  if (NUMERIC.has(type)) {
    const x = Number(v);
    if (!Number.isFinite(x)) return { v: String(v), kind: 'str', text: String(v) };
    const text = type === 'nok' ? numText(x, 2, 2, lang)
      : type === 'cost' ? numText(x, 2, 4, lang)
        : type === 'int' ? numText(x, 0, 0, lang) : numText(x, 0, 3, lang);
    return { v: x, kind: 'num', text };
  }
  if (type === 'date' || type === 'datetime') {
    // Plain dates ('2026-10-31') are taken as they are; timestamps are shown in the shop's time zone.
    const z = /^\d{4}-\d{2}-\d{2}$/.test(String(v))
      ? { y: +String(v).slice(0, 4), m: +String(v).slice(5, 7), d: +String(v).slice(8, 10), h: 0, mi: 0, s: 0 }
      : zoned(v, tz);
    if (!z) return { v: String(v), kind: 'str', text: String(v) };
    const serial = (Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s) - Date.UTC(1899, 11, 30)) / 86400000;
    const text = `${z.y}-${pad(z.m)}-${pad(z.d)}${type === 'datetime' ? ` ${pad(z.h)}:${pad(z.mi)}` : ''}`;
    return { v: type === 'date' ? Math.floor(serial) : Math.round(serial * 86400) / 86400, kind: 'num', text };
  }
  if (type === 'bool') {
    const t = v === true || v === 'true' ? (lang === 'en' ? 'Yes' : 'Ja') : (lang === 'en' ? 'No' : 'Nei');
    return { v: t, kind: 'str', text: t };
  }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return { v: s, kind: 'str', text: s };
}

function stamp(d, tz) {
  const z = zoned(d, tz);
  return `${z.y}-${pad(z.m)}-${pad(z.d)} ${pad(z.h)}:${pad(z.mi)}`;
}

/** Builds the language/format-neutral document both writers use (exported for tests). */
export function buildDoc(report, { lang = 'nb', by = null, now = new Date(), tz } = {}) {
  const zone = tz || inventoryConfig.timezone || 'Europe/Oslo';
  const columns = report.columns.map((c) => ({
    key: c.key, type: c.type || 'text', label: L({ nb: c.nb, en: c.en }, lang) || c.key,
    align: NUMERIC.has(c.type) ? 'right' : 'left', grow: Boolean(c.grow), total: Boolean(c.total),
  }));
  const valueMaps = report.columns.map((c) => c.values || null);
  const rows = (report.rows || []).map((r) => columns.map((c, i) => {
    const raw = r[c.key];
    const mapped = valueMaps[i] && raw != null && valueMaps[i][raw] ? L(valueMaps[i][raw], lang) : raw;
    return cell(mapped, c.type, lang, zone);
  }));
  let totals = null;
  if (report.totals !== false && rows.length && columns.some((c) => c.total)) {
    totals = columns.map((c, i) => {
      if (c.total && NUMERIC.has(c.type)) {
        const s = rows.reduce((acc, r) => acc + (r[i].kind === 'num' ? r[i].v : 0), 0);
        return cell(Math.round(s * 1000) / 1000, c.type, lang, zone);
      }
      return { v: null, kind: 'str', text: '' };
    });
    const firstText = columns.findIndex((c) => !c.total);
    if (firstText >= 0) totals[firstText] = cell(`${lang === 'en' ? 'Total' : 'Sum'} (${rows.length.toLocaleString('nb-NO')} ${lang === 'en' ? 'lines' : 'linjer'})`, 'text', lang, zone);
  }
  const metaLines = (report.meta || [])
    .filter(([, v]) => v != null && v !== '' && v !== false)
    .map(([k, v]) => `${L(k, lang)}: ${L(v, lang)}`);
  const generated = `${lang === 'en' ? 'Generated' : 'Generert'} ${stamp(now, zone)}${by ? ` ${lang === 'en' ? 'by' : 'av'} ${by}` : ''}`;
  metaLines.push(generated);
  const title = L(report.title, lang) || report.name;
  return {
    title, metaLines, columns, rows, totals,
    sheetName: L(report.sheet, lang) || (lang === 'en' ? 'Report' : 'Rapport'),
    orientation: report.orientation || 'auto',
    footer: `${title} · ${generated}`,
    pageLabel: (i, n) => (lang === 'en' ? `Page ${i} of ${n}` : `Side ${i} av ${n}`),
    emptyText: lang === 'en' ? 'No lines' : 'Ingen linjer',
  };
}

const fileSafe = (s) => String(s || 'export').normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'export';

/**
 * Sends a report as csv | xlsx | pdf.
 * report: { name, title, meta?, columns (from cols()), rows, csvColumns?: string[] | 'all', totals?: false, orientation?, sheet? }
 * ctx: the route ctx (by, query) — used for "Generated … by …" and ?lang=.
 */
export function sendExport(res, format, report, ctx = {}) {
  const lang = ['nb', 'en'].includes(ctx.query?.lang) ? ctx.query.lang : (inventoryConfig.exportLanguage || 'nb');
  let body;
  if (format === 'csv') {
    const keys = report.csvColumns === 'all' ? undefined : (report.csvColumns || report.columns.map((c) => c.key));
    body = toCsv(report.rows || [], keys);
  } else {
    const doc = buildDoc(report, { lang, by: ctx.by });
    body = format === 'xlsx' ? toXlsx(doc) : toPdf(doc);
  }
  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${fileSafe(report.name)}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(body);
}

/** 'YYYY-MM' → { nb: 'oktober 2026', en: 'October 2026' } for titles. */
export function periodLabel(period) {
  const d = new Date(`${period}-15T12:00:00Z`);
  const f = (loc) => d.toLocaleDateString(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { nb: f('nb-NO'), en: f('en-GB') };
}

/** Standard columns for movement journals (GET /movements, /items/:sku/movements, /suppliers/:s/movements). */
export const MOVEMENT_CSV = ['id', 'occurred_at', 'sku', 'item_name', 'location', 'type', 'kind', 'qty',
  'unit_cost', 'total_cost', 'cost_estimated', 'on_hand_after', 'reference', 'ref_type', 'ref_id', 'note', 'created_by'];
export function movementColumns() {
  return cols(['occurred_at', 'sku', 'item_name', 'location', 'type', { key: 'qty', total: false }, 'unit_cost',
    { key: 'total_cost', total: false }, 'on_hand_after', 'reference', 'created_by']);
}
/** Filter lines for movement exports, from the route query. */
export function movementMeta(query, extra = []) {
  return [
    ...extra,
    [{ nb: 'Fra', en: 'From' }, query.from || null], [{ nb: 'Til', en: 'To' }, query.to || null],
    [{ nb: 'SKU', en: 'SKU' }, query.skus || query.sku || null],
    [{ nb: 'Type', en: 'Type' }, query.type || query.kind || null],
    [{ nb: 'Lokasjon', en: 'Location' }, query.location ? String(query.location).toUpperCase() : null],
    [{ nb: 'Søk', en: 'Search' }, query.q || null],
  ];
}
