// Minimal WooCommerce REST-mock for tester (ingen avhengigheter).
import http from 'node:http';

export function startWooMock() {
  const state = {
    products: [],            // Woo product-objekter
    variations: {},          // parentId → [variation]
    refunds: {},             // `${orderId}:${refundId}` → refund
    orders: [],              // for /orders-backfill
    failIds: new Set(),      // id-er som skal feile i batch
    requests: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const path = u.pathname.replace('/wp-json/wc/v3', '');
      const json = body ? JSON.parse(body) : null;
      state.requests.push({ method: req.method, path, body: json, query: Object.fromEntries(u.searchParams) });
      const send = (code, data, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      const paged = (arr) => {
        const per = Number(u.searchParams.get('per_page') || 10);
        const page = Number(u.searchParams.get('page') || 1);
        const total = Math.max(Math.ceil(arr.length / per), 1);
        send(200, arr.slice((page - 1) * per, page * per), { 'x-wp-totalpages': String(total), 'x-wp-total': String(arr.length) });
      };
      let m;
      if (req.method === 'GET' && path === '/products') return paged(state.products);
      if (req.method === 'GET' && (m = /^\/products\/(\d+)\/variations$/.exec(path))) return paged(state.variations[m[1]] || []);
      if (req.method === 'GET' && (m = /^\/products\/(\d+)$/.exec(path))) return send(200, state.products.find((p) => String(p.id) === m[1]) || {});
      if (req.method === 'POST' && (path === '/products/batch' || /^\/products\/\d+\/variations\/batch$/.test(path))) {
        const update = (json.update || []).map((x) => {
          if (state.failIds.has(Number(x.id))) return { id: x.id, error: { code: 'woocommerce_rest_invalid_id', message: 'Invalid ID.' } };
          const target = path === '/products/batch'
            ? state.products.find((p) => p.id === x.id)
            : Object.values(state.variations).flat().find((v) => v.id === x.id);
          if (target) target.stock_quantity = x.stock_quantity;
          return { id: x.id, stock_quantity: x.stock_quantity };
        });
        return send(200, { update });
      }
      if (req.method === 'GET' && (m = /^\/orders\/(\d+)\/refunds\/(\d+)$/.exec(path))) {
        const r = state.refunds[`${m[1]}:${m[2]}`];
        return r ? send(200, r) : send(404, { code: 'woocommerce_rest_invalid_id', message: 'Invalid ID.' });
      }
      if (req.method === 'GET' && path === '/orders') return paged(state.orders);
      return send(404, { code: 'rest_no_route', message: 'No route' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ state, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
