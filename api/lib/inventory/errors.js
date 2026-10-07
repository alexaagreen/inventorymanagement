// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
//
// Feilkoder → HTTP-status (spec §6.0) og norsk brukertekst for UI.
// Isomorf: ingen server-importer, trygg i React.

export const STATUS_BY_CODE = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  ITEM_NOT_FOUND: 404,
  LOCATION_NOT_FOUND: 404,
  PO_NOT_FOUND: 404,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  DUPLICATE_REF: 409,
  LAYER_CONSUMED: 409,
  PO_LOCKED: 409,
  ALREADY_REVERSED: 409,
  IMMUTABLE: 409,
  INSUFFICIENT_STOCK: 422,
  COST_REQUIRED: 422,
  OVER_RECEIPT: 422,
  PO_STATUS_INVALID: 422,
  INTERNAL: 500,
};

export class InventoryError extends Error {
  constructor(code, message, details = {}, status) {
    super(message);
    this.name = 'InventoryError';
    this.code = code;
    this.details = details || {};
    this.status = status || STATUS_BY_CODE[code] || 500;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/** Gjør en pg-feil fra inv._raise() (P0001 «CODE: tekst», detail=json) om til InventoryError. */
export function fromPgError(err) {
  if (err instanceof InventoryError) return err;
  if (err && err.code === 'P0001') {
    const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(err.message || '');
    if (m) {
      let details = {};
      try { details = err.detail ? JSON.parse(err.detail) : {}; } catch { details = { detail: err.detail }; }
      return new InventoryError(m[1], m[2], details);
    }
  }
  // Ugyldig input som Postgres selv avviser (uuid, tall, dato, enum)
  if (err && ['22P02', '22007', '22008', '22003', '23502', '23514'].includes(err.code)) {
    return new InventoryError('VALIDATION', err.message, { pg_code: err.code });
  }
  return new InventoryError('INTERNAL', err?.message || 'Internal error', {}, 500);
}

const TEXT = {
  no: {
    INSUFFICIENT_STOCK: (d) => d.on_hand != null
      ? `Ikke nok på lager (${Number(d.on_hand)} på ${d.location || 'lokasjonen'}, prøvde å ta ${Number(d.requested)})`
      : 'Ikke nok på lager',
    COST_REQUIRED: (d) => `Varen ${d.sku || ''} har ingen kosthistorikk — oppgi enhetskost`.replace('  ', ' '),
    OVER_RECEIPT: (d) => `Mer enn bestilt: ${d.sku || ''} bestilt ${Number(d.qty_ordered)}, mottatt ${Number(d.qty_received)}`,
    LAYER_CONSUMED: () => 'Varene fra denne bevegelsen er allerede solgt eller flyttet — lag en justering i stedet',
    ALREADY_REVERSED: () => 'Dette er allerede reversert',
    PO_LOCKED: () => 'Innkjøpsordren er låst for endringer',
    PO_STATUS_INVALID: () => 'Ugyldig statusendring for innkjøpsordren',
    ITEM_NOT_FOUND: (d) => `Fant ikke varen ${d.sku || ''}`.trim(),
    LOCATION_NOT_FOUND: (d) => `Fant ikke lokasjonen ${d.location || ''}`.trim(),
    UNAUTHORIZED: () => 'Du er ikke logget inn',
    fallback: 'Noe gikk galt',
  },
  en: {
    INSUFFICIENT_STOCK: (d) => d.on_hand != null
      ? `Not enough stock (${Number(d.on_hand)} on ${d.location || 'location'}, tried to take ${Number(d.requested)})`
      : 'Not enough stock',
    COST_REQUIRED: (d) => `${d.sku || 'This item'} has no cost history — enter a unit cost`,
    OVER_RECEIPT: (d) => `More than ordered: ${d.sku || ''} ordered ${Number(d.qty_ordered)}, already received ${Number(d.qty_received)}`,
    LAYER_CONSUMED: () => 'Stock from this movement has already been sold or moved — make an adjustment instead',
    ALREADY_REVERSED: () => 'This has already been reversed',
    PO_LOCKED: () => 'This purchase order is locked for changes',
    PO_STATUS_INVALID: () => 'That status change is not allowed for this purchase order',
    ITEM_NOT_FOUND: (d) => `Item ${d.sku || ''} not found`.replace('  ', ' '),
    LOCATION_NOT_FOUND: (d) => `Location ${d.location || ''} not found`.replace('  ', ' '),
    UNAUTHORIZED: () => 'You are not signed in',
    fallback: 'Something went wrong',
  },
};

/**
 * Brukertekst for en feil fra API-et. `err` er { code, message, details }.
 * lang: 'no' (default) eller 'en'.
 */
export function userMessage(err, lang = 'no') {
  const t = TEXT[lang] || TEXT.no;
  const d = err?.details || {};
  const f = t[err?.code];
  if (f) return f(d);
  if (err?.code === 'VALIDATION') return err.message || (lang === 'en' ? 'Invalid input' : 'Ugyldig input');
  return err?.message || t.fallback;
}
