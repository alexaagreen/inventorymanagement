# inventory-ledger — Project Memory

Plug-and-play FIFO-varelager for alle nettbutikkene (Skarpekniver, Bark, …).
Erstatter Cin7/DEAR som lagermaster. Full spesifikasjon: **`docs/spec.md`** — les
den før du endrer noe. Denne fila er inngangen og reglene.

## Dette repoet er MASTER (ikke-forhandlingsbart)

1. **All endring i modulen gjøres her, via pull request mot `main`.** Ingen direkte
   push til `main`. CI (`.github/workflows/ci.yml`) kjører migrasjonene fra scratch
   og hele testsuiten før merge.
2. **Butikk-repoene puller herfra — de skriver aldri tilbake.** Etter merge tagges en
   versjon (`vX.Y.Z`), og hver butikk installerer med `scripts/install.mjs` (fase 5).
3. **Kopierte filer redigeres aldri i et butikk-repo.** Feil oppdaget i en butikk →
   fiks her → PR → merge → tag → install. Hver kopiert fil har header
   `inventory-ledger vX.Y.Z — DO NOT EDIT in the shop repo`.
4. **Butikk-spesifikt bor i butikken** (katalog-adapter, `lib/inventory/config.js`,
   env, cron-registrering, UI).
5. Agenter som jobber i et butikk-repo og trenger en endring her: stopp og si fra,
   eller åpne PR her. Ikke patch kopien.

## Arkitektur i én setning

All forretningslogikk bor i Postgres (schema `inv`): tabeller, FIFO-funksjoner,
views og triggere. API-laget (`api/`) er et tynt HTTP↔jsonb-lag. UI bygges per butikk
og snakker bare HTTP mot `/api/inventory/*`.

## Layout

| Sti | Innhold |
|---|---|
| `migrations/0001_inv_schema.sql` | typer, tabeller, indekser, triggere (immutabel ledger), seed |
| `migrations/0002_inv_functions.sql` | FIFO-kjernen (`_post_in`/`_post_out`), dokumenter, reversering, vedlikehold |
| `migrations/0003_inv_views.sql` | `v_item_status`, `v_stock_by_location`, `v_movement`, `v_open_consumption` |
| `migrations/0004_inv_woo.sql` | Woo-tilstandsmaskin (`apply_woo_order`/`apply_woo_refund`), push-kø, webhook-logg, `upsert_items` |
| `tests/sql/` | akseptansetester (spec §10), én fil per scenario, `_helpers.sql` |
| `scripts/db-reset.sh` | dropper `inv` og kjører alle migrasjoner (nekter mot remote Supabase) |
| `scripts/test-sql.sh` | kjører alle SQL-tester, fersk DB per fil |
| `api/` | HTTP-laget (fase 3+) |
| `docs/spec.md` | spesifikasjonen |

## Kjøre lokalt

```bash
# Hvilken som helst Postgres ≥ 15 (Supabase kjører 15). Eksempel med lokal Supabase:
supabase start            # DB på postgres://postgres:postgres@localhost:54322/postgres
export DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres
npm run test:sql          # = scripts/test-sql.sh
```

## Konvensjoner i SQL

- Offentlige funksjoner tar/returnerer `jsonb`. Interne har `_`-prefiks og typede args.
- Feil: `inv._raise('<CODE>', 'tekst', '{detaljer}')` → `P0001`, message `CODE: tekst`,
  detail = json. Kodene og HTTP-mapping står i spec §6.0. Nye koder:
  `ALREADY_REVERSED` (409).
- Alle skrivinger låser `inv.stock_balance` (item × location) `FOR UPDATE` før de leser
  beholdning — det er det som gjør `new_qty` trygt under samtidighet (T18).
- `inv.movement` er append-only (trigger). Kun kostfelter, `reversed_by`, `metadata`
  og én-gangs-setting av `on_hand_after` er tillatt.
- **Snapshot-fallgruve:** `STABLE`-funksjoner (f.eks. `_movement_json`) ser ikke rader
  skrevet i samme setning. Skriv først (`v_id := ...`), returner JSON i neste setning.
- Migrasjoner er idempotente der det er praktisk og har header `-- inventory-ledger vX.Y.Z`.

## Woo-ordre i ledgeren (kort)

`inv.woo_order_sync.lines` holder per ordrelinje `ordered` (sist sett antall), `net` (netto trukket),
`refunded` og `seq`. Mål ved trekk-status: `net = ordered − refunded`. Første salg har
`ref_line = <line_id>`, påfølgende `<line_id>:<seq>`, returer `<line_id>:r<seq>`, refusjoner
`ref_type='woo_refund', ref_id=<refund_id>`. Restore-status returnerer `net`. Push-køen fylles av
trigger på `inv.movement`; workeren claimer rader i 2 min (`list_stock_push_due`).

## Avvik fra spec (bevisste)

- `adjustment_line.revalue_out_movement_id` — ekstra kolonne for revaluering (to bevegelser per linje).
- `cost_layer.source_layer_id` — sporbarhet ved overføring/reversering.
- `inv.preview_adjustment(p)` — kjører `create_adjustment` i en subtransaksjon som rulles tilbake.
- `restore_statuses` inkluderer `failed`.
- `stock_push_queue.claimed_until` i stedet for `SKIP LOCKED` over HTTP-kall (claim holder på tvers av transaksjoner).
- Ukjent `inv_location` i ordre-meta faller tilbake til default-lokasjon i stedet for å feile.
- PO-nummer har 5 siffer (`PO-00001`); sett `inv.po_number_seq` ved installasjon.
