// inventory-ledger v0.3.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
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

/** Brukertekst (norsk) for en feil fra API-et. `err` er { code, message, details }. */
export function userMessage(err) {
  const d = err?.details || {};
  switch (err?.code) {
    case 'INSUFFICIENT_STOCK':
      return d.on_hand != null
        ? `Ikke nok på lager (${Number(d.on_hand)} på ${d.location || 'lokasjonen'}, prøvde å ta ${Number(d.requested)})`
        : 'Ikke nok på lager';
    case 'COST_REQUIRED':
      return `Varen ${d.sku || ''} har ingen kosthistorikk — oppgi enhetskost`.trim();
    case 'OVER_RECEIPT':
      return `Mer enn bestilt: ${d.sku || ''} bestilt ${Number(d.qty_ordered)}, mottatt ${Number(d.qty_received)}`;
    case 'LAYER_CONSUMED':
      return 'Varene fra denne bevegelsen er allerede solgt eller flyttet — lag en justering i stedet';
    case 'ALREADY_REVERSED':
      return 'Dette er allerede reversert';
    case 'PO_LOCKED':
      return 'Innkjøpsordren er låst for endringer';
    case 'PO_STATUS_INVALID':
      return 'Ugyldig statusendring for innkjøpsordren';
    case 'ITEM_NOT_FOUND':
      return `Fant ikke varen ${d.sku || ''}`.trim();
    case 'LOCATION_NOT_FOUND':
      return `Fant ikke lokasjonen ${d.location || ''}`.trim();
    case 'UNAUTHORIZED':
      return 'Du er ikke logget inn';
    case 'VALIDATION':
      return err.message || 'Ugyldig input';
    default:
      return err?.message || 'Noe gikk galt';
  }
}
