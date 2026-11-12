import { createDatabase } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';

// Schema owner connection (not the API's unprivileged login role).
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const db = createDatabase(url, 1);
try {
  console.log(JSON.stringify(await migrate(db)));
} finally {
  await db.close();
}
