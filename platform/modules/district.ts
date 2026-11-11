import { z } from 'zod';
import { AppError, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { CIVILIZATION_IDS, civilizationName } from '../domain/civilizations.ts';
import { levelFor } from '../domain/progress.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';
import { castle as castleDetail, castleProgress, loadConfig } from './progress.ts';
import { effectiveTitles } from './titles.ts';

/**
 * The district of a department and the working card of a person (owner brief 2026-11-11, ADR-0019).
 * Read-only views over existing facts — items, decisions, XP awards, questionnaires, meetings and
 * knowledge — under the caller's row-level security. The game picture adds no business state.
 *
 * Privacy of questionnaires (0008): skills and declared weekly hours are visible to the person
 * and to leads; preferences only to the person. Unknown figures are «нет данных» (null), never 0.
 */

const fullMember = (a: OrgActor) => {
  if (a.access !== 'member') throw forbidden('Город и карточки сотрудников доступны сотрудникам организации');
};
const isLead = (a: OrgActor) => a.roles.some((r) => r === 'maintainer' || r === 'decision_owner' || r === 'org_admin');
const OPEN = `o.status NOT IN ('implemented', 'rejected', 'closed')`;

async function department(c: Client, id: string) {
  const d = (
    await c.query<{ id: string; name: string; civilization: string; head: string | null; headcount: number | null }>(
      `SELECT id, name, civilization, head_membership_id AS head, headcount FROM departments WHERE id = $1 AND organization_id = app_org_id() AND active`,
      [id],
    )
  ).rows[0];
  if (!d) throw notFound('Подразделение не найдено');
  return d;
}

/** Facts about people: open work, confirmed results. Items are readable by every full member (0002), so counts reveal nothing new. */
async function peopleFacts(c: Client, ids: string[]) {
  const { rows } = await c.query<{ m: string; assigned: number; leading: number; implemented: number; ideas: number; effects: number; confirmed: number }>(
    `SELECT m,
            (SELECT count(*)::int FROM idea_overview o WHERE o.implementer_membership_id = m AND o.status = 'in_progress') AS assigned,
            (SELECT count(*)::int FROM idea_overview o WHERE o.maintainer_membership_id = m AND ${OPEN}) AS leading,
            (SELECT count(*)::int FROM idea_overview o WHERE o.implementer_membership_id = m AND o.status = 'implemented') AS implemented,
            (SELECT count(*)::int FROM idea_overview o WHERE coalesce(o.raised_by_membership_id, o.author_membership_id) = m AND o.status = 'implemented') AS ideas,
            (SELECT count(*)::int FROM idea_overview o JOIN effect_approvals e ON e.idea_id = o.id WHERE coalesce(o.raised_by_membership_id, o.author_membership_id) = m) AS effects,
            (SELECT count(*)::int FROM executor_confirmations x WHERE x.candidate_membership_id = m) AS confirmed
       FROM unnest($1::uuid[]) AS m`,
    [ids],
  );
  return new Map(rows.map((r) => [r.m, r]));
}

/** Questionnaires the caller may read (RLS: own and, for leads, everyone's). Preferences are never returned here. */
async function skills(c: Client, ids: string[]) {
  const { rows } = await c.query<{ membership_id: string; skills: string[]; weekly_hours: number | null }>(
    'SELECT membership_id, skills, weekly_hours FROM employee_profiles WHERE membership_id = ANY ($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((r) => [r.membership_id, r]));
}

export async function district(db: Database, actor: OrgActor, id: string) {
  fullMember(actor);
  const dev = await castleDetail(db, actor, id);
  return withTx(db, orgTx(actor), async (c) => {
    const d = await department(c, id);
    const cfg = await loadConfig(c);
    const prog = (await castleProgress(c)).get(id);
    const lv = levelFor(prog?.xp ?? 0, cfg);
    const ranks = (
      await c.query<{ id: string; xp: number }>(
        `SELECT d.id, coalesce(sum(a.xp), 0)::int AS xp FROM departments d LEFT JOIN xp_awards a ON a.department_id = d.id
          WHERE d.organization_id = app_org_id() AND d.active GROUP BY d.id ORDER BY xp DESC`,
      )
    ).rows;
    const rank = 1 + ranks.filter((r) => r.xp > (prog?.xp ?? 0)).length;

    const people = (
      await c.query<{ id: string; name: string; job: string | null; roles: string[] }>(
        `SELECT membership_id AS id, display_name AS name, job_title AS job, roles FROM employees
          WHERE organization_id = app_org_id() AND department = $1 AND status = 'active' AND access = 'member' ORDER BY display_name`,
        [d.name],
      )
    ).rows;
    const ids = people.map((p) => p.id);
    const facts = await peopleFacts(c, ids);
    const profiles = await skills(c, ids);
    const titles = await effectiveTitles(c);
    const lead = isLead(actor);
    const staff = people.map((p) => {
      const f = facts.get(p.id)!;
      const pr = profiles.get(p.id);
      const mayRead = lead || p.id === actor.membershipId;
      const command = p.id === d.head || p.roles.includes('maintainer') || p.roles.includes('decision_owner');
      const specialist = !command && (f.implemented > 0 || f.confirmed > 0);
      return {
        membershipId: p.id,
        name: p.name,
        jobTitle: p.job,
        title: titles.get(p.id)?.title ?? null,
        group: command ? 'command' : specialist ? 'specialist' : 'member',
        isHead: p.id === d.head,
        // Questionnaire: self-declared, visible to the person and to leads.
        questionnaire: mayRead ? (pr ? 'filled' : 'empty') : 'hidden',
        specialization: mayRead ? (pr?.skills[0] ?? null) : null,
        skills: mayRead ? (pr?.skills ?? null) : null,
        capacityHours: mayRead ? (pr?.weekly_hours ?? null) : null,
        // Hours per task are not recorded, so the load is unknown — «нет данных», not zero.
        loadHours: null,
        activeTasks: f.assigned + f.leading,
        assigned: f.assigned,
        leading: f.leading,
        achievements: { implemented: f.implemented, ideasImplemented: f.ideas, effectsConfirmed: f.effects, confirmedAsExecutor: f.confirmed },
      };
    });

    const items = (
      await c.query<{
        number: number; title: string; kind: string; status: string; stage: string; author: string; maintainer: string | null;
        implementer: string | null; decision_owner: string | null; due: Date | null; overdue: boolean; stale: boolean; published_at: Date;
        maintainer_id: string | null; decision_owner_id: string | null; implementer_id: string | null;
      }>(
        `SELECT o.number, o.title, o.kind, o.status, o.stage, coalesce(o.raised_by, o.author) AS author, o.maintainer, o.implementer, o.decision_owner,
                coalesce(o.resolution_due_at, o.first_response_due_at) AS due, (o.overdue_first_response OR o.overdue_resolution) AS overdue, o.stale, o.published_at,
                o.maintainer_membership_id AS maintainer_id, o.decision_owner_membership_id AS decision_owner_id, o.implementer_membership_id AS implementer_id
           FROM idea_overview o WHERE o.organization_id = app_org_id() AND o.department_id = $1 ORDER BY o.published_at DESC LIMIT 300`,
        [id],
      )
    ).rows;
    const item = (r: (typeof items)[number]) => ({
      number: r.number, title: r.title, kind: r.kind, status: r.status, author: r.author, maintainer: r.maintainer, implementer: r.implementer,
      decisionOwner: r.decision_owner, due: r.due?.toISOString() ?? null, overdue: r.overdue, stale: r.stale, publishedAt: r.published_at.toISOString(),
    });
    const open = items.filter((r) => !['implemented', 'rejected', 'closed'].includes(r.status));

    // Meetings: participants only (0009) — others see nothing, not even titles.
    const meetings = (
      await c.query<{ id: string; title: string; at: Date; cancelled: boolean; idea: number | null }>(
        `SELECT m.id, m.title, coalesce(m.scheduled_at, m.created_at) AS at, m.cancelled_at IS NOT NULL AS cancelled, i.number AS idea
           FROM meetings m LEFT JOIN ideas i ON i.id = m.idea_id
          WHERE m.organization_id = app_org_id() AND (m.department_id = $1 OR i.department_id = $1) ORDER BY at DESC LIMIT 30`,
        [id],
      )
    ).rows;
    const decisions = (
      await c.query<{ number: number; title: string; outcome: string; by: string; at: Date }>(
        `SELECT o.number, o.title, d.outcome, e.display_name AS by, d.created_at AS at
           FROM decisions d JOIN idea_overview o ON o.id = d.idea_id JOIN employees e ON e.membership_id = d.decided_by_membership_id
          WHERE o.department_id = $1 ORDER BY d.created_at DESC LIMIT 20`,
        [id],
      )
    ).rows;
    const council = (
      await c.query<{ number: number; title: string; entries: number }>(
        `SELECT o.number, o.title, (SELECT count(*)::int FROM council_entries ce WHERE ce.idea_id = o.id) AS entries
           FROM idea_overview o WHERE o.department_id = $1 AND ${OPEN} AND o.status IN ('in_review', 'decision', 'in_verification', 'needs_info') ORDER BY o.published_at`,
        [id],
      )
    ).rows;
    const legacy = (
      await c.query<{ id: string; title: string; level: string; status: string; kind: string }>(
        `SELECT DISTINCT k.id, k.title, k.level, k.status, k.kind FROM knowledge_items k
           JOIN knowledge_sources s ON s.knowledge_id = k.id AND s.source_type = 'idea' JOIN ideas i ON i.id = s.source_id
          WHERE i.department_id = $1`,
        [id],
      )
    ).rows;
    const history = (await c.query<{ at: Date; from_civ: string; to_civ: string; actor: string | null }>('SELECT * FROM app_civilization_history($1)', [id])).rows;
    // Same order as the city map (by name), so the district keeps its heraldic colour.
    const colorIndex = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM departments WHERE organization_id = app_org_id() AND active AND name < $1`, [d.name])).rows[0]!.n;
    const headName = people.find((p) => p.id === d.head)?.name ?? (d.head ? (await c.query<{ n: string }>('SELECT display_name AS n FROM employees WHERE membership_id = $1', [d.head])).rows[0]?.n : null) ?? null;

    return {
      id: d.id,
      name: d.name,
      civilization: { id: d.civilization, name: civilizationName(d.civilization) },
      colorIndex,
      head: d.head ? { membershipId: d.head, name: headName, title: titles.get(d.head)?.title ?? null } : null,
      canChooseCivilization: d.head === actor.membershipId || actor.roles.includes('org_admin'),
      level: lv.level,
      levelName: lv.name,
      xp: prog?.xp ?? 0,
      levelFloor: lv.floor,
      nextLevelXp: lv.next,
      nextLevelName: lv.nextName,
      progress: lv.progress,
      levels: { thresholds: cfg.thresholds, names: cfg.names },
      rank,
      of: ranks.length,
      people: staff.length,
      activeTasks: items.filter((r) => r.status === 'in_progress').length,
      inReview: items.filter((r) => ['unrouted', 'in_review', 'needs_info', 'decision', 'in_verification'].includes(r.status)).length,
      implemented: items.filter((r) => r.status === 'implemented').length,
      lastAchievements: dev.achievements.filter((a) => a.earnedAt).sort((a, b) => b.earnedAt!.localeCompare(a.earnedAt!)).slice(0, 3),
      staff,
      needs: {
        vacancies: null,
        missingSkills: null,
        capacityShortage: null,
        note: 'Вакансии и требуемые компетенции в системе не ведутся, нехватка ёмкости не подтверждается — поэтому «нет данных».',
      },
      tasks: open.map(item),
      initiatives: items.map(item),
      council: { open: council, decisions: decisions.map((x) => ({ ...x, at: x.at.toISOString() })), meetings: meetings.map((m) => ({ ...m, at: m.at.toISOString() })) },
      legacy,
      development: { history: dev.history, achievements: dev.achievements, civilizationHistory: history.map((h) => ({ at: h.at.toISOString(), from: civilizationName(h.from_civ), to: civilizationName(h.to_civ), actor: h.actor })) },
      // Items where the caller may name an implementer (existing rule: maintainer or decision owner, after «внедрять»).
      assignable: items
        .filter((r) => r.stage === 'adoption' && (r.maintainer_id === actor.membershipId || r.decision_owner_id === actor.membershipId))
        .map((r) => ({ number: r.number, title: r.title, implementerId: r.implementer_id })),
      canCallCouncil: isLead(actor),
    };
  });
}

export const CivilizationInput = z.object({ civilization: z.enum(CIVILIZATION_IDS) }).strict();
export async function setCivilization(db: Database, actor: OrgActor, id: string, civ: string) {
  fullMember(actor);
  return withTx(db, orgTx(actor), async (c) => {
    try {
      const { rows } = await c.query<{ civ: string }>('SELECT app_set_civilization($1, $2) AS civ', [id, civ]);
      return { civilization: { id: rows[0]!.civ, name: civilizationName(rows[0]!.civ) } };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '42501') throw new AppError('forbidden', 'Стиль района выбирает глава подразделения или администратор');
      if (err.code === '23514') throw new AppError('validation_failed', 'Такой цивилизации нет в каталоге');
      throw e;
    }
  });
}

/** The working card of a person. Own preferences only for the person; skills and hours for the person and leads. */
export async function person(db: Database, actor: OrgActor, membershipId: string) {
  fullMember(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const p = (
      await c.query<{ id: string; name: string; job: string | null; department: string | null; roles: string[] }>(
        `SELECT membership_id AS id, display_name AS name, job_title AS job, department, roles FROM employees
          WHERE organization_id = app_org_id() AND membership_id = $1 AND status = 'active' AND access = 'member'`,
        [membershipId],
      )
    ).rows[0];
    if (!p) throw notFound('Сотрудник не найден');
    const self = p.id === actor.membershipId;
    const mayRead = self || isLead(actor);
    const prof = (
      await c.query<{ skills: string[]; preferences: string | null; weekly_hours: number | null }>(
        'SELECT skills, preferences, weekly_hours FROM employee_profiles WHERE membership_id = $1',
        [p.id],
      )
    ).rows[0];
    const dept = p.department ? (await c.query<{ id: string }>('SELECT id FROM departments WHERE organization_id = app_org_id() AND name = $1', [p.department])).rows[0] : undefined;
    const titles = await effectiveTitles(c);
    const f = (await peopleFacts(c, [p.id])).get(p.id)!;
    const list = async (where: string) =>
      (
        await c.query<{ number: number; title: string; status: string; due: Date | null; overdue: boolean }>(
          `SELECT o.number, o.title, o.status, coalesce(o.resolution_due_at, o.first_response_due_at) AS due, (o.overdue_first_response OR o.overdue_resolution) AS overdue
             FROM idea_overview o WHERE o.organization_id = app_org_id() AND ${where} ORDER BY o.published_at DESC LIMIT 50`,
          [p.id],
        )
      ).rows.map((r) => ({ number: r.number, title: r.title, status: r.status, due: r.due?.toISOString() ?? null, overdue: r.overdue }));
    const results = (
      await c.query<{ number: number; title: string; role: string; xp: number }>(
        `SELECT o.number, o.title, CASE WHEN o.implementer_membership_id = $1 THEN 'исполнитель' ELSE 'автор идеи' END AS role,
                (SELECT coalesce(sum(a.xp), 0)::int FROM xp_awards a WHERE a.idea_id = o.id) AS xp
           FROM idea_overview o WHERE o.status = 'implemented' AND (o.implementer_membership_id = $1 OR coalesce(o.raised_by_membership_id, o.author_membership_id) = $1)
          ORDER BY o.updated_at DESC LIMIT 30`,
        [p.id],
      )
    ).rows;
    return {
      membershipId: p.id,
      name: p.name,
      jobTitle: p.job,
      department: p.department ? { id: dept?.id ?? null, name: p.department } : null,
      title: titles.get(p.id)?.title ?? null,
      self,
      questionnaire: mayRead ? (prof ? 'filled' : 'empty') : 'hidden',
      skills: mayRead ? (prof?.skills ?? null) : null,
      weeklyHours: mayRead ? (prof?.weekly_hours ?? null) : null,
      preferences: self ? (prof?.preferences ?? null) : null,
      loadHours: null,
      tasks: await list(`((o.implementer_membership_id = $1 AND o.status = 'in_progress') OR (o.maintainer_membership_id = $1 AND ${OPEN}))`),
      initiatives: await list(`coalesce(o.raised_by_membership_id, o.author_membership_id) = $1`),
      results,
      achievements: { implemented: f.implemented, ideasImplemented: f.ideas, effectsConfirmed: f.effects, confirmedAsExecutor: f.confirmed },
    };
  });
}
