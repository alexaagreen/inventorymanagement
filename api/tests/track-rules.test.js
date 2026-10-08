import { describe, it, expect } from 'vitest';
import { mapWooProduct } from '../lib/inventory/woo-push';

const simple = (over = {}) => ({ id: 1, type: 'simple', sku: 'S', name: 'S', status: 'publish', manage_stock: false, categories: [{ id: 2 }], ...over });
const roots = new Map([[2, 'majesty'], [4, 'utleie']]);

describe('v0.6.0 track rules on the Woo REST path', () => {
  it('woo_manage_stock mode follows Woo', () => {
    expect(mapWooProduct(simple({ manage_stock: true }))[0].track_stock).toBe(true);
    expect(mapWooProduct(simple())[0].track_stock).toBe(false);
  });
  it('all mode tracks everything except items only under excluded roots', () => {
    const rules = { mode: 'all', exclude: ['utleie'] };
    expect(mapWooProduct(simple(), [], rules, roots)[0].track_stock).toBe(true);
    expect(mapWooProduct(simple({ categories: [{ id: 4 }] }), [], rules, roots)[0].track_stock).toBe(false);
    expect(mapWooProduct(simple({ categories: [{ id: 2 }, { id: 4 }] }), [], rules, roots)[0].track_stock).toBe(true);
    expect(mapWooProduct(simple({ categories: [] }), [], rules, roots)[0].track_stock).toBe(true);
    const variable = { id: 5, type: 'variable', name: 'V', status: 'publish', categories: [{ id: 4 }] };
    expect(mapWooProduct(variable, [{ id: 51, sku: 'V-1', manage_stock: 'parent', attributes: [] }], rules, roots)[0].track_stock).toBe(false);
  });
});
