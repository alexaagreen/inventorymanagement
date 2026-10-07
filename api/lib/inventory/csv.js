// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// CSV for norsk Excel: UTF-8 med BOM, semikolon, desimalkomma.

function cell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  if (typeof v === 'boolean') return v ? 'ja' : 'nei';
  if (typeof v === 'object') v = JSON.stringify(v);
  let s = String(v);
  // Tall som streng fra pg (numeric) → desimalkomma
  if (/^-?\d+\.\d+$/.test(s)) s = s.replace('.', ',');
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(rows, columns) {
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.join(';')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(toCsv(rows, columns));
}
