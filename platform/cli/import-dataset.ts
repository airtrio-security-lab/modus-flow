import { readFile } from 'node:fs/promises';
import { createDatabase } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import type { OrgActor, OrgRole } from '../domain/model.ts';
import { DatasetFile, importDataset } from '../modules/dataset.ts';

/**
 * Import the organizer's official synthetic set (A-001—A-020) into an organization (0017, ADR-0022).
 * Idempotent: rows already imported are skipped, nothing is duplicated.
 *
 *   MIGRATION_DATABASE_URL=… node platform/cli/import-dataset.ts [--org modus-demo] [--file platform/data/official-synthetic-dataset.json]
 *                                                                 [--demo-confirm A-004,A-008]
 *
 * `--demo-confirm` runs the real «внедрение подтверждено» step for the listed rows (only those the set
 * marks «Реализовано») and labels them as a demo confirmation; without it no castle gets XP from the set.
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const slug = arg('org') ?? 'modus-demo';
const path = arg('file') ?? 'platform/data/official-synthetic-dataset.json';
const demoConfirm = (arg('demo-confirm') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const db = createDatabase(url, 4);
try {
  await migrate(db);
  const file = DatasetFile.parse(JSON.parse(await readFile(path, 'utf8')));
  const { rows } = await db.pool.query<{ org: string; id: string; user_id: string; roles: OrgRole[] }>(
    `SELECT o.id AS org, m.id, m.user_id, m.roles FROM organizations o JOIN memberships m ON m.organization_id = o.id
      WHERE o.slug = $1 AND m.status = 'active' AND m.access = 'member' AND 'org_admin' = ANY (m.roles) ORDER BY m.created_at LIMIT 1`,
    [slug],
  );
  const a = rows[0];
  if (!a) throw new Error(`Organization "${slug}" has no active administrator`);
  const actor: OrgActor = { userId: a.user_id, orgId: a.org, membershipId: a.id, roles: a.roles, access: 'member' };
  const report = await importDataset(db, actor, file, { demoConfirm });
  console.log(JSON.stringify({ ...report, imported: report.imported.length, skipped: report.skipped.length, fallback: report.imported.filter((r) => r.routedBy === 'fallback').map((r) => r.id) }));
} finally {
  await db.close();
}
