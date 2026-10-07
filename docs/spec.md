# Inventory Ledger — spesifikasjon v1

> Plug-and-play varelagermodul (FIFO) for alle nettbutikkene. Installeres som Postgres-schema `inv` i hver butikks Supabase + et tynt HTTP-API i hver butikks internal-web. All forretningslogikk ligger i Postgres-funksjoner, slik at API-laget er trivielt å kopiere og UI kan bygges fritt per butikk.
>
> Erstatter rollen Cin7/DEAR har i dag for Skarpekniver (lagermaster, PO, varemottak, stock adjustment, movements). Produktmaster er WooCommerce.

Status: **v0.5.0 implementert** (fase 1–4 + installasjon). Endringer etter v0.4.0 er merket «v0.5». Dato: 2026-10-07. Eier: Alexander.

---

## 0. Beslutninger som ligger til grunn

| Spørsmål | Beslutning |
|---|---|
| Pakking | Schema `inv` + Postgres-funksjoner som SQL-migrasjoner i **samme Supabase som butikkens nettbutikk** (besluttet 2026-10-07; migrasjonene ligger i nettbutikk-repoet, API/UI i internal-web). HTTP-ruter som kopierbar pakke (Pages Router, samme mønster som `internal-web` og `bark-internal-web`). Ingen multi-tenant; `tenant_id` finnes ikke. |
| Kildekode | **Eget repo `inventory-ledger` er master.** All endring går via PR dit først; butikk-repoene puller versjonerte kopier inn (install-script + lock-fil) og redigerer aldri de kopierte filene lokalt. Se §11.2. |
| Lokasjoner | Flere lokasjoner støttes fra dag én (lager, butikk, …), men installasjonen seeder én default-lokasjon (`MAIN`) og alle API-kall kan utelate `location` — da brukes default. En butikk med én lokasjon skal aldri trenge å forholde seg til begrepet. |
| Lagermaster | **Ledgeren er master for beholdning.** Etter hver bevegelse pushes tilgjengelig antall til Woo `stock_quantity` (som Cin7 gjør i dag). |
| Produktmaster | **WooCommerce.** Varer (SKU, Woo product/variation-id, navn, manage_stock) synces inn i `inv.item`. Ledgeren oppretter aldri produkter i Woo. |
| Salgstidspunkt | Woo-ordre trekker lageret **ved ordre opprettet** (status `processing`/`on-hold`/`completed`). Ingen allokering/reservasjon i v1. Kansellering/refusjon legger varen tilbake. |
| Kostmetode | **FIFO** per (vare × lokasjon). Kostlag (cost layers) opprettes ved hver inngående bevegelse; utgående bevegelser konsumerer lag eldst-først og får eksakt COGS. |
| Basisvaluta | Én basisvaluta per installasjon (`inv.settings.base_currency`, NOK). PO kan være i JPY/EUR/USD; kost konverteres til basisvaluta ved varemottak og logges på mottakslinjen og bevegelsen. |
| Negativ beholdning | Tillatt for **salg** (Woo kan selge mer enn vi har — se `NEGATIV_LAGER_HANDOFF.md`). Ikke tillatt for justering ned, overføring, write-off. Negativ beholdning kostes estimert og korrigeres automatisk ved neste varemottak (§3.5). |

---

## 1. Kontekst — hva vi erstatter

Dagens Skarpekniver-rigg (`internal-web`):

| Funksjon i dag | Kode | Hva ledgeren overtar |
|---|---|---|
| Beholdning per SKU (`products.current_stock`, `average_cost`) synces daglig fra Cin7 `/product` + `/ref/productavailability` | `pages/api/cron/sync-products.js` | `inv.v_item_status` erstatter `current_stock`/`average_cost`. `products`-tabellen kan fortsatt eksistere, men lagerfeltene leses fra ledgeren. |
| Stock adjustment: hent OnHand fra Cin7, skriv ABSOLUTT ny verdi per lokasjon via `POST /stockadjustment`, samtidig `PUT stock_quantity` i Woo | `lib/stock-adjust.js` (`adjustStockForSend`, `applyStockDelta`, `zeroStock`) | `POST /api/inventory/adjustments` (delta eller `new_qty`). Woo-push skjer automatisk via outbox. |
| PO opprettes i Cin7 (`DearApi/Purchase`, Approach STOCK), varemottak via `/purchase/stock` | `lib/cin7.js > createPurchaseOrder`, `pages/api/cin7/stock-receive.js`, `lib/pending-po.js`, `lib/varemottak.js` | `inv.purchase_order` + `/receive`. `pending_po` (leverandørbekreftelse via token) og `goods_receipt_confirmations` beholdes som UI-flyt, men finaliserer mot ledgeren i stedet for Cin7. |
| Movements per SKU hentes med `GET /product?SKU=&IncludeMovements=true` (ikke paginerbart, 9 s for 3 400 rader, 5 min cache) | `lib/cin7-movements.js`, `pages/api/lager/movements.js` | `GET /api/inventory/movements` med filter og cursor-paginering, direkte fra DB. |
| Stock adjustment-liste (`/stockadjustmentlist` + detalj per TaskID, rate-limit 1 req/1,2 s) | `lib/cin7-stock-adjustments.js`, `pages/stock-adjustments` | `GET /api/inventory/adjustments`. |

Lærdommer fra Cin7 som er tatt inn i designet: beholdning er alltid avledet av transaksjoner (ingen «sett lager»-felt); Available = On Hand − Allocated (vi har Allocated = 0 i v1, men kolonnen finnes); On Order (autoriserte PO ikke mottatt) er en egen kolonne og inngår ikke i Available; FIFO-rekkefølge styres av mottaksdato, ikke autorisasjonsdato; ved justering OPP på vare med beholdning brukes eksisterende kost (vi bruker snittkost av det som ligger inne — Alexanders regel), ved justering NED konsumeres eksisterende lag; «Sale COGS Change»/«Purchase Cost Change» er regnskapsposteringer uten antall, som vi modellerer som `inv.cogs_correction` i stedet for å forurense bevegelsesloggen.

Produktspeilet i Supabase finnes allerede for Skarpekniver (`skarpekniverv3/supabase/migrations/20260422120000_initial_catalog.sql`: `public.products` med Woo-ID som PK, `public.product_variations`, webhook `app/api/webhooks/woo/route.ts`, reconciliation-cron). Bark har tilsvarende Woo→Supabase-rigg. Ledgeren **leser** fra dette speilet for å fylle `inv.item`, men er ikke avhengig av at speilet har en bestemt form (se §7.1).

---

## 2. Datamodell (schema `inv`)

Alle tabeller i schema `inv`. Alle `id` er `uuid default gen_random_uuid()` med mindre annet er sagt. Alle tabeller har `created_at timestamptz not null default now()`; tabeller som kan oppdateres har `updated_at` med `set_updated_at`-trigger. Antall er `numeric(14,3)` (heltall i praksis, men klar for kg/meter), enhetskost `numeric(14,4)`, beløp `numeric(14,2)`.

### 2.1 `inv.settings`
Key/value, én rad per nøkkel. Seedes ved installasjon.

| key | default | betydning |
|---|---|---|
| `base_currency` | `NOK` | Valuta for all kost i ledgeren. |
| `allow_negative_sale` | `true` | Om salg kan trekke beholdning under 0. |
| `woo_push_enabled` | `true` | Om outbox-worker skal pushe til Woo. |
| `woo_push_floor_zero` | `true` | Push `max(available, 0)` til Woo (Woo-negativt lager bare hvis `false`). |
| `po_number_prefix` | `PO-` | Prefix for PO-nummer. Sekvensen `inv.po_number_seq` settes per butikk (Skarpekniver fortsetter etter siste Cin7-nummer). |
| `deduct_statuses` | `processing,on-hold,completed` | Woo-statuser som trekker lager. |
| `restore_statuses` | `cancelled,refunded,trash` | Woo-statuser som legger tilbake. |

### 2.2 `inv.location`

| kolonne | type | merknad |
|---|---|---|
| id | uuid pk | |
| code | text unique not null | f.eks. `MAIN`, `BUTIKK` (upper, ingen mellomrom) |
| name | text not null | |
| is_default | bool | nøyaktig én rad (partial unique index `where is_default`) |
| sellable_online | bool default true | inngår i `available` som pushes til Woo |
| active | bool default true | |

Seed: `('MAIN','Hovedlager', is_default=true)`.

### 2.3 `inv.item` — varer (speil av Woo-produktmaster)

| kolonne | type | merknad |
|---|---|---|
| id | uuid pk | intern id; alle bevegelser peker hit |
| sku | text not null | unique index på `upper(btrim(sku))` |
| woo_product_id | bigint | Woo product id (parent ved variasjon) |
| woo_variation_id | bigint | null for simple |
| name | text | |
| track_stock | bool default true | = Woo `manage_stock`. `false` → aldri push, bevegelser tillatt men flagges |
| active | bool default true | Woo status `publish`/`private`; `false` ved sletting |
| reorder_point | numeric | valgfritt (tilsvarer Cin7 `MinimumBeforeReorder`) |
| reorder_qty | numeric | |
| attributes | jsonb default '{}' | fri (brand, kategori, …) for UI-filtre |
| synced_at | timestamptz | |

Unique `(woo_product_id, woo_variation_id) nulls not distinct`. Et variabelt Woo-produkt er **ikke** en item — hver variasjon er en item. Bundles/`bundle_components` i v3 er utenfor v1 (komponentene er egne items; selve bundle-SKU-en registreres med `track_stock=false`).

### 2.4 `inv.movement` — selve ledgeren (append-only)

| kolonne | type | merknad |
|---|---|---|
| id | bigserial pk | kronologisk, brukes som cursor |
| item_id | uuid fk | |
| location_id | uuid fk | |
| type | `inv.movement_type` | se §4 |
| qty | numeric(14,3) not null, `<> 0` | **signert**. Inn > 0, ut < 0. Check-constraint på fortegn per type. |
| unit_cost | numeric(14,4) | inn: kost per enhet i basisvaluta. ut: vektet COGS per enhet (avledet av konsumerte lag) |
| total_cost | numeric(14,2) | `abs(qty) × unit_cost` (for ut: Σ konsum) |
| cost_estimated | bool default false | `true` når deler av uttaket gikk under 0 og kostes estimert (§3.5) |
| cost_source | text | `manual` / `po_line` / `on_hand_avg` / `on_hand_avg_all` / `last_purchase` / `last_known` / `fifo` / `transfer` / `reversal` / `unknown` |
| on_hand_after | numeric | beholdning på lokasjonen rett etter bevegelsen (snapshot, gjør movements-lista lesbar uten utregning) |
| ref_type | text | `woo_order`, `woo_refund`, `purchase_order`, `goods_receipt`, `adjustment`, `transfer`, `manual_sale`, `opening_balance`, `reversal` |
| ref_id | text | f.eks. Woo order id, `inv.goods_receipt.id` |
| ref_line | text | linje-id innenfor ref (Woo line_item id, receipt_line id) |
| reference | text | menneskelesbar (PO-nummer, ordrenummer) |
| note | text | |
| created_by | text | brukernavn/e-post eller `system:woo-webhook` |
| occurred_at | timestamptz not null default now() | forretningstidspunkt (mottaksdato o.l.) |
| reversal_of | bigint fk inv.movement | satt på reverserings-bevegelsen |
| reversed_by | bigint fk inv.movement | satt på originalen når den er reversert |
| metadata | jsonb default '{}' | fri |

Indekser: `(item_id, occurred_at desc, id desc)`, `(location_id, id desc)`, `(type, id desc)`, `(ref_type, ref_id)`, og **unique `(ref_type, ref_id, ref_line) where ref_type is not null`** — dette er idempotensnøkkelen for webhooks og retry.

Rader i `inv.movement` **oppdateres aldri** med unntak av kostfeltene (`unit_cost`, `total_cost`, `cost_estimated`, `cost_source`) når estimert kost blir dekket (§3.5), og `reversed_by`. Ingen DELETE. Håndheves med trigger som avviser andre UPDATE/DELETE.

### 2.5 `inv.cost_layer` — FIFO-lag

| kolonne | type | merknad |
|---|---|---|
| id | bigserial pk | |
| item_id, location_id | fk | |
| movement_id | bigint fk | inngående bevegelsen som skapte laget |
| qty_in | numeric | opprinnelig antall |
| qty_remaining | numeric check `>= 0` | |
| unit_cost | numeric(14,4) not null | basisvaluta |
| received_at | timestamptz not null | **FIFO-nøkkel**. Ved overføring beholdes opprinnelig `received_at` (laget beholder plassen i køen). |

Index `(item_id, location_id, received_at, id) where qty_remaining > 0`.

### 2.6 `inv.layer_consumption` — hvilke lag et uttak brukte

| kolonne | type | merknad |
|---|---|---|
| id | bigserial pk | |
| movement_id | bigint fk not null | det utgående uttaket |
| layer_id | bigint fk null | `null` = udekket (beholdning gikk under 0) |
| qty | numeric not null | positiv |
| unit_cost | numeric(14,4) not null | lagets kost, eller estimat når `layer_id is null` |
| estimated | bool default false | |
| covered_by_movement_id | bigint fk null | inngående bevegelse som senere dekket et udekket konsum |

Dette gir eksakt COGS per salgslinje og er grunnlaget for COGS-rapport.

### 2.7 `inv.cogs_correction`
Når et estimert konsum dekkes av et faktisk lag, logges differansen her (tilsvarer Cin7 «Sale COGS Change»): `movement_id` (salget), `covered_by_movement_id` (mottaket), `qty`, `estimated_unit_cost`, `actual_unit_cost`, `delta_cost`, `created_at`.

### 2.8 `inv.stock_balance` — cache + låserad

`(item_id, location_id) pk`, `on_hand numeric default 0`, `value numeric default 0` (= Σ `qty_remaining × unit_cost` over lag), `updated_at`. Oppdateres i samme transaksjon som bevegelsen. Raden låses `FOR UPDATE` i alle skrivefunksjoner — dette serialiserer skriving per (vare × lokasjon) og gjør `new_qty`-justeringer trygge under samtidighet. Kan alltid gjenoppbygges fra `inv.movement`/`inv.cost_layer` (`inv.rebuild_balances()`).

### 2.9 Innkjøp

`inv.purchase_order`

| kolonne | type | merknad |
|---|---|---|
| id | uuid pk | |
| number | text unique | `PO-01401` fra `inv.po_number_seq` + prefix |
| status | `inv.po_status` | `draft` → `sent` → `partially_received` → `received` → `closed`; `cancelled` fra draft/sent |
| supplier_name | text not null | |
| supplier_id | text | fri referanse (Cin7-guid, Tripletex-id, …) |
| supplier_ref | text | leverandørens ordrenr |
| currency | text default base | `JPY`, `EUR`, … |
| fx_rate | numeric(14,6) default 1 | 1 enhet `currency` = `fx_rate` basisvaluta. Låses ved `sent`; kan overstyres per mottak. |
| location_id | uuid fk | default-lokasjon for mottak |
| order_date, expected_at | date | |
| note | text | |
| created_by | text | |
| sent_at, received_at, cancelled_at, closed_at | timestamptz | |
| metadata | jsonb | f.eks. `pending_po_id`, Slack-ts |

`inv.purchase_order_line`

| kolonne | type | merknad |
|---|---|---|
| id | uuid pk | |
| po_id | fk | |
| position | int | |
| item_id | uuid fk | |
| sku | text | denormalisert for lesbarhet |
| qty_ordered | numeric not null `> 0` | |
| qty_received | numeric default 0 | vedlikeholdes av `receive_purchase_order` |
| unit_cost | numeric(14,4) not null | i PO-valuta |
| landed_cost_per_unit | numeric(14,4) default 0 | basisvaluta (frakt/toll fordelt), valgfritt |
| note | text | |

Unique `(po_id, item_id)`. Linjer kan endres fritt i `draft`; i `sent` kan `qty_ordered`/`unit_cost` endres til første mottak (logges i `metadata.history`).

`inv.goods_receipt`: `id`, `number` (`GR-000123`), `po_id`, `location_id`, `received_at`, `received_by`, `fx_rate` (brukt), `note`, `status` (`completed`/`reversed`).

`inv.goods_receipt_line`: `id`, `receipt_id`, `po_line_id`, `item_id`, `qty`, `unit_cost` (PO-valuta, kan avvike fra PO-linjen — **dette er «pris logges på den linjen»**), `landed_cost_per_unit`, `unit_cost_base` (= `round(unit_cost × fx_rate + landed_cost_per_unit, 4)`), `movement_id`.

### 2.10 Justering, overføring

`inv.adjustment`: `id`, `number` (`ADJ-000123`), `location_id`, `reason` (fri tekst; UI tilbyr standardvalg: `telling`, `knust`, `svinn`, `ettersending`, `bytte`, `funnet`, `revaluering`, `annet`), `note`, `created_by`, `status` (`completed`/`reversed`).

`inv.adjustment_line`: `id`, `adjustment_id`, `item_id`, `qty_before`, `qty_delta` (signert), `qty_after`, `unit_cost` (brukt), `cost_source`, `movement_id`, `note`.

`inv.transfer`: `id`, `number` (`TR-000123`), `from_location_id`, `to_location_id`, `note`, `created_by`, `status` (`completed`/`reversed`).
`inv.transfer_line`: `id`, `transfer_id`, `item_id`, `qty`, `out_movement_id`, `in_movement_id`.

### 2.11 Woo-integrasjon

`inv.woo_order_sync`

| kolonne | merknad |
|---|---|
| woo_order_id bigint pk | |
| woo_status text | sist sett |
| stock_state text | `none` / `deducted` / `restored` |
| lines jsonb | snapshot `[{line_id, sku, item_id, qty}]` av hva som er trukket |
| refunds jsonb | `[refund_id, …]` behandlet |
| last_payload jsonb | siste webhook-payload (feilsøking) |
| processed_at, updated_at | |

`inv.stock_push_queue` (outbox): `item_id pk`, `requested_at`, `last_pushed_qty`, `last_pushed_at`, `attempts int default 0`, `last_error text`, `next_attempt_at`. Trigger `after insert on inv.movement` upserter `requested_at = now()`.

`inv.woo_webhook_log`: `id`, `topic`, `resource_id`, `received_at`, `result` (`applied`/`ignored`/`error`), `message`. 30 dagers retensjon.

### 2.12 Views (lesemodell)

`inv.v_stock_by_location` — én rad per (item × location) med `sku`, `location_code`, `on_hand`, `value`, `avg_cost` (= value/on_hand, null ved ≤ 0), `last_movement_at`.

`inv.v_item_status` — én rad per item:

| kolonne | definisjon |
|---|---|
| on_hand | Σ on_hand alle lokasjoner |
| on_hand_sellable | Σ on_hand der `location.sellable_online` |
| allocated | `0` i v1 (kolonne finnes) |
| available | `on_hand_sellable − allocated` |
| on_order | Σ (`qty_ordered − qty_received`) for PO i status `sent`/`partially_received` |
| next_delivery | min `expected_at` for samme PO-er |
| stock_value | Σ value |
| avg_cost | stock_value / on_hand (null ved ≤ 0) |
| last_purchase_cost, last_purchase_at | fra siste `purchase_receipt`-bevegelse (unit_cost i basisvaluta) |
| last_movement_at | |
| negative | `on_hand < 0` |
| below_reorder | `on_hand ≤ reorder_point` |
| locations | jsonb `[{code, on_hand, value}]` |

`inv.v_movement` — `inv.movement` joinet med sku, item-navn, location_code, reversert-flagg; dette er det `GET /movements` leser.

`inv.v_open_consumption` — udekkede konsum (negativ beholdning) per item/location, for varsling.

---

## 3. Kostlogikk

### 3.1 Inngående bevegelse → nytt lag
`purchase_receipt`, `adjustment_in`, `sale_return`, `transfer_in`, `opening_balance`, `reversal` (av uttak) oppretter alltid ett `cost_layer` med `qty_in = qty`, `unit_cost` i basisvaluta og `received_at` = bevegelsens `occurred_at` (unntak: `transfer_in` og `reversal` arver opprinnelig `received_at`, se 3.6/3.7). Deretter kjøres dekking av udekkede konsum (3.5). `stock_balance.on_hand += qty`, `value += qty × unit_cost`.

### 3.2 Utgående bevegelse → FIFO-konsum
`sale`, `adjustment_out`, `transfer_out`, `write_off`, `reversal` (av inngang):

1. Lås `stock_balance`-raden.
2. Hent lag med `qty_remaining > 0` for (item, location) `ORDER BY received_at, id` `FOR UPDATE`.
3. Konsumér eldst-først; skriv én `layer_consumption`-rad per lag berørt; `qty_remaining -= tatt`.
4. Hvis rest > 0 etter at alle lag er tomme: hvis negativt lager ikke er tillatt for typen → `INSUFFICIENT_STOCK` (hele transaksjonen rulles tilbake). Ellers: estimert konsum (3.5).
5. `movement.total_cost = Σ consumption.qty × unit_cost`, `unit_cost = total_cost / |qty|`, `cost_source = 'fifo'` (eller `cost_estimated = true`).
6. `balance.on_hand -= |qty|`, `balance.value -= Σ (dekket konsum)`.

### 3.3 Stock adjustment — kostregel (Alexanders regel)
For hver linje: `delta` oppgis direkte, eller `new_qty` → `delta = new_qty − on_hand` beregnet **etter** at raden er låst. `delta = 0` → linjen lagres med `movement_id = null` (ingen bevegelse). `new_qty < 0` → `VALIDATION`.

`delta > 0` (adjustment_in), enhetskost velges i denne rekkefølgen og `cost_source` settes deretter:

1. `unit_cost` oppgitt på linja → `manual`
2. Vare har beholdning > 0 på **denne lokasjonen** → vektet snitt av lagene: `Σ(qty_remaining × unit_cost) / Σ qty_remaining` → `on_hand_avg`
3. Vare har beholdning > 0 på **noen** lokasjon → samme snitt over alle lokasjoner → `on_hand_avg_all`
4. Siste `purchase_receipt`-bevegelse for varen (uansett lokasjon) → `last_purchase`
5. Siste inngående bevegelse med kost (uansett type) → `last_known`
6. Ellers → feil `COST_REQUIRED` (UI må be om pris).

`delta < 0` (adjustment_out): FIFO-konsum, negativt lager ikke tillatt → `INSUFFICIENT_STOCK` hvis `|delta| > on_hand`.

**Revaluering** (endre kost på det som ligger inne) gjøres som i Cin7: justering ned til 0 + justering opp med `unit_cost`. UI kan tilby det som ett valg («Revaluer»), funksjonen `create_adjustment` støtter `revalue_to_unit_cost` på linja som sukker for nettopp dette (to bevegelser, samme adjustment).

### 3.4 Varemottak — kost
`unit_cost_base = round(unit_cost × fx_rate + landed_cost_per_unit, 4)` der `unit_cost` er mottakslinjens pris i PO-valuta (default = PO-linjens pris, kan overstyres), `fx_rate` = mottakets kurs (default PO-ens), `landed_cost_per_unit` default 0. Laget får `received_at = goods_receipt.received_at` (mottaksdato, ikke tidspunktet noen trykket på knappen — kan settes tilbake i tid).

Landed cost som fordeles **etter** mottak (fraktfaktura kommer uker senere) er ikke i v1. Noteres som v1.1: «landed cost allocation» som oppdaterer `unit_cost` på gjenværende lag + `cogs_correction` for det som allerede er solgt.

### 3.5 Negativ beholdning og estimert kost
Når et salg tar beholdningen under 0 (eller den allerede er under 0):

- Resten kostes estimert i denne rekkefølgen: vektet snitt av lag som fantes rett før uttaket → `last_purchase` → `last_known` → 0 med `cost_source='unknown'`. `layer_consumption` får `layer_id = null, estimated = true`; `movement.cost_estimated = true`.
- Ved neste **inngående** bevegelse på samme (item, location) dekkes udekkede konsum eldst-først (`layer_consumption where layer_id is null and covered_by_movement_id is null order by id`): raden får `layer_id` = det nye laget, `unit_cost` = lagets kost, `estimated=false`, `covered_by_movement_id` = mottaksbevegelsen; laget får `qty_remaining -= dekket`. Delvis dekking splitter konsum-raden i dekket + udekket. Deretter rekalkuleres `unit_cost`/`total_cost` på det opprinnelige salget, `cost_estimated = false` når alt er dekket, og differansen logges i `inv.cogs_correction`.
- `stock_balance.value` teller bare faktiske lag (udekket konsum bidrar ikke med negativ verdi). `on_hand` kan være negativ.
- `inv.v_open_consumption` lister alt udekket; Slack-varsel i `#lager` er UI-/cron-ansvar, ikke ledgerens.

### 3.6 Overføring mellom lokasjoner
`transfer_out` konsumerer FIFO på fra-lokasjonen (negativt ikke tillatt). For **hvert konsumerte lag** opprettes et nytt lag på til-lokasjonen med samme `unit_cost` og **samme `received_at`** (varen beholder sin plass i FIFO-køen, jf. Cin7-innstillingen «Update Stock Received Date with Transfer Completion Date» = av). `transfer_in`-bevegelsen får `unit_cost` = vektet snitt, `metadata.layers = [{from_layer_id, qty, unit_cost, received_at}]`. Begge bevegelser i én transaksjon.

### 3.7 Reversering
`inv.reverse_movement(movement_id, by, note)`:

- Original er **utgående** (salg, justering ned, …): ny bevegelse type `reversal`, `qty = +|qty|`, lag gjenopprettes per `layer_consumption`-rad med samme `unit_cost` og opprinnelig lags `received_at` (udekket konsum gjenopprettes ikke — det bare fjernes). `cost_source='reversal'`.
- Original er **inngående**: `reversal` med `qty = −qty`, konsumerer **spesifikt dette laget**. Hvis `qty_remaining < qty_in` (noe er solgt) → `409 LAYER_CONSUMED`; UI må i stedet lage en justering.
- Original får `reversed_by`; reverseringen `reversal_of`. En reversering kan ikke reverseres (reverser i stedet ikke, lag ny bevegelse).
- Dokumentnivå: `reverse_adjustment(id)`, `reverse_goods_receipt(id)` (reverserer alle linjer, dekrementerer `po_line.qty_received`, re-evaluerer PO-status), `reverse_transfer(id)`. Alle feiler atomisk hvis én linje ikke kan reverseres.

### 3.8 Retur fra kunde (`sale_return`)
Inngående lag med kost = vektet COGS fra den opprinnelige salgsbevegelsen når den finnes (oppslag på `ref_type='woo_order', ref_id, ref_line`), ellers kostregel 2–6 fra 3.3. `received_at = now()`. Varer som ikke skal tilbake på lager (ødelagt) registreres som retur + `write_off`, eller ikke i det hele tatt — det er UI-ets valg.

---

## 4. Bevegelsestyper (`inv.movement_type`)

| type | fortegn | lag | ref_type | opprettes av |
|---|---|---|---|---|
| `opening_balance` | + | nytt | `opening_balance` | installasjon/import |
| `purchase_receipt` | + | nytt | `goods_receipt` | `receive_purchase_order` |
| `sale` | − | FIFO (negativt ok) | `woo_order` / `manual_sale` | `apply_woo_order`, `record_sale` |
| `sale_return` | + | nytt | `woo_refund` / `woo_order` / `manual_sale` | `apply_woo_order`, `record_sale_return` |
| `adjustment_in` | + | nytt | `adjustment` | `create_adjustment` |
| `adjustment_out` | − | FIFO | `adjustment` | `create_adjustment` |
| `write_off` | − | FIFO | `adjustment` | `create_adjustment` med `write_off: true` (samme dokument, egen type for rapportering) |
| `transfer_out` | − | FIFO | `transfer` | `create_transfer` |
| `transfer_in` | + | nytt (arver received_at) | `transfer` | `create_transfer` |
| `reversal` | ± | se 3.7 | `reversal` | `reverse_*` |

Check-constraint: `(type in ('sale','adjustment_out','write_off','transfer_out') and qty < 0) or (type in ('opening_balance','purchase_receipt','sale_return','adjustment_in','transfer_in') and qty > 0) or type = 'reversal'`.

Grovkategori for UI (som `movementKind()` i `lib/cin7-movements.js`): `innkjop` (purchase_receipt, opening_balance), `salg` (sale, sale_return), `justering` (adjustment_*, write_off), `flytting` (transfer_*), `reversering`.

---

## 5. Postgres-funksjoner (RPC-laget)

All skriving går gjennom disse. De er `security definer`, kjører i én transaksjon, låser `stock_balance` og kaster `raise exception using errcode = 'P0001', message = '<CODE>: <tekst>', detail = '<json>'`. HTTP-laget mapper `CODE` til status (§6.0). Input/output er `jsonb` slik at kontrakten er identisk uansett om kallet kommer fra `pg` i Next.js, fra `supabase.rpc()` (PostgREST) eller fra `psql`.

Felles: `sku` matches case-insensitivt og trimmet; `location` er `code` (utelatt → default); `by` er fri tekst; `occurred_at` default `now()`.

### 5.1 Varer
```
inv.upsert_item(p jsonb) → inv.item (jsonb)
  p: { sku, woo_product_id?, woo_variation_id?, name?, track_stock?, active?, reorder_point?, reorder_qty?, attributes? }
  Matcher på (woo_product_id, woo_variation_id) først, deretter sku. SKU-bytte på samme Woo-id oppdaterer sku (historikk følger item_id).
inv.upsert_items_from_catalog() → { upserted int, deactivated int }
  Leser public.products (+ public.product_variations hvis finnes) — adapter per butikk, se §7.1.
```

### 5.2 Kjernen
```
inv.post_movement(p jsonb) → movement (jsonb)
  p: { sku, location?, type, qty (signert), unit_cost? (kun inngående), cost_source?,
       ref_type?, ref_id?, ref_line?, reference?, note?, by?, occurred_at?, metadata?,
       allow_negative? (default fra type/settings), on_conflict? ('return_existing' | 'error', default 'return_existing') }
  Idempotent på (ref_type, ref_id, ref_line). Returnerer { ...movement, consumptions:[...], layer_id?, existing: bool }.
  Dette er «rå» API-et; dokumentfunksjonene under bruker det.
```

### 5.3 Innkjøp
```
inv.create_purchase_order(p jsonb) → po (jsonb, med lines)
  p: { supplier_name, supplier_id?, supplier_ref?, currency?, fx_rate?, location?, order_date?, expected_at?, note?, by?, metadata?,
       lines: [{ sku, qty, unit_cost, landed_cost_per_unit?, note? }] }
inv.update_purchase_order(po_id uuid, p jsonb) → po
  Header-felter + full erstatning av lines (kun draft/sent uten mottak; ellers PO_LOCKED).
inv.set_purchase_order_status(po_id, status text, by text) → po
  Lovlige overganger: draft→sent, draft→cancelled, sent→cancelled (kun uten mottak), partially_received→closed (rest avbestilles; on_order faller), received→closed. Alt annet → PO_STATUS_INVALID.
inv.receive_purchase_order(po_id uuid, p jsonb) → goods_receipt (jsonb, med lines + movements)
  p: { location?, received_at?, by, fx_rate?, note?, allow_over_receipt? (default false),
       lines: [{ po_line_id | sku, qty, unit_cost?, landed_cost_per_unit?, note? }] }
  Krav: status in (sent, partially_received). qty > rest og !allow_over_receipt → OVER_RECEIPT.
  Per linje: goods_receipt_line + post_movement(purchase_receipt, ref_type='goods_receipt', ref_id=receipt.id, ref_line=line.id, reference=po.number).
  Oppdaterer qty_received og PO-status (received når alle linjer qty_received ≥ qty_ordered, ellers partially_received).
inv.reverse_goods_receipt(receipt_id, by, note) → goods_receipt
```

### 5.4 Justering, overføring, salg
```
inv.create_adjustment(p jsonb) → adjustment (jsonb, med lines + movements)
  p: { location?, reason, note?, by, occurred_at?, write_off? (default false),
       lines: [{ sku, delta? | new_qty?, unit_cost?, revalue_to_unit_cost?, note? }] }
  Nøyaktig én av delta/new_qty per linje. Kostregel §3.3. Hele dokumentet er én transaksjon.
inv.reverse_adjustment(adjustment_id, by, note) → adjustment

inv.create_transfer(p jsonb) → transfer
  p: { from_location, to_location, note?, by, occurred_at?, lines: [{ sku, qty }] }
inv.reverse_transfer(transfer_id, by, note) → transfer

inv.record_sale(p jsonb) → { movements: [...] }
  p: { ref_type (default 'manual_sale'), ref_id, reference?, location?, by, occurred_at?, note?,
       lines: [{ sku, qty, ref_line? }] }
  For B2B (Laks & Vilt), kassesalg uten Woo, o.l. Idempotent per (ref_type, ref_id, ref_line).
inv.record_sale_return(p jsonb) → { movements }
  Samme form; kost per §3.8. original_ref_type/original_ref_id kan oppgis for kostoppslag.

inv.reverse_movement(movement_id bigint, by text, note text) → movement
```

### 5.5 Woo
```
inv.apply_woo_order(order jsonb, source text) → { order_id, action: 'deducted'|'restored'|'adjusted'|'ignored', movements:[...], unmatched_skus:[...] }
  Tar hele Woo-ordre-payloaden (REST v3-form). Logikk i §7.2. Ren Postgres — ingen nettverk.
inv.apply_woo_refund(order_id bigint, refund jsonb) → { action, movements }
inv.list_stock_push_due(limit int) → [{ item_id, sku, woo_product_id, woo_variation_id, qty_to_push }]
  qty_to_push = available (floor til int; max(0, …) hvis woo_push_floor_zero). Bare items med track_stock og aktiv Woo-id.
inv.mark_stock_pushed(item_id, qty, ok bool, error text)
```

### 5.6 Vedlikehold
```
inv.rebuild_balances() → { rows int }          -- fra cost_layer/layer_consumption; kun ved mistanke om drift
inv.verify_integrity() → jsonb                 -- Σ movement.qty = balance.on_hand per item/loc; Σ layer.qty_remaining = max(on_hand,0); udekket konsum = max(−on_hand,0)
```

---

## 6. HTTP-API (Next.js Pages Router, `pages/api/inventory/*`)

Tynt lag: valider input (zod), kall RPC via `pg`, returnér JSON. Ingen forretningslogikk her, med to unntak: **Woo-push-worker** (trenger Woo-credentials) og **Woo-webhook** (HMAC-verifisering + ev. henting av refund-detaljer fra Woo REST).

### 6.0 Konvensjoner

- **Auth:** alle ruter krever enten `Authorization: Bearer $INVENTORY_API_KEY` (agenter, andre systemer, v3-proxyer) eller gyldig NextAuth-session (UI) — samme mønster som `lib/api-auth.js > requireSecretOrSession` i internal-web. Webhooks verifiseres med `X-WC-Webhook-Signature` (HMAC-SHA256 over rå body med `WC_WEBHOOK_SECRET`, fail-closed) og er allowlistet i `middleware.js`.
- **Base path:** `/api/inventory`. Alle svar `application/json`. Tidspunkt ISO-8601 med sone. Antall/kost som tall.
- **Feil:** `{ "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": {…} } }`.

| code | HTTP |
|---|---|
| `VALIDATION` | 400 |
| `UNAUTHORIZED` | 401 |
| `ITEM_NOT_FOUND`, `LOCATION_NOT_FOUND`, `PO_NOT_FOUND`, `NOT_FOUND` | 404 |
| `DUPLICATE_REF` (kun når `on_conflict=error`) | 409 |
| `LAYER_CONSUMED`, `PO_LOCKED` | 409 |
| `INSUFFICIENT_STOCK`, `COST_REQUIRED`, `OVER_RECEIPT`, `PO_STATUS_INVALID` | 422 |
| annet | 500 |

- **Idempotens:** skrivende kall støtter `Idempotency-Key`-header; nøkkelen lagres i `inv.idempotency_key (key pk, response jsonb, created_at)` i 24 t og samme svar returneres ved retry. Webhooks/salg er i tillegg idempotente på `(ref_type, ref_id, ref_line)`.
- **Paginering:** `limit` (default 100, maks 500) + `cursor` (opak, = siste `id`). Svar: `{ data: [...], next_cursor: "…" | null, total?: n }` (`total` bare når `count=1`).
- **Eksport:** liste-endepunkter støtter `format=csv` (UTF-8, `;`-separert, norsk Excel).
- **Skriv-etter-skriv:** etter vellykket skrivende kall trigges push-worker asynkront (`fetch` til egen `/sync/push-stock` uten å vente), slik at Woo oppdateres innen sekunder uten å vente på cron.

### 6.1 Varer og status
```
GET  /items?q=&active=&track_stock=&limit=&cursor=
GET  /items/:sku                              → item + status (= én rad fra v_item_status) + locations[]
POST /items/sync                              → upsert_items_from_catalog()   (manuell/cron)
PATCH /items/:sku   { reorder_point?, reorder_qty?, attributes? }   (Woo-felt kan ikke endres her)

GET  /stock?sku=&skus=A,B,C&location=&negative=1&below_reorder=1&q=&limit=&cursor=&format=csv
     → rader fra v_item_status (eller v_stock_by_location når location= er satt)
GET  /stock/:sku                              → { sku, on_hand, available, on_order, next_delivery, avg_cost, stock_value,
                                                  last_purchase_cost, last_purchase_at, locations:[{code,on_hand,value,avg_cost}],
                                                  open_consumption_qty, layers:[{id, received_at, qty_remaining, unit_cost, ref}] }
GET  /valuation?location=&format=csv          → { total_value, rows:[{sku, on_hand, avg_cost, value}] }   (nåtid; historisk = v2)
```

### 6.2 Bevegelser
```
GET /movements?sku=&skus=&type=sale,purchase_receipt&kind=salg|innkjop|justering|flytting&location=
               &ref_type=&ref_id=&from=&to=&by=&q=&include_reversed=0&limit=&cursor=&format=csv
    → data:[{ id, occurred_at, sku, item_name, location, type, kind, qty, unit_cost, total_cost, cost_estimated,
              on_hand_after, ref_type, ref_id, ref_line, reference, note, created_by, reversal_of, reversed_by, metadata }]
GET  /movements/:id                            → movement + consumptions[] (+ layer-detaljer) + cogs_corrections[]
POST /movements/:id/reverse  { by, note }      → reversal-movement
POST /movements              { … post_movement-input … }   -- rå; UI bør bruke dokument-endepunktene under
GET  /reports/cogs?from=&to=&group_by=sku|day|ref&location=      → Σ total_cost for sale − sale_return + cogs_correction i perioden
```

### 6.3 Innkjøp
```
GET    /purchase-orders?status=sent,partially_received&supplier=&q=&from=&to=&limit=&cursor=
POST   /purchase-orders                        { create_purchase_order-input }      → 201 po
GET    /purchase-orders/:id                    → po + lines (med qty_received, rest) + receipts[]
PATCH  /purchase-orders/:id                    { header-felter?, lines? }
POST   /purchase-orders/:id/status             { status: 'sent'|'cancelled'|'closed', by }
POST   /purchase-orders/:id/receive            { receive_purchase_order-input }     → 201 goods_receipt (+ movements)
GET    /receipts?po_id=&from=&to=              ; GET /receipts/:id ; POST /receipts/:id/reverse { by, note }
GET    /purchase-orders/on-order?sku=          → [{ sku, po_number, qty_open, expected_at }]
```

### 6.4 Justering og overføring
```
GET  /adjustments?from=&to=&location=&reason=&by=&q=&limit=&cursor=      → liste med sum qty/verdi per dokument
POST /adjustments                { create_adjustment-input }   → 201 adjustment (+ lines med unit_cost/cost_source + movements)
GET  /adjustments/:id
POST /adjustments/:id/reverse    { by, note }
POST /adjustments/preview        { samme input }  → beregner delta/kost uten å skrive (UI viser «dette kommer til å skje»)

POST /transfers                  { create_transfer-input } → 201 ; GET /transfers ; GET /transfers/:id ; POST /transfers/:id/reverse
```

### 6.5 Salg utenom Woo
```
POST /sales           { record_sale-input }         → 201 { movements }
POST /sales/returns   { record_sale_return-input }  → 201 { movements }
```

### 6.6 Woo
```
POST /webhooks/woo-order     Woo topics order.created + order.updated (+ order.deleted → ignored)
                             → 200 { action, movements: n, unmatched_skus }  (alltid 200 etter gyldig signatur; feil logges i woo_webhook_log og
                                svares 500 bare ved DB-feil så Woo retryer)
POST /webhooks/woo-product   product.created/updated/deleted → upsert_item (kan også hentes via /items/sync)
POST /sync/push-stock        Drener outbox (maks 100 per kjøring). Cron hvert minutt + trigges etter skriv. Svar { pushed, failed, skipped }.
POST /sync/reconcile         Sammenligner Woo stock_quantity med available for alle track_stock-items; rapporterer avvik og (med ?fix=1) pusher. Daglig cron.
POST /sync/import-orders?from=&to=   Backfill: henter ordrer fra Woo REST og kjører apply_woo_order per ordre (idempotent). Brukes ved oppstart og etter nedetid.
GET  /sync/status            { queue_size, oldest_requested_at, last_push_at, failed_items:[…], last_reconcile }
```

---

## 7. Woo-integrasjon i detalj

### 7.1 Produktmaster → `inv.item`
Kilde er butikkens eksisterende Woo→Supabase-speil når det finnes (`public.products` / `public.product_variations` i v3-riggen), ellers Woo REST direkte (`/wc/v3/products?per_page=100` + `/products/:id/variations`). Adapteren `upsert_items_from_catalog()` er den **eneste** butikk-spesifikke SQL-biten og leveres som egen migrasjonsfil per butikk (`0090_catalog_adapter_<butikk>.sql`). Mapping: `sku`, `woo_product_id`, `woo_variation_id`, `name`, `track_stock = manage_stock`, `active = status in ('publish','private')`. Produkter uten SKU hoppes over og rapporteres. Sletting i Woo → `active=false` (aldri DELETE; bevegelser må bevares).

Webhook `product.*` → `upsert_item` i sanntid; `/items/sync` som daglig sikkerhetsnett (cron 04:10, samme slot som dagens `sync-products`).

### 7.2 Ordre → salg (`apply_woo_order`)
Input er Woo REST-ordreobjektet (`id`, `status`, `line_items[{id, sku, product_id, variation_id, quantity}]`, `refunds[]`, `meta_data`). Per linje: item slås opp på `(product_id, variation_id)`, deretter `sku`. Ukjent SKU → linjen hoppes over og listes i `unmatched_skus` (UI/Slack varsler); resten av ordren behandles. Linjer med `quantity ≤ 0` ignoreres. Lokasjon: `meta_data.inv_location` hvis satt (f.eks. kassesalg i butikk merket av POS), ellers default.

Tilstandsmaskin per `woo_order_id`:

| stock_state før | ny status i | handling | stock_state etter |
|---|---|---|---|
| `none` | `deduct_statuses` | `sale` per linje, `ref_type='woo_order', ref_id=order.id, ref_line=line.id` | `deducted` |
| `none` | annet (`pending`, `failed`, `cancelled`, …) | ingenting | `none` |
| `deducted` | `deduct_statuses` | **diff mot `lines`-snapshot**: økt antall → `sale` på differansen (`ref_line = line.id + ':' + n`), redusert/fjernet → `sale_return` på differansen | `deducted` |
| `deducted` | `restore_statuses` | `sale_return` for alt i snapshot som ikke allerede er returnert via refund | `restored` |
| `restored` | `deduct_statuses` (gjenåpnet) | `sale` igjen med ny `ref_line`-suffiks | `deducted` |

Kost på `sale_return` = COGS fra den matchende `sale`-bevegelsen (§3.8).

Woo reduserer også sitt eget `stock_quantity` ved betaling — det er uproblematisk fordi push-worker setter absolutt verdi fra ledgeren etterpå. Woo sin `_reduced_stock`-logikk må ikke skrus av.

### 7.3 Refusjoner
`order.updated` med nye id-er i `refunds[]` (som ikke ligger i `woo_order_sync.refunds`) → HTTP-laget henter `GET /orders/:id/refunds/:refund_id` fra Woo og kaller `apply_woo_refund(order_id, refund)`. Refund-linjer med `quantity < 0` (Woo oppgir negativt antall) → `sale_return` med `ref_type='woo_refund', ref_id=refund.id, ref_line=line.id`, begrenset til det som er trukket og ikke allerede returnert. Refusjon uten varelinjer (beløpsrefusjon) → `ignored`. Woo sin «Restock refunded items»-avkrysning påvirker bare Woo-lageret, som uansett overskrives av push.

### 7.4 Push til Woo (outbox-worker)
`/sync/push-stock`: `list_stock_push_due(100)` → grupper i Woo batch-kall `POST /wc/v3/products/batch { update: [{id, stock_quantity}] }` for simple, og `POST /wc/v3/products/:parent/variations/batch` per parent for variasjoner (maks 100 per kall) → `mark_stock_pushed` per item. Push hoppes over når `qty_to_push = last_pushed_qty` og `last_pushed_at` er nyere enn `requested_at`. Feil → `attempts++`, `next_attempt_at = now() + 2^attempts min` (maks 1 t), `last_error`. Items med `track_stock=false` eller uten Woo-id markeres `skipped`. Worker-en tåler å kjøre parallelt (`SELECT … FOR UPDATE SKIP LOCKED` på køen).

Bruk `lib/woo.js` (`wooFetch`/`wooPost`) og env `WOOCOMMERCE_STORE_URL` / `_CONSUMER_KEY` / `_CONSUMER_SECRET` som allerede er konvensjon i begge internal-webs (aldri hardkodede nøkler — se CLAUDE.md).

### 7.5 Reconcile
Daglig: hent alle Woo-produkter/variasjoner med `manage_stock`, sammenlign `stock_quantity` mot `available`. Avvik rapporteres (Slack `#lager`) og rettes med `?fix=1` ved å legge item i push-køen — **aldri** ved å skrive Woo-verdien inn i ledgeren. Ledgeren er master.

---

## 8. Installasjon per butikk

> **v0.5:** `inv` bor alltid i nettbutikkens Supabase. `node scripts/install.mjs --api <internal-web> --migrations <nettbutikk>/supabase/migrations`.
> Migrasjonene går inn via nettbutikk-repoet (`supabase db push`), internal-web kobler til med `INVENTORY_DATABASE_URL`.
> Katalog-adapteren (`0090`) leser nettbutikkens speil (`public.products`/`product_variations`) og er felles for alle butikker
> med samme speil. `0006` fjerner all tilgang for `anon`/`authenticated`. Åpningsbalanse: `POST /opening-balance` (CSV-rader).

1. Kjør migrasjonene i butikkens Supabase (`supabase db push` eller `psql`): `0001_inv_schema.sql` (typer, tabeller, indekser, triggere, seed `MAIN` + settings), `0002_inv_functions.sql`, `0003_inv_views.sql`, `0004_inv_woo.sql`, `0090_catalog_adapter_<butikk>.sql`.
2. Sett `inv.settings` (valuta, PO-prefix) og `select setval('inv.po_number_seq', <siste Cin7-nummer>)` for Skarpekniver, så PO-nummereringen fortsetter.
3. Opprett ekstra lokasjoner ved behov (`insert into inv.location …`). For Skarpekniver: `MAIN` (Hovedlager) + `BUTIKK` (Vulkan, `sellable_online=false` hvis butikkens varer ikke skal selges på nett — avklares).
4. Kopiér API-pakken inn i butikkens internal-web: `lib/inventory/*` + `pages/api/inventory/**`. Legg `/api/inventory/webhooks/*` i `PUBLIC_PREFIXES` i `middleware.js`. Env: `INVENTORY_DATABASE_URL` (Supabase transaction pooler, port 6543 — Skarpekniver-internal-web bruker RetoolDB som `DATABASE_URL`, så dette blir en **egen pool** `lib/inventory/db.js`), `INVENTORY_API_KEY`, `WC_WEBHOOK_SECRET`, Woo-credentials.
5. Registrer cron i `vercel.json` + `lib/cron-logger.js` (`withCronLogging`-mønsteret): `push-stock` (`* * * * *`), `reconcile` (`15 4 * * *`), `items-sync` (`10 4 * * *`).
6. Registrer Woo-webhooks i wp-admin: `order.created`, `order.updated`, `product.created`, `product.updated`, `product.deleted` → `https://<internal-host>/api/inventory/webhooks/…`.
7. `POST /items/sync`, deretter **åpningsbalanse**: for Skarpekniver importeres `OnHand` per lokasjon fra Cin7 `/ref/productavailability` med `average_cost` som kost (ett `opening_balance`-lag per item×lokasjon, `received_at` = cutover-tidspunkt). Skript: `scripts/import-opening-balance-cin7.mjs` (leser Cin7, skriver via `post_movement`, idempotent på `ref_type='opening_balance', ref_id=sku+location`). For nye butikker: tom start eller CSV (`sku;location;qty;unit_cost`).
8. Cutover Skarpekniver: (a) importer åpningsbalanse i et stille vindu, (b) skru på webhooks + push, (c) deaktiver Cin7→Woo-integrasjonen (Cin7 slutter å skrive `stock_quantity`), (d) kjør `/sync/reconcile`, (e) la `sync-products`-cronen fortsette å fylle `products` fra Cin7 i en periode, men pek UI-ene (`/lager`, `/stock-adjustments`, `/varemottak`, caser) over på `/api/inventory/*`. `products.current_stock`/`average_cost` byttes til oppslag mot `inv.v_item_status` (eller en view `public.v_products_with_stock`).

Pakken vedlikeholdes ett sted (eget repo `inventory-ledger/`), butikkene kopierer inn versjonerte filer. Migrasjonsfilene har versjon i header; `inv.settings.schema_version` settes av siste migrasjon.

```
inventory-ledger/
  README.md                 (= denne specen + changelog)
  migrations/
    0001_inv_schema.sql
    0002_inv_functions.sql
    0003_inv_views.sql
    0004_inv_woo.sql
    0090_catalog_adapter_skarpekniver.sql
    0090_catalog_adapter_bark.sql
  api/                      (kopieres inn i hvert internal-web)
    lib/inventory/db.js         egen pg-pool mot INVENTORY_DATABASE_URL
    lib/inventory/rpc.js        call(fn, args) → jsonb, mapper RAISE-koder til {code,message,details}
    lib/inventory/auth.js       requireInventoryAuth(req,res)
    lib/inventory/validate.js   zod-skjemaer for alle inputs (samme form som RPC-jsonb)
    lib/inventory/woo-push.js   push-worker + reconcile
    lib/inventory/woo-order.js  webhook-parsing, refund-henting, apply_woo_order-kall
    lib/inventory/csv.js
    pages/api/inventory/**      ruter i §6
  scripts/
    import-opening-balance-cin7.mjs
    import-opening-balance-csv.mjs
    backfill-woo-orders.mjs
  tests/
    sql/        pgTAP eller plain SQL-asserts for §10 (kjøres mot `supabase start`)
    api/        vitest/node mot lokal Supabase
```

---

## 9. Utenfor v1 (bevisst)

- Allokering/reservasjon ved ordre (Available = On Hand − Allocated). Kolonnen `allocated` og typen er forberedt; v2 legger til `allocation`-tabell og trekker ved `completed` i stedet.
- Batch/serienummer, FEFO, utløpsdato.
- Landed cost-fordeling etter mottak (fraktfaktura i ettertid) → v1.1.
- Stocktake med låsing av lokasjon (v1: telling = adjustment med `reason='telling'`; UI kan bygge tellelister over `/stock`).
- Historisk verdsetting («lagerverdi per 31.12») — krever replay av lag; v2 (`inv.layer_history` eller daglig snapshot-tabell `inv.valuation_snapshot` som cron).
- Bundles/BOM, produksjon.
- Multi-valuta på salg (COGS er alltid basisvaluta).
- Regnskapsintegrasjon (Tripletex-bilag for lagerendringer) — `cogs_correction` og `movement.total_cost` er laget for å kunne mates dit senere.

---

## 10. Akseptansetester (skal implementeres som automatiske tester)

Alle med én item `KNIV-1`, lokasjon `MAIN` med mindre annet er sagt. Kost i NOK.

| # | Scenario | Forventet |
|---|---|---|
| T1 | Mottak 10 @ 100, mottak 5 @ 120, salg 12 | COGS = 10×100 + 2×120 = **1 240**; `unit_cost` på salget 103,33; on_hand 3; value 360; avg_cost 120; to `layer_consumption`-rader. |
| T2 | Etter T1: justering `delta: +2` uten unit_cost | unit_cost = **120** (`on_hand_avg`), on_hand 5, value 600. |
| T3 | Lag: 3 @ 100 og 1 @ 140. Justering +2 uten unit_cost | unit_cost = (300+140)/4 = **110**, `cost_source='on_hand_avg'`. |
| T4 | Lag 3 @ 100, 1 @ 140. Justering `new_qty: 1` | delta −3: konsumerer 3 @ 100 (FIFO) → total_cost 300; igjen 1 @ 140. |
| T5 | on_hand 0, ingen lag på MAIN, lag finnes på BUTIKK @ 90. Justering +1 uten kost | unit_cost 90, `cost_source='on_hand_avg_all'`. Ingen lag noe sted, siste purchase_receipt @ 95 → 95, `last_purchase`. Ingen historikk → `422 COST_REQUIRED`. |
| T6 | Justering −5 når on_hand 3 | `422 INSUFFICIENT_STOCK`, ingenting skrevet. |
| T7 | on_hand 0, siste kjøp @ 120. Woo-ordre 2 stk (processing) | `sale` −2, on_hand −2, `cost_estimated=true`, total_cost 240, konsum med `layer_id null`. Deretter mottak 10 @ 130: laget får `qty_remaining 8`, konsumet dekkes (`layer_id` satt, unit_cost 130), salget oppdateres til total_cost 260 / `cost_estimated=false`, `cogs_correction.delta_cost = +20`, on_hand 8. |
| T8 | Samme Woo `order.created`-payload leveres to ganger | Én bevegelse per linje; andre kall svarer `action='ignored'`/`existing=true`. |
| T9 | Ordre i T8 får status `cancelled` | `sale_return` +qty med `unit_cost` = salgets COGS, `stock_state='restored'`. Nytt `cancelled`-webhook → ingenting. |
| T10 | Ordre `deducted` med linje qty 2; `order.updated` med samme linje qty 3 | `sale` −1 med `ref_line='<line>:2'`. Så qty 1 → `sale_return` +2. |
| T11 | Refund med line_item quantity −1 på ordre som har trukket 2 | `sale_return` +1 (`woo_refund`). Samme refund igjen → ignored. Refund på 5 når bare 2 er trukket → +2 (begrenses). |
| T12 | Overføring 4 fra MAIN (lag 3 @ 100 mottatt 1.9, 2 @ 140 mottatt 5.9) til BUTIKK | MAIN: 0 @ 100, 1 @ 140. BUTIKK: lag 3 @ 100 `received_at` 1.9 og 1 @ 140 `received_at` 5.9. Salg 1 på BUTIKK → COGS 100. |
| T13 | Overføring 5 når MAIN har 4 | `422 INSUFFICIENT_STOCK`. |
| T14 | Mottak 10 @ 100, salg 3, reverser mottaket | `409 LAYER_CONSUMED`. Uten salg: reversal −10 fra laget, `qty_received` på PO-linjen tilbake til 0, PO-status tilbake til `sent`. |
| T15 | Reverser salget i T1 | `reversal` +12: lag 10 @ 100 og 2 @ 120 gjenopprettes med opprinnelige `received_at`; on_hand 15; salget får `reversed_by`. |
| T16 | PO i JPY: linje 10 @ 1 500, fx 0,071, mottak med landed 5/enhet | `unit_cost_base = 1500×0,071+5 = 111,5`; movement.unit_cost 111,5; PO-status `received`. Mottak 6 først → `partially_received`, on_order 4. |
| T17 | Mottak 12 på linje med 10 bestilt uten `allow_over_receipt` | `422 OVER_RECEIPT`; med flagg → ok, qty_received 12. |
| T18 | To samtidige `new_qty: 5` når on_hand 3 | Første: +2. Andre (venter på lås): delta 0, ingen bevegelse. on_hand 5. |
| T19 | Etter hvert skrivende kall | `stock_push_queue` har item; `/sync/push-stock` setter Woo `stock_quantity = available` (variasjon via parent-endepunkt); ny kjøring uten endring pusher ingenting. |
| T20 | `verify_integrity()` etter T1–T19 | Ingen avvik: Σ qty per item/loc = on_hand; Σ qty_remaining = max(on_hand,0); udekket = max(−on_hand,0). |
| T21 | `GET /movements?type=sale,sale_return&from=&to=&sku=` med 1 200 rader, limit 500 | 3 sider via cursor, stabil rekkefølge `id desc`, ingen duplikater. |
| T22 | Item med `track_stock=false` | Bevegelser tillatt, aldri push, `skipped` i push-status. |

---

## 11. Teknisk gjennomføring — separat modul, API-lag og UI på toppen

### 11.1 Tre lag, tre eierskap

```
┌──────────────────────────────────────────────────────────────────┐
│ UI (per butikk, bygges fritt)                                     │
│   internal-web: /lager, /varemottak, /stock-adjustments, caser … │
│   bark-internal-web: egne sider                                   │
│   kaller KUN /api/inventory/* over HTTP (fetch med session)       │
├──────────────────────────────────────────────────────────────────┤
│ API-lag (kopiert fra modulen, identisk i alle butikker)           │
│   pages/api/inventory/**  +  lib/inventory/*                      │
│   auth, zod-validering, pg → RPC, Woo-push, Woo-webhook           │
├──────────────────────────────────────────────────────────────────┤
│ Ledger-kjernen (modulen — schema `inv` i butikkens Supabase)      │
│   tabeller, FIFO-funksjoner, views, triggere, outbox              │
│   all forretningslogikk; kan også kalles via supabase.rpc()       │
└──────────────────────────────────────────────────────────────────┘
```

Regelen: **ingen forretningslogikk over kjernen.** API-laget mapper HTTP ↔ jsonb og gjør det Postgres ikke kan (nettverk mot Woo). UI-et har bare presentasjon og skjema-state. Hvis en regel må endres (kostvalg, statusflyt), endres den i én SQL-funksjon og rulles ut som migrasjon til alle butikker — API og UI er uendret.

### 11.2 Modulen er et eget repo: `inventory-ledger`

Opprettes som eget GitHub-repo under Skarpekniver-orgen (struktur i §8). Ingen runtime-avhengighet mellom butikkene — hver butikk har sin kopi av migrasjoner + API-filer, stemplet med versjon. Det er samme modell som CLAUDE.md i v3 foreskriver for deling («kopier med kilde-referanse»), bare satt i system:

- `migrations/` er kanonisk. Hver fil har header `-- inventory-ledger vX.Y.Z` og siste migrasjon setter `inv.settings.schema_version`.
- `api/` er kanonisk. Hver fil har header `// inventory-ledger vX.Y.Z — DO NOT EDIT in the shop repo; change upstream and re-install`.
- `scripts/install.mjs <sti-til-butikk-repo>` kopierer `api/lib/inventory/*` → `lib/inventory/`, `api/pages/api/inventory/**` → `pages/api/inventory/`, og `migrations/*.sql` → `supabase/migrations/<timestamp>_inv_*.sql` (kun filer som ikke finnes fra før), og skriver `inventory-ledger.lock.json` (`{ version, installed_at, files: [sha256…] }`) i butikk-repoet. Kjøres på nytt ved oppgradering; diff vises før overskriving.
- Butikk-spesifikt ligger **utenfor** de kopierte filene: `0090_catalog_adapter_<butikk>.sql` (skrives per butikk, bor i butikkens `supabase/migrations/`), env, cron-registrering, og `lib/inventory/config.js` (én fil per butikk: `{ wooPush: true, defaultLocation: 'MAIN', slackChannel: '#lager' }`).
- Versjonering: semver + git-tag. Breaking = endret jsonb-kontrakt på en RPC eller endret HTTP-respons.

**Git-arbeidsflyt — `inventory-ledger` er master, alltid (ikke-forhandlingsbart):**

1. **All endring i modulen gjøres i repoet `inventory-ledger` via pull request mot `main`.** Dette gjelder migrasjoner, SQL-funksjoner, API-ruter, lib-filer, tester og denne specen. Ingen direkte push til `main`; PR-en kjører `supabase db reset` + SQL-testene + API-testene i CI før merge.
2. **Butikk-repoene (`internal-web`, `bark-internal-web`, …) puller fra master — de skriver aldri tilbake.** Etter merge tagges en versjon, og hver butikk oppdaterer med `node scripts/install.mjs <sti>` (eller `npx inventory-ledger install` når det er pakket), som kopierer inn de nye filene og oppdaterer `inventory-ledger.lock.json`. Den kopieringen committes i butikk-repoet som én commit `chore(inventory): bump inventory-ledger to vX.Y.Z` — etter butikkens egen git-konvensjon (rett på `main` i internal-web, PR i Bark).
3. **Filer som er kopiert fra modulen redigeres aldri lokalt i et butikk-repo.** Oppdager man en feil mens man jobber i en butikk: fiks i `inventory-ledger` → PR → merge → tag → install i butikken. Headeren `DO NOT EDIT in the shop repo` i hver fil + lock-filens sha256 gjør avvik synlige; `scripts/install.mjs --check` feiler hvis en lokal kopi er endret, og kan kjøres i butikkens CI.
4. **Butikk-spesifikt bor i butikken** (katalog-adapter, `lib/inventory/config.js`, env, cron-registrering, UI) og går gjennom butikkens vanlige flyt. Grensen er skarp: er det noe som gjelder alle butikker, hører det hjemme i modulen.
5. Agenter som jobber i et butikk-repo og trenger en endring i modulen, skal stoppe og si fra (eller åpne PR i `inventory-ledger`) — ikke patche kopien lokalt.

### 11.3 Utviklingsmiljø

- Lokal Supabase: `supabase init` + `supabase start` i modul-repoet (Docker). `supabase db reset` kjører alle migrasjoner fra scratch — det er «build»-steget for SQL.
- SQL-tester kjøres med `psql` mot lokal instans: `tests/sql/*.sql` er plain SQL med `DO $$ … ASSERT … $$` (eller pgTAP om agenten foretrekker det). Ett scenario per fil, nummerert som §10 (`t01_fifo.sql`, `t07_negative_cover.sql` …). `npm run test:sql` = reset + kjør alle.
- API-tester: en minimal Next.js-app i `api/` (bare `pages/api/inventory/**` + `lib/inventory/*`) med `next dev` mot lokal Supabase (`INVENTORY_DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres`) og vitest + `fetch` mot `localhost:3000`. Woo mockes med en liten `msw`-handler for `/wc/v3/products/batch` og `/orders/:id/refunds/:rid`.
- Modulen deployes **ikke** selv — den har ingen Vercel-prosjekt. Den kjører bare inne i butikkenes internal-webs.

### 11.4 Rekkefølge (faser med «ferdig når»)

| Fase | Innhold | Ferdig når |
|---|---|---|
| **1. Kjerne** | `0001`–`0003`: typer, tabeller, indekser, triggere (immutabilitet, outbox, updated_at), `post_movement` m/ FIFO + negativ dekking, `create_adjustment`, `create_transfer`, PO + `receive_purchase_order`, `reverse_*`, views, `verify_integrity`. | T1–T7, T12–T18, T20 grønne som SQL-tester. `supabase db reset` feilfri. |
| **2. Woo-kjerne** | `0004`: `apply_woo_order`, `apply_woo_refund`, `woo_order_sync`, `stock_push_queue` + trigger, `list_stock_push_due`/`mark_stock_pushed`. | T8–T11, T19 (DB-delen), T22 grønne. |
| **3. API-lag** | `lib/inventory/{db,rpc,auth,validate,csv}.js` + alle ruter i §6.1–6.5. Feilmapping (§6.0). Idempotency-Key. CSV-eksport. | vitest mot lokal Supabase: hver rute har minst én happy-path + én feiltest. `npm run build` i `api/`. |
| **4. Woo-integrasjon** | `lib/inventory/woo-order.js` (webhook + HMAC + refund-henting), `woo-push.js` (batch-push, backoff, reconcile), `/sync/*`-ruter, `scripts/backfill-woo-orders.mjs`. | T19 ende-til-ende mot msw-mock. Reconcile rapporterer 0 avvik etter push. |
| **5. Installasjon Skarpekniver** | `0090_catalog_adapter_skarpekniver.sql` (leser v3-Supabase sine `products`/`product_variations`), `scripts/install.mjs` kjørt mot internal-web, `lib/inventory/db.js` med egen pool (`INVENTORY_DATABASE_URL` → v3-Supabase pooler), middleware-allowlist, cron-registrering, `scripts/import-opening-balance-cin7.mjs`. | Åpningsbalanse importert i staging, `verify_integrity` OK, `/sync/reconcile` viser forventede avvik (= Cin7 vs ledger på 0). |
| **6. UI Skarpekniver** | Se §11.6. Bytt `/stock-adjustments`, `/varemottak`, `/lager > movements`, `lib/stock-adjust.js`-kallene i caser/avvik, `supplier-reorder`/`pending-po` → `POST /purchase-orders`. | Drift bruker de nye sidene en uke parallelt med Cin7 før Cin7→Woo-integrasjonen skrus av (§8 pkt 8). |
| **7. Installasjon Bark** | Adapter for Barks Supabase-speil, install, åpningsbalanse fra CSV/Shopify-eksport. | Samme som fase 5. |

Fase 1–4 er modul-repoet alene og kan bygges uten tilgang til butikkene. Fase 5–7 skjer i butikk-repoene.

### 11.5 Hvordan hvert internal-web kobler seg på

**Skarpekniver `internal-web`** (RetoolDB som `DATABASE_URL`): ledgeren bor i v3 sin Supabase (der produktspeilet allerede ligger). Derfor en **egen pool** i `lib/inventory/db.js` på `INVENTORY_DATABASE_URL` (Supabase transaction pooler, 6543, `sslmode=require`, `max: 5`). Alt under `/api/inventory/*` bruker den poolen; ingen cross-DB-joins. Der UI-et i dag joiner `products.current_stock` fra RetoolDB, hentes status i stedet fra `GET /api/inventory/stock?skus=…` (batch, maks 500 SKU-er per kall) og merges klientside — eller via en daglig cron som speiler `inv.v_item_status` inn i RetoolDB-`products` (`current_stock`, `average_cost`) så eksisterende views (`v_product_sales`, forecast, prismonitor) fortsetter å virke uten endring. **Anbefalt: gjør begge** — speilet dekker rapporter, live-kallet dekker drift-sidene.

**`bark-internal-web`**: `inv` bor i barkavenue-Supabase (storefronten), ikke i internal-web sin egen database. `INVENTORY_DATABASE_URL` er derfor påkrevd også her — `lib/inventory/db.js` har **ingen** fallback til `DATABASE_URL` (fra v0.5.0), så en manglende variabel feiler høyt i stedet for å skrive lageret til feil database.

**Auth-wiring:** `lib/inventory/auth.js > requireInventoryAuth(req, res)` godtar `Authorization: Bearer $INVENTORY_API_KEY` eller NextAuth-session, og returnerer `{ by }` (e-post fra session, eller `api-key:<label>`) som alle skrivende ruter putter i `by`. I internal-web delegeres til eksisterende `requireSecretOrSession` med `INVENTORY_API_KEY` som ekstra godkjent secret; i Bark til `assertCronAuth`-mønsteret + `getServerSession`. Webhook-rutene bruker HMAC i stedet og allowlistes i `middleware.js`.

**Cron-wiring:** `pages/api/cron/inventory-push-stock.js`, `inventory-reconcile.js`, `inventory-items-sync.js` er tynne wrappere som kaller funksjonene i `lib/inventory/woo-push.js` og registreres i `CRON_JOBS` + `vercel.json` etter repoets sjekkliste. Selve jobbene bor i modulen; wrapperne er 10 linjer.

### 11.6 Hvordan UI-ene bruker API-et

UI-et snakker **bare HTTP mot `/api/inventory/*`** med session-cookie, aldri `pg`/RPC direkte. Det holder UI-koden fri for SQL og gjør at samme side kan kopieres til neste butikk.

Mønstre per flate (Skarpekniver som eksempel):

| Flate | Kall | Flyt |
|---|---|---|
| Varestatus på produktkort (`/lager`, caser, forecast) | `GET /stock/:sku` | Vis `on_hand` per lokasjon, `available`, `on_order` + `next_delivery`, `avg_cost`. Lag-lista (`layers[]`) vises i en «Kost»-fold. |
| Juster lager (`applyStockDelta`-erstatning) | `POST /adjustments/preview` → vis delta/kost per linje → `POST /adjustments` | Brukeren taster `delta` eller `new_qty`; preview viser «3 → 5, kost 120 (snitt på lager)». `COST_REQUIRED` → vis prisfelt og send på nytt. Respons inneholder `movements[]` → vis som bekreftelse. |
| Ettersending/bytte/knust (caser, avvik) | `POST /adjustments { reason:'ettersending', lines:[{sku, delta:-1}] }` | Erstatter `adjustStockForSend`. Resultatet lagres fortsatt som `stock_adjustment` jsonb på case-/avviksraden (uendret UI-badge), men nå med `adjustment_id` + `movement_id` i stedet for Cin7/Woo-status. Woo-push er automatisk — den gamle `adjustWoo` fjernes. |
| Sett lager til 0 (`zeroStock`) | `POST /adjustments { lines:[{sku, new_qty:0}] }` | Samme ≤3-regel håndheves i UI/case-koden som før (ledgeren bryr seg ikke). |
| Innkjøp (`supplier-reorder`, `pending-po`, JBT auto-PO) | `POST /purchase-orders` (draft) → `POST /:id/status {sent}` | `pending_po` beholdes for leverandør-token-flyten; `markSent` kaller nå `POST /purchase-orders` i stedet for `createPurchaseOrder` i Cin7, og lagrer `inventory_po_id`. |
| Varemottak (`/varemottak`) | `GET /purchase-orders?status=sent,partially_received` → `GET /:id` → `POST /:id/receive` | `goods_receipt_confirmations` (drift bekrefter linje for linje) beholdes som arbeidsflate; «Fullfør mottak» sender bekreftede linjer som `lines[]` med `qty` + ev. overstyrt `unit_cost`. Avvik-Slack som før. Delmottak = flere receive-kall. |
| Movements (`/lager > Vareflyt`) | `GET /movements?sku=&type=&from=&to=&cursor=` | Erstatter `cin7-movements.js`. `kind` for fargekoding, `on_hand_after` som saldo-kolonne, «Last mer» på `next_cursor`, «Eksporter» = samme URL + `format=csv`. |
| Stock adjustments-liste (`/stock-adjustments`) | `GET /adjustments` → `GET /adjustments/:id` → `POST /:id/reverse` | Erstatter `cin7-stock-adjustments.js`; ingen lazy-henting lenger (alt er lokalt). |
| Overføring lager → butikk | `POST /transfers` | Ny side/fane; refill-flyten (`refill-butikk-daily`) kan senere poste transfers automatisk når plukket er bekreftet. |
| Lager-helse (dashboard) | `GET /stock?negative=1`, `GET /stock?below_reorder=1`, `GET /sync/status` | Kort på forsiden: negative varer (udekket konsum), under bestillingspunkt, push-kø/feil. |

Klient-helper (kopieres med modulen, `lib/inventory/client.js`, **kun fetch**, ingen `pg`-import så den er trygg i React):

```js
export async function inv(path, { method = 'GET', body, idempotencyKey } = {}) {
  const res = await fetch(`/api/inventory${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || res.statusText), { code: json?.error?.code, details: json?.error?.details, status: res.status });
  return json;
}
// Bruk: const { data, next_cursor } = await inv('/movements?sku=KNIV-1&type=sale');
//       await inv('/adjustments', { method: 'POST', body: {...}, idempotencyKey: crypto.randomUUID() });
```

UI-regler: alle skrivende knapper sender `Idempotency-Key` (dobbeltklikk/retry er trygt); feilkoder fra §6.0 mappes til brukertekst ett sted (`lib/inventory/errors.js`: `INSUFFICIENT_STOCK → «Ikke nok på lager (3 på MAIN)»`); etter et skriv re-hentes status fra `GET /stock/:sku` i stedet for å regne lokalt.

### 11.7 Eksterne konsumenter (ikke UI)

- **skarpekniverv3 / Bark-storefront**: trenger ikke API-et — `available` kan leses direkte fra `inv.v_item_status` i samme Supabase (read-only view, `grant select` til `anon`/`service_role` etter behov), eller fortsette å lese Woo `stock_quantity` som pushes. Anbefalt: fortsett med Woo-feltet (ingen endring i v3), men eksponér viewet for «lagerstatus i sanntid»-features senere.
- **Agenter/Jarvis/Retool**: `Authorization: Bearer $INVENTORY_API_KEY` mot samme ruter. `GET /stock`, `GET /movements` og `GET /reports/cogs` er laget for det.
- **Regnskap (senere)**: `GET /reports/cogs` + `GET /valuation` er de to tallene et bilag trenger.

### 11.8 Definition of done per butikk

`verify_integrity()` tom; `/sync/reconcile` 0 avvik to dager på rad; alle UI-flater i §11.6 byttet og gamle Cin7-kall fjernet (grep etter `cin7Request` i lager-/varemottak-/case-kode gir 0 treff utenfor `sync-products`/`sync-suppliers`); `inventory-ledger.lock.json` sjekket inn; CLAUDE.md i butikk-repoet har en kort «Inventory ledger»-seksjon som peker hit.

---

## 12. Åpne punkter (avklares under bygging, ikke blokkerende)

- Butikk Vulkan: egen lokasjon med `sellable_online=false`, eller del av nett-tilgjengelig beholdning? Påvirker hva som pushes til Woo. Default i spec: egen lokasjon, `sellable_online=true` (samme som i dag der alt teller), kan endres per lokasjon når som helst.
- Kassesalg i butikk går i dag gjennom Woo (`Kontant (Cashier)`) — de kommer dermed inn som vanlige Woo-ordre og trekker fra default-lokasjon med mindre POS setter `meta_data.inv_location='BUTIKK'`.
- Laks & Vilt / B2B-ordrer som lages i Woo trekker automatisk; de som faktureres utenom Woo må registreres via `POST /sales`.
- Eksponering via PostgREST (`supabase.rpc('…')`) krever at `inv` legges til i «Exposed schemas» i Supabase, eller tynne `public.inv_*`-wrappere. Ikke nødvendig når alt går via internal-web, men greit å ha for v3/Retool.
