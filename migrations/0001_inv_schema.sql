-- inventory-ledger v0.6.0
-- =============================================================================
-- 0001_inv_schema.sql — schema `inv`: types, tables, indexes, triggers, seed
-- =============================================================================
-- Source: docs/spec.md §2. Idempotent where that is practical (IF NOT EXISTS).
-- Do not edit in shop repos — change it in inventory-ledger and re-install.
-- =============================================================================

create schema if not exists inv;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
do $$ begin
  create type inv.movement_type as enum (
    'opening_balance', 'purchase_receipt',
    'sale', 'sale_return',
    'adjustment_in', 'adjustment_out', 'write_off',
    'transfer_out', 'transfer_in',
    'reversal'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type inv.po_status as enum (
    'draft', 'sent', 'partially_received', 'received', 'closed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Utility
-- ---------------------------------------------------------------------------
create or replace function inv.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
create table if not exists inv.settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

insert into inv.settings (key, value) values
  ('base_currency',        'NOK'),
  ('allow_negative_sale',  'true'),
  ('woo_push_enabled',     'true'),
  ('woo_push_floor_zero',  'true'),
  ('po_number_prefix',     'PO-'),
  ('deduct_statuses',      'processing,on-hold,completed'),
  ('restore_statuses',     'cancelled,refunded,trash,failed'),
  ('schema_version',       '0.1.0')
on conflict (key) do nothing;

-- Document number sequences
create sequence if not exists inv.po_number_seq;
create sequence if not exists inv.gr_number_seq;
create sequence if not exists inv.adj_number_seq;
create sequence if not exists inv.tr_number_seq;

-- ---------------------------------------------------------------------------
-- location
-- ---------------------------------------------------------------------------
create table if not exists inv.location (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique check (code = upper(code) and code !~ '\s'),
  name             text not null,
  is_default       boolean not null default false,
  sellable_online  boolean not null default true,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists uq_location_default on inv.location (is_default) where is_default;
drop trigger if exists trg_location_updated on inv.location;
create trigger trg_location_updated before update on inv.location
  for each row execute function inv.set_updated_at();

insert into inv.location (code, name, is_default)
select 'MAIN', 'Main warehouse', true
where not exists (select 1 from inv.location where is_default);

-- ---------------------------------------------------------------------------
-- item — mirror of the Woo product master (one row per simple product / variation)
-- ---------------------------------------------------------------------------
create table if not exists inv.item (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null check (btrim(sku) <> ''),
  woo_product_id    bigint,
  woo_variation_id  bigint,
  name              text,
  track_stock       boolean not null default true,
  active            boolean not null default true,
  reorder_point     numeric(14,3),
  reorder_qty       numeric(14,3),
  attributes        jsonb not null default '{}',
  synced_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists uq_item_sku on inv.item (upper(btrim(sku)));
create unique index if not exists uq_item_woo on inv.item (woo_product_id, woo_variation_id) nulls not distinct
  where woo_product_id is not null;
drop trigger if exists trg_item_updated on inv.item;
create trigger trg_item_updated before update on inv.item
  for each row execute function inv.set_updated_at();

-- ---------------------------------------------------------------------------
-- movement — the ledger itself (append-only)
-- ---------------------------------------------------------------------------
create table if not exists inv.movement (
  id              bigserial primary key,
  item_id         uuid not null references inv.item(id),
  location_id     uuid not null references inv.location(id),
  type            inv.movement_type not null,
  qty             numeric(14,3) not null check (qty <> 0),
  unit_cost       numeric(14,4),
  total_cost      numeric(14,2),
  cost_estimated  boolean not null default false,
  cost_source     text,
  on_hand_after   numeric(14,3),
  ref_type        text,
  ref_id          text,
  ref_line        text,
  reference       text,
  note            text,
  created_by      text,
  occurred_at     timestamptz not null default now(),
  reversal_of     bigint references inv.movement(id),
  reversed_by     bigint references inv.movement(id),
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  constraint movement_sign_chk check (
       (type in ('sale','adjustment_out','write_off','transfer_out') and qty < 0)
    or (type in ('opening_balance','purchase_receipt','sale_return','adjustment_in','transfer_in') and qty > 0)
    or  type = 'reversal'
  )
);
create index if not exists idx_movement_item_time on inv.movement (item_id, occurred_at desc, id desc);
create index if not exists idx_movement_location   on inv.movement (location_id, id desc);
create index if not exists idx_movement_type       on inv.movement (type, id desc);
create index if not exists idx_movement_ref        on inv.movement (ref_type, ref_id);
create unique index if not exists uq_movement_ref  on inv.movement (ref_type, ref_id, ref_line) nulls not distinct
  where ref_type is not null;

-- Append-only: only cost fields + reversed_by may change, never DELETE.
create or replace function inv.movement_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE: inv.movement rows cannot be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.item_id, new.location_id, new.type, new.qty, new.ref_type, new.ref_id,
      new.ref_line, new.reference, new.note, new.created_by, new.occurred_at,
      new.reversal_of, new.on_hand_after, new.created_at)
     is distinct from
     (old.id, old.item_id, old.location_id, old.type, old.qty, old.ref_type, old.ref_id,
      old.ref_line, old.reference, old.note, old.created_by, old.occurred_at,
      old.reversal_of, old.on_hand_after, old.created_at) then
    raise exception 'IMMUTABLE: only cost fields, reversed_by and metadata may change on inv.movement'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_movement_guard on inv.movement;
create trigger trg_movement_guard before update or delete on inv.movement
  for each row execute function inv.movement_guard();

-- ---------------------------------------------------------------------------
-- cost_layer — FIFO layers
-- ---------------------------------------------------------------------------
create table if not exists inv.cost_layer (
  id              bigserial primary key,
  item_id         uuid not null references inv.item(id),
  location_id     uuid not null references inv.location(id),
  movement_id     bigint not null references inv.movement(id),
  qty_in          numeric(14,3) not null check (qty_in > 0),
  qty_remaining   numeric(14,3) not null check (qty_remaining >= 0 and qty_remaining <= qty_in),
  unit_cost       numeric(14,4) not null check (unit_cost >= 0),
  received_at     timestamptz not null,
  source_layer_id bigint references inv.cost_layer(id),
  created_at      timestamptz not null default now()
);
create index if not exists idx_layer_fifo on inv.cost_layer (item_id, location_id, received_at, id)
  where qty_remaining > 0;
create index if not exists idx_layer_movement on inv.cost_layer (movement_id);

-- ---------------------------------------------------------------------------
-- layer_consumption — which layers an outbound movement consumed
-- ---------------------------------------------------------------------------
create table if not exists inv.layer_consumption (
  id                      bigserial primary key,
  movement_id             bigint not null references inv.movement(id),
  layer_id                bigint references inv.cost_layer(id),
  qty                     numeric(14,3) not null check (qty > 0),
  unit_cost               numeric(14,4) not null,
  estimated               boolean not null default false,
  covered_by_movement_id  bigint references inv.movement(id),
  created_at              timestamptz not null default now()
);
create index if not exists idx_consumption_movement on inv.layer_consumption (movement_id);
create index if not exists idx_consumption_layer    on inv.layer_consumption (layer_id);
create index if not exists idx_consumption_open     on inv.layer_consumption (movement_id, id)
  where layer_id is null and covered_by_movement_id is null;

-- ---------------------------------------------------------------------------
-- cogs_correction — difference when an estimated cost is covered by a real layer
-- ---------------------------------------------------------------------------
create table if not exists inv.cogs_correction (
  id                      bigserial primary key,
  movement_id             bigint not null references inv.movement(id),
  covered_by_movement_id  bigint not null references inv.movement(id),
  qty                     numeric(14,3) not null,
  estimated_unit_cost     numeric(14,4) not null,
  actual_unit_cost        numeric(14,4) not null,
  delta_cost              numeric(14,2) not null,
  created_at              timestamptz not null default now()
);
create index if not exists idx_cogs_corr_movement on inv.cogs_correction (movement_id);
create index if not exists idx_cogs_corr_created  on inv.cogs_correction (created_at);

-- ---------------------------------------------------------------------------
-- stock_balance — cache + lock row per (item × location)
-- ---------------------------------------------------------------------------
create table if not exists inv.stock_balance (
  item_id      uuid not null references inv.item(id),
  location_id  uuid not null references inv.location(id),
  on_hand      numeric(14,3) not null default 0,
  value        numeric(14,2) not null default 0,
  last_movement_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (item_id, location_id)
);

-- ---------------------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------------------
create table if not exists inv.purchase_order (
  id             uuid primary key default gen_random_uuid(),
  number         text not null unique,
  status         inv.po_status not null default 'draft',
  supplier_name  text not null,
  supplier_id    text,
  supplier_ref   text,
  currency       text not null,
  fx_rate        numeric(14,6) check (fx_rate is null or fx_rate > 0),
  location_id    uuid references inv.location(id),
  order_date     date,
  expected_at    date,
  note           text,
  created_by     text,
  sent_at        timestamptz,
  received_at    timestamptz,
  cancelled_at   timestamptz,
  closed_at      timestamptz,
  metadata       jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_po_status   on inv.purchase_order (status);
create index if not exists idx_po_supplier on inv.purchase_order (supplier_name);
drop trigger if exists trg_po_updated on inv.purchase_order;
create trigger trg_po_updated before update on inv.purchase_order
  for each row execute function inv.set_updated_at();

create table if not exists inv.purchase_order_line (
  id                    uuid primary key default gen_random_uuid(),
  po_id                 uuid not null references inv.purchase_order(id) on delete cascade,
  position              int not null default 0,
  item_id               uuid not null references inv.item(id),
  sku                   text not null,
  qty_ordered           numeric(14,3) not null check (qty_ordered > 0),
  qty_received          numeric(14,3) not null default 0 check (qty_received >= 0),
  unit_cost             numeric(14,4) not null check (unit_cost >= 0),
  landed_cost_per_unit  numeric(14,4) not null default 0 check (landed_cost_per_unit >= 0),
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (po_id, item_id)
);
create index if not exists idx_pol_item on inv.purchase_order_line (item_id);
drop trigger if exists trg_pol_updated on inv.purchase_order_line;
create trigger trg_pol_updated before update on inv.purchase_order_line
  for each row execute function inv.set_updated_at();

create table if not exists inv.goods_receipt (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  po_id        uuid not null references inv.purchase_order(id),
  location_id  uuid not null references inv.location(id),
  received_at  timestamptz not null,
  received_by  text,
  fx_rate      numeric(14,6) not null,
  note         text,
  status       text not null default 'completed' check (status in ('completed','reversed')),
  created_at   timestamptz not null default now()
);
create index if not exists idx_gr_po on inv.goods_receipt (po_id);

create table if not exists inv.goods_receipt_line (
  id                    uuid primary key default gen_random_uuid(),
  receipt_id            uuid not null references inv.goods_receipt(id),
  po_line_id            uuid not null references inv.purchase_order_line(id),
  item_id               uuid not null references inv.item(id),
  qty                   numeric(14,3) not null check (qty > 0),
  unit_cost             numeric(14,4) not null check (unit_cost >= 0),
  landed_cost_per_unit  numeric(14,4) not null default 0,
  unit_cost_base        numeric(14,4) not null,
  movement_id           bigint references inv.movement(id),
  note                  text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_grl_receipt on inv.goods_receipt_line (receipt_id);

-- ---------------------------------------------------------------------------
-- Adjustment
-- ---------------------------------------------------------------------------
create table if not exists inv.adjustment (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique,
  location_id  uuid not null references inv.location(id),
  reason       text not null,
  note         text,
  write_off    boolean not null default false,
  created_by   text,
  occurred_at  timestamptz not null default now(),
  status       text not null default 'completed' check (status in ('completed','reversed')),
  created_at   timestamptz not null default now()
);
create index if not exists idx_adj_created on inv.adjustment (created_at desc);

create table if not exists inv.adjustment_line (
  id                       uuid primary key default gen_random_uuid(),
  adjustment_id            uuid not null references inv.adjustment(id),
  position                 int not null default 0,
  item_id                  uuid not null references inv.item(id),
  qty_before               numeric(14,3) not null,
  qty_delta                numeric(14,3) not null,
  qty_after                numeric(14,3) not null,
  unit_cost                numeric(14,4),
  cost_source              text,
  movement_id              bigint references inv.movement(id),
  revalue_out_movement_id  bigint references inv.movement(id),
  note                     text,
  created_at               timestamptz not null default now()
);
create index if not exists idx_adjl_adj on inv.adjustment_line (adjustment_id);

-- ---------------------------------------------------------------------------
-- Transfer
-- ---------------------------------------------------------------------------
create table if not exists inv.transfer (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique,
  from_location_id  uuid not null references inv.location(id),
  to_location_id    uuid not null references inv.location(id),
  note              text,
  created_by        text,
  occurred_at       timestamptz not null default now(),
  status            text not null default 'completed' check (status in ('completed','reversed')),
  created_at        timestamptz not null default now(),
  check (from_location_id <> to_location_id)
);

create table if not exists inv.transfer_line (
  id               uuid primary key default gen_random_uuid(),
  transfer_id      uuid not null references inv.transfer(id),
  position         int not null default 0,
  item_id          uuid not null references inv.item(id),
  qty              numeric(14,3) not null check (qty > 0),
  out_movement_id  bigint references inv.movement(id),
  in_movement_id   bigint references inv.movement(id),
  created_at       timestamptz not null default now()
);
create index if not exists idx_trl_transfer on inv.transfer_line (transfer_id);
