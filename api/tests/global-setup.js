import { execSync } from 'node:child_process';
import path from 'node:path';

// Fersk DB én gang før hele suiten. Hver testfil bruker egne SKU-er for isolasjon.
export default function setup() {
  if (!process.env.DATABASE_URL && !process.env.INVENTORY_DATABASE_URL) {
    throw new Error('Set DATABASE_URL to a local Postgres for API tests');
  }
  process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.INVENTORY_DATABASE_URL;
  execSync(path.resolve(__dirname, '../../scripts/db-reset.sh'), { stdio: 'inherit', env: process.env });
}
