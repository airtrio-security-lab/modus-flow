import { createDatabase } from '../db/pool.ts';

/**
 * Escalation job: run on a schedule (e.g. cron every 15 minutes) with the
 * schema-owner connection. Records overdue first responses, overdue decisions
 * and stale items once each, and notifies the escalation contact and the
 * responsible person. Unrouted items also go to organization admins.
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const db = createDatabase(url, 1);
try {
  const { rows } = await db.pool.query<{ n: number }>('SELECT escalate_overdue() AS n');
  // «Приближается срок»: once per item and deadline (ADR-0016).
  const soon = await db.pool.query<{ n: number }>('SELECT notify_deadlines_soon() AS n');
  console.log(JSON.stringify({ level: 'info', escalated: rows[0]!.n, deadlineSoon: soon.rows[0]!.n }));
} finally {
  await db.close();
}
