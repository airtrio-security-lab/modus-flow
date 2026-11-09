import { notFound } from '../domain/errors.ts';
import type { OrgActor, OrgRole } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';

/**
 * Resolves the caller's membership in an organization. Unknown organization
 * and "not a member" deliberately produce the same 404, so organization slugs
 * cannot be probed by outsiders.
 */
export async function resolveOrgActor(db: Database, userId: string, orgSlug: string): Promise<OrgActor> {
  const row = await withTx(db, { userId }, async (c) => {
    const { rows } = await c.query<{ org_id: string; membership_id: string; roles: OrgRole[] }>(
      `SELECT o.id AS org_id, m.id AS membership_id, m.roles
         FROM memberships m JOIN organizations o ON o.id = m.organization_id
        WHERE o.slug = $1 AND m.user_id = $2 AND m.status = 'active'`,
      [orgSlug, userId],
    );
    return rows[0];
  });
  if (!row) throw notFound('Организация не найдена');
  return { userId, orgId: row.org_id, membershipId: row.membership_id, roles: row.roles };
}

export const orgTx = (actor: OrgActor) => ({
  userId: actor.userId,
  orgId: actor.orgId,
  membershipId: actor.membershipId,
});

export interface Me {
  id: string;
  displayName: string;
  memberships: { organization: string; organizationName: string; membershipId: string; roles: OrgRole[] }[];
}

export async function getMe(db: Database, userId: string): Promise<Me> {
  return withTx(db, { userId }, async (c) => {
    const user = await c.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users WHERE id = $1',
      [userId],
    );
    const u = user.rows[0];
    if (!u) throw notFound('Пользователь не найден');
    const m = await c.query<{ slug: string; name: string; id: string; roles: OrgRole[] }>(
      `SELECT o.slug, o.name, m.id, m.roles FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 AND m.status = 'active' ORDER BY o.name`,
      [userId],
    );
    return {
      id: u.id,
      displayName: u.display_name,
      memberships: m.rows.map((r) => ({
        organization: r.slug,
        organizationName: r.name,
        membershipId: r.id,
        roles: r.roles,
      })),
    };
  });
}
