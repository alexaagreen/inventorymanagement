#!/usr/bin/env node
// inventory-ledger installer — kopierer modulen inn i butikkens repoer.
//
//   node scripts/install.mjs --api ../bark-internal-web --migrations ../barkavenue/supabase/migrations
//   node scripts/install.mjs --api ../bark-internal-web --check          # CI i butikken: feiler ved lokale endringer
//   node scripts/install.mjs ... --dry-run                               # vis hva som ville skjedd
//
// Regler (CLAUDE.md): dette repoet er master. Kopierte filer redigeres aldri i butikken.
//   --api <dir>         internal-web: lib/inventory/* + pages/api/inventory/** (+ config.js én gang)
//   --migrations <dir>  nettbutikkens supabase/migrations: <timestamp>_<NNNN>_inv_*.sql
//                       (inv bor ALLTID i samme Supabase som nettbutikken)
//   --force             overskriv kopierte filer som er endret lokalt
//
// Låsefiler: <api>/inventory-ledger.lock.json og <migrations>/../inventory-ledger.migrations.lock.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(name);
const API = opt('--api') ? path.resolve(opt('--api')) : null;
const MIG = opt('--migrations') ? path.resolve(opt('--migrations')) : null;
const DRY = flag('--dry-run');
const CHECK = flag('--check');
const FORCE = flag('--force');

if (!API && !MIG) {
  console.error('Usage: install.mjs [--api <internal-web dir>] [--migrations <supabase/migrations dir>] [--check] [--dry-run] [--force]');
  process.exit(2);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (p) => path.relative(process.cwd(), p) || '.';
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function sourceCommit() {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; }
}
function write(target, buf) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
}

let problems = 0;
const log = (s) => console.log(s);

// ── API (internal-web) ──────────────────────────────────────────────────────
function installApi() {
  if (!fs.existsSync(path.join(API, 'package.json'))) throw new Error(`${API} does not look like a Next.js app (no package.json)`);
  const lockPath = path.join(API, 'inventory-ledger.lock.json');
  const lock = readJson(lockPath, { files: {} });
  const files = [];

  for (const src of walk(path.join(ROOT, 'api/lib/inventory'))) {
    const name = path.basename(src);
    if (name === 'config.js' || name === 'config.example.js') continue;
    files.push({ src, dest: path.join('lib/inventory', name) });
  }
  for (const src of walk(path.join(ROOT, 'api/pages/api/inventory'))) {
    files.push({ src, dest: path.relative(path.join(ROOT, 'api'), src) });
  }

  const newLock = { module: 'inventory-ledger', version: VERSION, source_commit: sourceCommit(),
    installed_at: new Date().toISOString(), files: {} };
  let copied = 0; let same = 0;
  for (const f of files) {
    const target = path.join(API, f.dest);
    const buf = fs.readFileSync(f.src);
    const want = sha(buf);
    newLock.files[f.dest] = want;
    const exists = fs.existsSync(target);
    const cur = exists ? sha(fs.readFileSync(target)) : null;
    const locked = lock.files?.[f.dest];

    if (CHECK) {
      if (!exists) { log(`  ✗ missing   ${f.dest}`); problems++; }
      else if (locked && cur !== locked) { log(`  ✗ modified  ${f.dest} (edited in the shop repo — change upstream instead)`); problems++; }
      else if (cur !== want) log(`  • outdated  ${f.dest} (module ${VERSION} differs — run install)`);
      continue;
    }
    if (exists && locked && cur !== locked && cur !== want && !FORCE) {
      log(`  ✗ refusing  ${f.dest} — modified locally since last install (use --force to overwrite)`);
      problems++; continue;
    }
    if (cur === want) { same++; continue; }
    write(target, buf); copied++;
    log(`  ${exists ? '↻' : '+'} ${f.dest}`);
  }

  // Filer som var installert før, men er fjernet i modulen
  for (const old of Object.keys(lock.files || {})) {
    if (!newLock.files[old] && fs.existsSync(path.join(API, old))) {
      log(`  ! removed upstream: ${old} — delete it in the shop repo`);
    }
  }

  // config.js én gang
  const cfg = path.join(API, 'lib/inventory/config.js');
  if (!fs.existsSync(cfg)) {
    if (CHECK) { log('  ✗ missing   lib/inventory/config.js'); problems++; }
    else { write(cfg, fs.readFileSync(path.join(ROOT, 'api/lib/inventory/config.example.js'))); log('  + lib/inventory/config.js (from config.example.js — shop-owned from now on)'); }
  }

  if (!CHECK && !DRY && problems === 0) fs.writeFileSync(lockPath, JSON.stringify(newLock, null, 2) + '\n');
  if (!CHECK) log(`API → ${rel(API)}: ${copied} written, ${same} unchanged${DRY ? ' (dry run)' : ''}`);
}

// ── Migrasjoner (nettbutikkens Supabase) ────────────────────────────────────
function tsUtc(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function installMigrations() {
  if (!fs.existsSync(MIG)) throw new Error(`${MIG} does not exist`);
  const lockPath = path.join(path.dirname(MIG), 'inventory-ledger.migrations.lock.json');
  const lock = readJson(lockPath, { migrations: {} });
  const existing = fs.readdirSync(MIG).filter((n) => n.endsWith('.sql'));
  const byModuleName = new Map();
  for (const n of existing) {
    const m = /^(\d{14})_(\d{4}_inv_.+\.sql)$/.exec(n);
    if (m) byModuleName.set(m[2], n);
  }
  const lastTs = existing.map((n) => /^(\d{14})_/.exec(n)?.[1]).filter(Boolean).sort().pop() || '0';
  let next = Math.max(Date.now(), lastTs !== '0' ? Date.UTC(+lastTs.slice(0, 4), +lastTs.slice(4, 6) - 1, +lastTs.slice(6, 8), +lastTs.slice(8, 10), +lastTs.slice(10, 12), +lastTs.slice(12, 14)) + 1000 : 0);

  const newLock = { module: 'inventory-ledger', version: VERSION, installed_at: new Date().toISOString(), migrations: { ...(lock.migrations || {}) } };
  let added = 0;
  const srcs = fs.readdirSync(path.join(ROOT, 'migrations')).filter((n) => /^\d{4}_inv_.+\.sql$/.test(n)).sort();
  for (const name of srcs) {
    const buf = fs.readFileSync(path.join(ROOT, 'migrations', name));
    const want = sha(buf);
    const have = byModuleName.get(name);
    if (have) {
      const cur = sha(fs.readFileSync(path.join(MIG, have)));
      if (cur !== want) {
        log(`  ✗ ${have} differs from module ${name} — shipped migrations are immutable; add a new migration upstream instead`);
        problems++;
      }
      continue;
    }
    if (CHECK) { log(`  • pending   ${name} (not installed yet)`); continue; }
    const fname = `${tsUtc(new Date(next))}_${name}`;
    next += 1000;
    write(path.join(MIG, fname), buf);
    newLock.migrations[name] = { file: fname, sha256: want, version: VERSION };
    added++;
    log(`  + ${fname}`);
  }
  if (!CHECK && !DRY && problems === 0) fs.writeFileSync(lockPath, JSON.stringify(newLock, null, 2) + '\n');
  if (!CHECK) log(`Migrations → ${rel(MIG)}: ${added} added${DRY ? ' (dry run)' : ''}`);
}

log(`inventory-ledger ${VERSION}${CHECK ? ' — check' : ''}`);
try {
  if (API) installApi();
  if (MIG) installMigrations();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (problems) { console.error(`\n${problems} problem(s).`); process.exit(1); }
