// inventory-ledger v0.4.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route, requireLines, withStatus } from '../../../../lib/inventory/handler';
import { rpc } from '../../../../lib/inventory/rpc';

// POST /api/inventory/adjustments/preview — samme input som POST /adjustments, skriver ingenting
export default route({
  POST: async (req, res, { body, by }) => {
    requireLines(body);
    return withStatus(200, await rpc('preview_adjustment', { reason: 'preview', ...body, by }));
  },
});
