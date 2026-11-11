import { createDatabase } from '../db/pool.ts';
import { sweep } from '../modules/retention.ts';

/**
 * Retention job (ADR-0015): run daily with the schema-owner connection, e.g. cron
 *   0 3 * * *  MIGRATION_DATABASE_URL=… npm run -s platform:retention
 * Purges recordings and transcripts past the organization's retention period (except under
 * legal hold) and re-applies purges listed in retention_log to content restored from a backup.
 * Run it right after any restore from backup as well.
 */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL (schema owner) is required');
const db = createDatabase(url, 1);
try {
  console.log(JSON.stringify({ level: 'info', purged: await sweep(db) }));
} finally {
  await db.close();
}
