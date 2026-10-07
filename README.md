# inventory-ledger

FIFO-varelager (inventory ledger) for WooCommerce-butikker, bygget som et Postgres-schema
(`inv`) + et tynt HTTP-API som installeres i hver butikks internal-web.

- **Spesifikasjon:** [`docs/spec.md`](docs/spec.md)
- **Regler for agenter og utviklere:** [`CLAUDE.md`](CLAUDE.md) — dette repoet er master;
  all endring via PR hit, butikkene puller versjonerte kopier.

## Status

| Fase | Innhold | Status |
|---|---|---|
| 1 | Kjerne: schema, FIFO, justering, overføring, PO/mottak, reversering, views | ✅ |
| 2 | Woo-kjerne i SQL: ordre/refund, push-kø | ⏳ |
| 3 | API-lag (`api/`) | ⏳ |
| 4 | Woo-integrasjon: webhook, push-worker, reconcile | ⏳ |
| 5–7 | Installasjon Skarpekniver, UI, Bark | ⏳ |

## Kom i gang

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres
npm run db:reset     # kjør alle migrasjoner fra scratch
npm run test:sql     # akseptansetester (spec §10)
```

Krever Postgres ≥ 15 og `psql` på PATH.
