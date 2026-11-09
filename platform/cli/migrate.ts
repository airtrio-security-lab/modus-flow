import { createDatabase } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createDatabase(url, 1);
try {
  console.log(JSON.stringify(await migrate(db)));
} finally {
  await db.close();
}
