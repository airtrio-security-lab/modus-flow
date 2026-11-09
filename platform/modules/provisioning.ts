import { withAdminTx, type Database } from '../db/pool.ts';
import type { OrgRole } from '../domain/model.ts';

/**
 * Operator-only provisioning (organizations, users, memberships). Runs without
 * the application role, so it is exposed only to CLIs and tests — never HTTP.
 * Real deployments will source users from SSO; see docs/adr/0004.
 */
export async function createUser(db: Database, displayName: string, externalSubject?: string): Promise<string> {
  return withAdminTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO users (display_name, external_subject) VALUES ($1, $2) RETURNING id',
      [displayName, externalSubject ?? null],
    );
    return rows[0]!.id;
  });
}

export async function createOrganization(db: Database, slug: string, name: string): Promise<string> {
  return withAdminTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO organizations (slug, name) VALUES ($1, $2) RETURNING id',
      [slug, name],
    );
    return rows[0]!.id;
  });
}

export async function addMember(
  db: Database,
  orgId: string,
  userId: string,
  roles: OrgRole[] = ['employee'],
  profile: { department?: string; jobTitle?: string } = {},
): Promise<string> {
  return withAdminTx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO memberships (organization_id, user_id, roles, department, job_title)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, userId, roles, profile.department ?? null, profile.jobTitle ?? null],
    );
    return rows[0]!.id;
  });
}
