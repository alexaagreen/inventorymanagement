// inventory-ledger v0.5.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../lib/inventory/handler';
import { rpc } from '../../../lib/inventory/rpc';

// GET /api/inventory/locations
export default route({
  GET: async () => ({ data: await rpc('list_locations', []) }),
});
