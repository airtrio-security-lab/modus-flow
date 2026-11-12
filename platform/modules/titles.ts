import { z } from 'zod';
import { forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { CIVILIZATIONS, NEUTRAL_TITLE, civilization, type Civilization, type CivilizationId } from '../domain/civilizations.ts';
import { orgTx } from './context.ts';

/**
 * Game titles (ADR-0014, ADR-0020). Three independent properties of a person are shown together
 * but never mixed: the real job (directory), rights (roles) and the game title (here). A title is
 * a word with meaning for people; no rule in the system reads it, so it can never grant access.
 *
 * The words come from the civilization registry of the person's district; the title is chosen by
 * a real function or by the person, first match wins:
 *   0. the person switched game titles off → «Сотрудник»;
 *   1. assigned by an admin: Король (owner), Регент;
 *   2. head of a department → the head title of its civilization (Даймё, Хан, Лорд / Леди);
 *   3. named deputy by an admin → Каро, Султан, Сенешаль, Нойон;
 *   4. a guild title assigned by an admin to this person;
 *   5. maintainer or decision owner in the department → Самурай, Би, Рыцарь, Нойон;
 *   6. confirmed results (implemented as implementer, confirmed as executor) → Такуми, Шебер, Мастер гильдии, Дархан;
 *   7. the novice title, only if the person chose it (Оруженосец);
 *   8. the department's guild titles set by an admin → the junior one;
 *   9. the district's neutral title (Житель Камелота, Житель Орды…).
 * An honor (Батыр, Баатур) is shown next to it only when the person has confirmed achievements and
 * chose to show it.
 */
export type TitleSource = 'assigned' | 'castle_head' | 'guild_default' | 'civilization' | 'neutral' | 'choice';
export type TitleRank = 'king' | 'regent' | 'castle_head' | 'guild' | 'deputy' | 'authorized' | 'master' | 'novice' | 'member';
export interface EffectiveTitle {
  membershipId: string;
  title: string;
  rank: TitleRank;
  source: TitleSource;
  castle: string | null;
  /** Civilization of the person's district (picture and words only). */
  civilization: CivilizationId | null;
  /** Honorary title shown next to the main one, by the person's choice. */
  honor: string | null;
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const AssignTitleInput = z
  .object({ rank: z.enum(['king', 'regent', 'guild', 'deputy']), title: text(2, 60).optional() })
  .strict()
  .refine((v) => v.rank !== 'guild' || !!v.title, { message: 'Укажите гильдейское звание', path: ['title'] });
export const GuildTitlesInput = z.object({ titles: z.array(text(2, 60)).min(1).max(8) }).strict();
export const TitleChoicesInput = z
  .object({ neutral: z.boolean(), novice: z.boolean(), showHonor: z.boolean(), headForm: z.enum(['lord', 'lady']).nullable().default(null) })
  .strict();

export const RANK_TITLE = { king: 'Король', regent: 'Регент', deputy: 'Заместитель' } as const;

/** Camelot's head title takes the form the person chose for it (public on purpose); never guessed from a name. */
function headTitle(civ: Civilization, form: string | null) {
  if (civ.id !== 'camelot') return civ.titles.head;
  return form === 'lady' ? 'Леди' : form === 'lord' ? 'Лорд' : 'Лорд / Леди';
}

export async function effectiveTitles(c: Client): Promise<Map<string, EffectiveTitle>> {
  const { rows } = await c.query<{
    membership_id: string;
    department: string | null;
    roles: string[];
    assigned_rank: 'king' | 'regent' | 'guild' | 'deputy' | null;
    assigned_title: string | null;
    head_of: string | null;
    head_civ: string | null;
    guild: string[] | null;
    dept_name: string | null;
    dept_civ: string | null;
    address_form: string | null;
    neutral: boolean | null;
    novice: boolean | null;
    show_honor: boolean | null;
    results: number;
  }>(
    `SELECT e.membership_id, e.department, e.roles, g.rank AS assigned_rank, g.title AS assigned_title,
            h.name AS head_of, h.civilization AS head_civ,
            gt.titles AS guild, dd.name AS dept_name, dd.civilization AS dept_civ,
            tc.head_form AS address_form, tc.neutral, tc.novice, tc.show_honor,
            ((SELECT count(*) FROM idea_overview o WHERE o.implementer_membership_id = e.membership_id AND o.status = 'implemented')
             + (SELECT count(*) FROM executor_confirmations x WHERE x.candidate_membership_id = e.membership_id))::int AS results
       FROM employees e
       LEFT JOIN game_titles g ON g.membership_id = e.membership_id AND g.organization_id = app_org_id()
       LEFT JOIN LATERAL (SELECT d.name, d.civilization FROM departments d WHERE d.organization_id = app_org_id() AND d.active
                            AND d.head_membership_id = e.membership_id ORDER BY d.name LIMIT 1) h ON true
       LEFT JOIN departments dd ON dd.organization_id = app_org_id() AND dd.name = e.department AND dd.active
       LEFT JOIN guild_titles gt ON gt.department_id = dd.id AND gt.organization_id = app_org_id()
       LEFT JOIN title_choices tc ON tc.membership_id = e.membership_id AND tc.organization_id = app_org_id()
      WHERE e.organization_id = app_org_id() AND e.status = 'active' AND e.access = 'member'`,
  );
  const out = new Map<string, EffectiveTitle>();
  for (const r of rows) {
    const civId = r.head_civ ?? r.dept_civ;
    const civ = civId ? civilization(civId) : null;
    const castle = r.head_of ?? r.dept_name;
    const base = { membershipId: r.membership_id, castle, civilization: civ?.id ?? null };
    const honor = civ?.titles.honor && r.show_honor && r.results > 0 && !r.neutral ? civ.titles.honor : null;
    const make = (title: string, rank: TitleRank, source: TitleSource): EffectiveTitle => ({ ...base, title, rank, source, honor });
    let t: EffectiveTitle | null = null;
    if (r.neutral) t = { ...base, title: NEUTRAL_TITLE, rank: 'member', source: 'neutral', honor: null };
    else if (r.assigned_rank === 'king' || r.assigned_rank === 'regent') t = make(RANK_TITLE[r.assigned_rank], r.assigned_rank, 'assigned');
    else if (r.head_of && civ) t = make(headTitle(civ, r.address_form), 'castle_head', 'castle_head');
    else if (r.assigned_rank === 'deputy') t = make(civ?.titles.deputy ?? RANK_TITLE.deputy, 'deputy', 'assigned');
    else if (r.assigned_rank === 'guild') t = make(r.assigned_title!, 'guild', 'assigned');
    else if (civ && (r.roles.includes('maintainer') || r.roles.includes('decision_owner'))) t = make(civ.titles.authorized, 'authorized', 'civilization');
    else if (civ && r.results > 0) t = make(civ.titles.master, 'master', 'civilization');
    else if (civ?.titles.novice && r.novice) t = make(civ.titles.novice, 'novice', 'choice');
    else if (r.guild?.length) t = make(r.guild[r.guild.length - 1]!, 'guild', 'guild_default');
    else if (civ) t = make(civ.titles.member, 'member', 'civilization');
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
    const mine = (
      await c.query<{ neutral: boolean; novice: boolean; show_honor: boolean; head_form: 'lord' | 'lady' | null }>(
        'SELECT neutral, novice, show_honor, head_form FROM title_choices WHERE membership_id = app_membership_id()',
      )
    ).rows[0];
    return {
      titles,
      guilds: guilds.rows,
      registry: CIVILIZATIONS.map((x) => ({ id: x.id, name: x.name, hall: x.hall, titles: x.titles })),
      choices: { neutral: mine?.neutral ?? false, novice: mine?.novice ?? false, showHonor: mine?.show_honor ?? false, headForm: mine?.head_form ?? null },
      note: 'Игровое звание не даёт прав в системе: права задаются ролями.',
    };
  });
}

const isAdmin = (a: OrgActor) => a.access === 'member' && a.roles.includes('org_admin');

export async function assignTitle(db: Database, actor: OrgActor, membershipId: string, input: z.infer<typeof AssignTitleInput>) {
  if (!isAdmin(actor)) throw forbidden('Звания назначает администратор');
  return withTx(db, orgTx(actor), async (c) => {
    const m = await c.query('SELECT 1 FROM employees WHERE membership_id = $1 AND organization_id = app_org_id() AND status = $2', [membershipId, 'active']);
    if (!m.rowCount) throw notFound('Сотрудник не найден');
    // King and regent are unique: assigning moves the title to the new person.
    if (input.rank === 'king' || input.rank === 'regent') await c.query('DELETE FROM game_titles WHERE organization_id = app_org_id() AND rank = $1 AND membership_id <> $2', [input.rank, membershipId]);
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

/** The person's own choices: a neutral title, the novice title, showing an earned honor. */
export async function saveTitleChoices(db: Database, actor: OrgActor, input: z.infer<typeof TitleChoicesInput>) {
  if (actor.access !== 'member') throw forbidden('Звания выбирают сотрудники организации');
  return withTx(db, orgTx(actor), async (c) => {
    await c.query(
      `INSERT INTO title_choices (organization_id, membership_id, neutral, novice, show_honor, head_form) VALUES (app_org_id(), app_membership_id(), $1, $2, $3, $4)
       ON CONFLICT (organization_id, membership_id) DO UPDATE
         SET neutral = EXCLUDED.neutral, novice = EXCLUDED.novice, show_honor = EXCLUDED.show_honor, head_form = EXCLUDED.head_form, updated_at = clock_timestamp()`,
      [input.neutral, input.novice, input.showHonor, input.headForm],
    );
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'title.choices_saved', entityType: 'membership', entityId: actor.membershipId, data: { ...input } });
    return (await effectiveTitles(c)).get(actor.membershipId) ?? null;
  });
}
