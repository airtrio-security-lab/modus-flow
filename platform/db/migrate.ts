import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Database } from './pool.ts';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url).pathname;
const LOCK_KEY = 7_340_118_202; // arbitrary constant: serializes concurrent migrators

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Forward-only, checksummed migrations. Each file runs in its own transaction;
 * an edited, already-applied file aborts the run instead of drifting silently.
 */
export async function migrate(db: Database, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = await db.pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
