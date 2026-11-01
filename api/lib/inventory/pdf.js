// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Minimal PDF writer (no dependencies) for report tables: A4, portrait or landscape picked from
// the column widths, title block on page 1, the header row repeated on every page, zebra rows,
// a bold totals row and "page n of N" in the footer. Uses the PDF base fonts Helvetica /
// Helvetica-Bold with WinAnsiEncoding (covers Norwegian æøå). Called through export.js only.
import zlib from 'node:zlib';

const WIDTHS = [
  // Helvetica, char codes 32–255 (WinAnsi), 1/1000 em
  [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,761,556,556,222,556,333,1000,556,556,333,1000,667,333,1000,556,611,556,556,222,222,333,333,350,556,1000,333,1000,500,333,944,556,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],
  // Helvetica-Bold
  [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,761,556,611,278,556,500,1000,556,556,333,1000,667,333,1000,611,611,611,611,278,278,500,500,350,556,1000,333,1000,556,333,944,611,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556],
];

const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  0x2212: 0x2d, 0x00a0: 0x20, 0x202f: 0x20, 0x2009: 0x20, 0x0394: 0x44, 0x2192: 0x3e,
};

/** JS string → WinAnsi byte string (one char per byte). Unknown characters become '?'. */
export function winAnsi(s) {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (c < 32) out += ' ';
    else if (CP1252[c] != null) out += String.fromCharCode(CP1252[c]);
    else if (c < 256 && !(c >= 0x7f && c < 0xa0)) out += ch;
    else out += '?';
  }
  return out;
}

function width(bytes, bold, size) {
  const w = WIDTHS[bold ? 1 : 0];
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes.charCodeAt(i);
    sum += c >= 32 ? w[c - 32] : 0;
  }
  return (sum * size) / 1000;
}

function fit(bytes, bold, size, max) {
  if (width(bytes, bold, size) <= max + 0.01) return bytes;
  const ell = '\x85';
  let s = bytes;
  while (s.length > 0 && width(s + ell, bold, size) > max + 0.01) s = s.slice(0, -1);
  return s + ell;
}

const pdfStr = (bytes) => `(${bytes.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
const n = (x) => (Math.round(x * 100) / 100).toString();

const A4 = [595.28, 841.89];
const M = 34;          // page margin
const PAD = 4;         // cell padding (each side)

/**
 * doc: { title, metaLines: string[], footer: string, pageLabel: (i, total) => string,
 *        columns: [{ label, align: 'left'|'right', grow?: boolean }],
 *        rows: [[{ text }…]], totals: [{ text }…] | null, orientation?: 'auto'|'portrait'|'landscape' }
 */
export function toPdf(doc) {
  let size = 8;
  const cols = doc.columns.map((c) => ({ ...c, label: winAnsi(c.label) }));
  const rows = doc.rows.map((r) => r.map((x) => winAnsi(x.text)));
  const totals = doc.totals ? doc.totals.map((x) => winAnsi(x.text)) : null;

  // Natural column widths from the content
  const natural = cols.map((c, i) => {
    let w = width(c.label, true, size);
    for (const r of rows.slice(0, 3000)) w = Math.max(w, width(r[i], false, size));
    if (totals) w = Math.max(w, width(totals[i], true, size));
    return Math.min(w + 2 * PAD + 1, c.grow ? 230 : 140);
  });
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const landscape = doc.orientation === 'landscape'
    || (doc.orientation !== 'portrait' && sum(natural) > A4[0] - 2 * M);
  const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
  const avail = pw - 2 * M;

  let widths = [...natural];
  if (sum(widths) > avail) {
    // Shrink text columns first (down to 60pt), then everything incl. the font size.
    const flex = widths.map((w, i) => (cols[i].align !== 'right' && w > 60 ? w - 60 : 0));
    const over = sum(widths) - avail;
    if (sum(flex) > 0) widths = widths.map((w, i) => w - (flex[i] / sum(flex)) * Math.min(over, sum(flex)));
    if (sum(widths) > avail) {
      // Scale the content part (not the padding) together with the font size, so labels still fit.
      const k = (avail - 2 * PAD * widths.length) / (sum(widths) - 2 * PAD * widths.length);
      widths = widths.map((w) => 2 * PAD + (w - 2 * PAD) * k);
      size = Math.max(5.5, size * k);
    }
  } else if (sum(widths) < avail) {
    // Give spare room to the growing (name) columns so the table spans the page.
    const grow = cols.map((c) => (c.grow ? 1 : 0));
    const spare = avail - sum(widths);
    if (sum(grow)) widths = widths.map((w, i) => w + (grow[i] / sum(grow)) * spare);
  }
  const xs = widths.map((_, i) => M + sum(widths.slice(0, i)));
  const rowH = size + 5;
  const headH = size + 8;

  const pages = [];
  let ops = [];
  let y = 0;
  const text = (s, x, yy, { bold = false, sz = size, gray = 0.1 } = {}) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(sz)} Tf ${gray} g ${n(x)} ${n(yy)} Td ${pdfStr(s)} Tj ET`);
  const rect = (x, yy, w, h, gray) => ops.push(`${gray} g ${n(x)} ${n(yy)} ${n(w)} ${n(h)} re f`);
  const line = (x1, y1, x2, y2, gray = 0.75, lw = 0.5) => ops.push(`${gray} G ${lw} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  const cellText = (s, i, yy, bold) => {
    const t = fit(s, bold, size, widths[i] - 2 * PAD);
    const x = cols[i].align === 'right' ? xs[i] + widths[i] - PAD - width(t, bold, size) : xs[i] + PAD;
    text(t, x, yy, { bold });
  };
  const header = () => {
    rect(M, y - headH, avail, headH, 0.93);
    cols.forEach((c, i) => cellText(c.label, i, y - headH + 4, true));
    line(M, y - headH, M + avail, y - headH, 0.6);
    y -= headH;
  };
  const newPage = (first) => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    y = ph - M;
    if (first) {
      text(winAnsi(doc.title), M, y - 14, { bold: true, sz: 14 });
      y -= 22;
      for (const m of doc.metaLines) { text(fit(winAnsi(m), false, 8.5, avail), M, y - 9, { sz: 8.5, gray: 0.4 }); y -= 12; }
      y -= 8;
    } else {
      text(fit(winAnsi(doc.title), true, 8, avail), M, y - 8, { bold: true, sz: 8, gray: 0.4 });
      y -= 16;
    }
    header();
  };

  newPage(true);
  const bottom = M + 18;
  rows.forEach((r, ri) => {
    if (y - rowH < bottom) newPage(false);
    if (ri % 2 === 1) rect(M, y - rowH, avail, rowH, 0.975);
    r.forEach((s, i) => cellText(s, i, y - rowH + 3.5, false));
    y -= rowH;
  });
  if (totals) {
    if (y - rowH - 2 < bottom) newPage(false);
    line(M, y - 1, M + avail, y - 1, 0.3, 0.8);
    y -= 2;
    totals.forEach((s, i) => cellText(s, i, y - rowH + 3.5, true));
    y -= rowH;
  }
  if (!rows.length) text(winAnsi(doc.emptyText || '—'), M + PAD, y - rowH + 3.5, { gray: 0.5 });
  pages.push(ops.join('\n'));

  // Footer on every page (needs the page count)
  const contents = pages.map((p, i) => {
    const label = winAnsi(doc.pageLabel ? doc.pageLabel(i + 1, pages.length) : `${i + 1} / ${pages.length}`);
    const foot = winAnsi(doc.footer || '');
    return `${p}\n0.6 G 0.4 w ${n(M)} ${n(M + 10)} m ${n(pw - M)} ${n(M + 10)} l S`
      + `\nBT /F1 7 Tf 0.45 g ${n(M)} ${n(M)} Td ${pdfStr(fit(foot, false, 7, avail - 80))} Tj ET`
      + `\nBT /F1 7 Tf 0.45 g ${n(pw - M - width(label, false, 7))} ${n(M)} Td ${pdfStr(label)} Tj ET`;
  });

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then (page, content) pairs
  const objs = [];
  const kids = contents.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const d = new Date();
  const pd = `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
  objs.push(`<< /Title <FEFF${Buffer.from(String(doc.title), 'utf16le').swap16().toString('hex').toUpperCase()}> /Producer (inventory-ledger) /CreationDate (${pd}) >>`);
  for (const [i, c] of contents.entries()) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pw)} ${n(ph)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`);
    objs.push({ stream: zlib.deflateSync(Buffer.from(c, 'latin1')) });
  }

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pos);
    const parts = typeof o === 'string'
      ? [Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]
      : [Buffer.from(`${i + 1} 0 obj\n<< /Length ${o.stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
    for (const p of parts) { chunks.push(p); pos += p.length; }
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
