// inventory-ledger v0.12.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, withStatus, requireLandedCostTarget } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// POST /api/inventory/landed-costs/preview — same input as POST /landed-costs, writes nothing.
// Shows the split per receipt line and how much goes to stock value, COGS and write-offs.
export default route({
  POST: async (req, res, { body, by }) => {
    requireLandedCostTarget(body);
    return withStatus(200, await rpc('preview_landed_cost', { ...body, by }));
  },
}, { noPush: true });
