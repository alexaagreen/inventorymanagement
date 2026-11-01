// inventory-ledger v0.11.0 — DO NOT EDIT in the shop repo; change upstream and re-install.
import { route } from '../../../lib/inventory/handler';
import { GUIDE, guideMarkdown } from '../../../lib/inventory/agent-guide';

// GET /api/inventory            → guide for AI agents and scripts (JSON): auth, conventions, read/write endpoints, recipes
// GET /api/inventory?format=md  → the same as Markdown (paste into an agent's instructions)
export default route({
  GET: async (req, res, { query }) => {
    if (String(query.format || '').toLowerCase() === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      return res.status(200).send(guideMarkdown());
    }
    return GUIDE;
  },
});
