import { z } from 'zod';
import { forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';

/**
 * Game titles (ADR-0014). Four separate things are shown together but never mixed:
 * job title (directory), rights (roles), game title (here) and the castle's
 * achievements (XP). A title is decoration with meaning for people; no rule in
 * the system reads it, so it can never grant access.
 *
 * Effective title, first match wins:
 *   1. assigned by an admin: Король (owner), Регент (deputy) or a guild title;
 *   2. head of a department → «Глава замка «<department>»»;
 *   3. member of a department with guild titles → the department's junior title;
 *   4. none.
 */
export type TitleSource = 'assigned' | 'castle_head' | 'guild_default';
export interface EffectiveTitle {
  membershipId: string;
  title: string;
  rank: 'king' | 'regent' | 'castle_head' | 'guild';
  source: TitleSource;
  castle: string | null;
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const AssignTitleInput = z
  .object({ rank: z.enum(['king', 'regent', 'guild']), title: text(2, 60).optional() })
  .strict()
  .refine((v) => v.rank !== 'guild' || !!v.title, { message: 'Укажите гильдейское звание', path: ['title'] });
export const GuildTitlesInput = z.object({ titles: z.array(text(2, 60)).min(1).max(8) }).strict();

export const RANK_TITLE = { king: 'Король', regent: 'Регент' } as const;

export async function effectiveTitles(c: Client): Promise<Map<string, EffectiveTitle>> {
  const { rows } = await c.query<{
    membership_id: string;
    department: string | null;
    assigned_rank: 'king' | 'regent' | 'guild' | null;
    assigned_title: string | null;
    head_of: string | null;
    guild: string[] | null;
    dept_name: string | null;
  }>(
    `SELECT e.membership_id, e.department, g.rank AS assigned_rank, g.title AS assigned_title,
            (SELECT d.name FROM departments d WHERE d.organization_id = app_org_id() AND d.active
                AND d.head_membership_id = e.membership_id ORDER BY d.name LIMIT 1) AS head_of,
            gt.titles AS guild, dd.name AS dept_name
       FROM employees e
       LEFT JOIN game_titles g ON g.membership_id = e.membership_id AND g.organization_id = app_org_id()
       LEFT JOIN departments dd ON dd.organization_id = app_org_id() AND dd.name = e.department
       LEFT JOIN guild_titles gt ON gt.department_id = dd.id AND gt.organization_id = app_org_id()
      WHERE e.organization_id = app_org_id() AND e.status = 'active' AND e.access = 'member'`,
  );
  const out = new Map<string, EffectiveTitle>();
  for (const r of rows) {
    let t: EffectiveTitle | null = null;
    if (r.assigned_rank) {
      t = {
        membershipId: r.membership_id,
        title: r.assigned_rank === 'guild' ? r.assigned_title! : RANK_TITLE[r.assigned_rank],
        rank: r.assigned_rank,
        source: 'assigned',
        castle: r.head_of ?? r.dept_name,
      };
    } else if (r.head_of) {
      t = { membershipId: r.membership_id, title: `Глава замка «${r.head_of}»`, rank: 'castle_head', source: 'castle_head', castle: r.head_of };
    } else if (r.guild?.length) {
      t = { membershipId: r.membership_id, title: r.guild[r.guild.length - 1]!, rank: 'guild', source: 'guild_default', castle: r.dept_name };
    }
    if (t) out.set(r.membership_id, t);
  }
  return out;
}

export async function listTitles(db: Database, actor: OrgActor) {
  if (actor.access !== 'member') throw forbidden('Звания видят сотрудники организации');
  return withTx(db, orgTx(actor), async (c) => {
    const titles = [...(await effectiveTitles(c)).values()];
    const guilds = await c.query(
      `SELECT d.id AS "departmentId", d.name AS department, coalesce(g.titles, '{}') AS titles
         FROM departments d LEFT JOIN guild_titles g ON g.department_id = d.id AND g.organization_id = d.organization_id
        WHERE d.organization_id = app_org_id() AND d.active ORDER BY d.name`,
    );
    return { titles, guilds: guilds.rows, note: 'Игровое звание не даёт прав в системе: права задаются ролями.' };
  });
}

const isAdmin = (a: OrgActor) => a.access === 'member' && a.roles.includes('org_admin');

export async function assignTitle(db: Database, actor: OrgActor, membershipId: string, input: z.infer<typeof AssignTitleInput>) {
  if (!isAdmin(actor)) throw forbidden('Звания назначает администратор');
  return withTx(db, orgTx(actor), async (c) => {
    const m = await c.query('SELECT 1 FROM employees WHERE membership_id = $1 AND organization_id = app_org_id() AND status = $2', [membershipId, 'active']);
    if (!m.rowCount) throw notFound('Сотрудник не найден');
    // King and regent are unique: assigning moves the title to the new person.
    if (input.rank !== 'guild') await c.query('DELETE FROM game_titles WHERE organization_id = app_org_id() AND rank = $1 AND membership_id <> $2', [input.rank, membershipId]);
    await c.query(
      `INSERT INTO game_titles (organization_id, membership_id, rank, title, assigned_by_membership_id)
       VALUES (app_org_id(), $1, $2, $3, app_membership_id())
       ON CONFLICT (organization_id, membership_id) DO UPDATE
         SET rank = EXCLUDED.rank, title = EXCLUDED.title, assigned_by_membership_id = EXCLUDED.assigned_by_membership_id, updated_at = clock_timestamp()`,
      [membershipId, input.rank, input.rank === 'guild' ? input.title : RANK_TITLE[input.rank]],
    );
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'title.assigned', entityType: 'membership', entityId: membershipId, data: { rank: input.rank } });
    return (await effectiveTitles(c)).get(membershipId) ?? null;
  });
}

export async function clearTitle(db: Database, actor: OrgActor, membershipId: string) {
  if (!isAdmin(actor)) throw forbidden('Звания назначает администратор');
  return withTx(db, orgTx(actor), async (c) => {
    await c.query('DELETE FROM game_titles WHERE organization_id = app_org_id() AND membership_id = $1', [membershipId]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'title.cleared', entityType: 'membership', entityId: membershipId, data: {} });
    return (await effectiveTitles(c)).get(membershipId) ?? null;
  });
}

export async function setGuildTitles(db: Database, actor: OrgActor, departmentId: string, input: z.infer<typeof GuildTitlesInput>) {
  if (!isAdmin(actor)) throw forbidden('Гильдейские звания настраивает администратор');
  return withTx(db, orgTx(actor), async (c) => {
    const d = await c.query('SELECT 1 FROM departments WHERE id = $1 AND organization_id = app_org_id()', [departmentId]);
    if (!d.rowCount) throw notFound('Подразделение не найдено');
    await c.query(
      `INSERT INTO guild_titles (organization_id, department_id, titles) VALUES (app_org_id(), $1, $2)
       ON CONFLICT (organization_id, department_id) DO UPDATE SET titles = EXCLUDED.titles, updated_at = clock_timestamp()`,
      [departmentId, input.titles],
    );
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'title.guild_set', entityType: 'department', entityId: departmentId, data: { count: input.titles.length } });
    return { departmentId, titles: input.titles };
  });
}
