import { describe, it, expect, afterEach, vi } from 'vitest';
import { call } from './helpers';
import fxRoute from '../pages/api/inventory/fx/norges-bank';
import { parseNorgesBankCsv } from '../lib/inventory/fx';

const CSV = [
  'FREQ;Frequency;BASE_CUR;Base Currency;QUOTE_CUR;Quote Currency;TENOR;Tenor;DECIMALS;CALCULATED;UNIT_MULT;Unit Multiplier;COLLECTION;Collection Indicator;TIME_PERIOD;OBS_VALUE',
  'B;Business;JPY;Japanese yen;NOK;Norwegian krone;SP;Spot;4;false;2;Hundreds;C;ECB concertation time 14:15 CET;2026-10-07;6.0571',
].join('\n');

describe('fx: Norges Bank reference rate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses per-100 quotes into NOK per 1 unit', () => {
    expect(parseNorgesBankCsv(CSV, 'JPY')).toEqual({ currency: 'JPY', rate: 0.060571, quoted: 6.0571, per_units: 100, date: '2026-10-07' });
    expect(parseNorgesBankCsv(CSV, 'USD')).toBeNull();
    expect(parseNorgesBankCsv('', 'JPY')).toBeNull();
  });

  it('GET returns the rate for the last business day on or before the date', async () => {
    const fetchMock = vi.fn(async () => new Response(CSV, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await call(fxRoute, { method: 'GET', query: { currency: 'jpy', date: '2026-10-11' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ currency: 'JPY', rate: 0.060571, date: '2026-10-07', requested_date: '2026-10-11', source: 'Norges Bank' });
    expect(fetchMock.mock.calls[0][0]).toContain('B.JPY.NOK.SP');
    expect(fetchMock.mock.calls[0][0]).toContain('endPeriod=2026-10-11');
  });

  it('NOK is 1 without calling out; bad input 400; upstream failure 502', async () => {
    const fetchMock = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await call(fxRoute, { method: 'GET', query: { currency: 'NOK' } })).body.rate).toBe(1);
    expect((await call(fxRoute, { method: 'GET', query: { currency: 'YEN!' } })).status).toBe(400);
    expect((await call(fxRoute, { method: 'GET', query: { currency: 'EUR', date: '2026-10-01' } })).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
